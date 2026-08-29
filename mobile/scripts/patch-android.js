#!/usr/bin/env node
'use strict';
// Idempotently patch the Capacitor-generated android/ project with the native assist layer:
// copy the Java + res/xml sources, add permissions + the assist services to the manifest.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'android', 'app', 'src', 'main');
if (!fs.existsSync(APP)) { console.error('android/ not found — run `npx cap add android` first.'); process.exit(1); }

const javaDst = path.join(APP, 'java', 'com', 'asmltr', 'assistant');
fs.mkdirSync(javaDst, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'native', 'java'))) {
  fs.copyFileSync(path.join(ROOT, 'native', 'java', f), path.join(javaDst, f));
}
// Copy every res subdir we ship (xml, values, mipmap-* launcher icons, …) over the generated project.
const resSrc = path.join(ROOT, 'native', 'res');
for (const sub of fs.readdirSync(resSrc)) {
  const from = path.join(resSrc, sub); if (!fs.statSync(from).isDirectory()) continue;
  const to = path.join(APP, 'res', sub); fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
}

const mf = path.join(APP, 'AndroidManifest.xml');
let x = fs.readFileSync(mf, 'utf8');
const perms = ['android.permission.RECORD_AUDIO', 'android.permission.INTERNET', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.REQUEST_INSTALL_PACKAGES',
  // persistent floating overlay (survives swipe-home) + its foreground service
  'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  // full app visibility so the assistant can find/launch ANY installed app by name (this IS a device
  // controller; the <queries> below covers launcher apps, this guarantees the rest).
  'android.permission.QUERY_ALL_PACKAGES',
  // persistent device-control link: restart on boot, post its ongoing notification, stay alive in Doze
  'android.permission.RECEIVE_BOOT_COMPLETED', 'android.permission.POST_NOTIFICATIONS', 'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  // keep the CPU/mic/audio running with the screen off during a listening/processing session
  'android.permission.WAKE_LOCK',
  // Capture from a Bluetooth headset mic. WITHOUT BLUETOOTH_CONNECT, Chromium's media stack refuses to
  // touch the BT adapter at all ("cr_media: BLUETOOTH_CONNECT permission is missing") and every
  // getUserMedia binds to the phone's built-in mic no matter which communication device we nominate.
  'android.permission.BLUETOOTH_CONNECT'];
let permXml = perms.filter((p) => !x.includes(p)).map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
if (permXml) x = x.replace(/<application/, permXml + '\n\n    <application');

// Package visibility (Android 11+/API 30): without this, queryIntentActivities only returns a few
// always-visible apps — so "launch facebook" can't see facebook. Declaring the MAIN/LAUNCHER + web-VIEW
// intents makes every launchable app (and browsers) visible to the device-control tools.
const queries = `
    <queries>
        <intent>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" />
        </intent>
    </queries>
`;
if (!x.includes('<queries>')) x = x.replace(/<application/, queries + '\n    <application');

const services = `
        <service android:name=".AsmltrVoiceInteractionService"
            android:permission="android.permission.BIND_VOICE_INTERACTION" android:exported="true">
            <intent-filter><action android:name="android.service.voice.VoiceInteractionService" /></intent-filter>
            <meta-data android:name="android.voice_interaction" android:resource="@xml/interaction_service" />
        </service>
        <service android:name=".AsmltrSessionService"
            android:permission="android.permission.BIND_VOICE_INTERACTION" android:exported="true" />
        <service android:name=".AsmltrRecognitionService"
            android:permission="android.permission.BIND_VOICE_RECOGNITION" android:exported="true">
            <intent-filter><action android:name="android.speech.RecognitionService" /></intent-filter>
            <meta-data android:name="android.speech" android:resource="@xml/recognition_service" />
        </service>
`;
if (!x.includes('AsmltrVoiceInteractionService')) x = x.replace(/<\/application>/, services + '    </application>');

// FileProvider for the auto-update installer — separate guard (independent of the assist services, so
// it still applies when android/ already has them from a prior build).
const provider = `
        <provider android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.updateprovider" android:exported="false" android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths" />
        </provider>
`;
if (!x.includes('updateprovider')) x = x.replace(/<\/application>/, provider + '    </application>');
// PackageInstaller session status receiver (launches the system install-confirm dialog).
const receiver = '\n        <receiver android:name=".InstallReceiver" android:exported="false" />\n';
if (!x.includes('InstallReceiver')) x = x.replace(/<\/application>/, receiver + '    </application>');

// The persistent-overlay foreground service (draws the assistant over other apps, survives swipe-home).
const overlaySvc = `
        <service android:name=".OverlayService"
            android:exported="false" android:foregroundServiceType="specialUse">
            <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="assistant_overlay" />
        </service>
`;
if (!x.includes('.OverlayService')) x = x.replace(/<\/application>/, overlaySvc + '    </application>');

// The always-on device-control link (persistent foreground service) + a boot receiver to restart it.
const controlSvc = `
        <service android:name=".DeviceControlService"
            android:exported="false" android:foregroundServiceType="specialUse">
            <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="device_control_link" />
        </service>
        <receiver android:name=".BootReceiver" android:exported="true">
            <intent-filter><action android:name="android.intent.action.BOOT_COMPLETED" /></intent-filter>
        </receiver>
`;
if (!x.includes('.DeviceControlService')) x = x.replace(/<\/application>/, controlSvc + '    </application>');

// Phase 2: the accessibility service (on-screen control: gestures, read screen, screenshots). The user
// must enable it in Settings → Accessibility; it's inert until then.
const a11ySvc = `
        <service android:name=".AsmltrAccessibilityService"
            android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE" android:exported="true" android:label="@string/app_name">
            <intent-filter><action android:name="android.accessibilityservice.AccessibilityService" /></intent-filter>
            <meta-data android:name="android.accessibilityservice" android:resource="@xml/accessibility_service" />
        </service>
`;
if (!x.includes('.AsmltrAccessibilityService')) x = x.replace(/<\/application>/, a11ySvc + '    </application>');

// Notification reader (Part B): a NotificationListenerService reads incoming phone notifications aloud
// over BT (AI synopsis + prioritization via the core). Inert until the user grants Notification access
// in system settings. BIND_NOTIFICATION_LISTENER_SERVICE is declared on the service (granted by consent).
const notifSvc = `
        <service android:name=".AsmltrNotificationService"
            android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE" android:exported="true" android:label="@string/app_name">
            <intent-filter><action android:name="android.service.notification.NotificationListenerService" /></intent-filter>
        </service>
`;
if (!x.includes('.AsmltrNotificationService')) x = x.replace(/<\/application>/, notifSvc + '    </application>');

// Headset/wired assistant-button entry point. The BT button fires an ACTIVITY intent (VOICE_COMMAND/
// ASSIST/hands-free voice search) — separate from the power-button assist role — so we need an activity
// registered for it or asmltr never appears in the "Complete action using" chooser.
const assistAct = `
        <activity android:name=".AssistActivity" android:exported="true" android:excludeFromRecents="true"
            android:launchMode="singleInstance" android:theme="@android:style/Theme.Translucent.NoTitleBar">
            <intent-filter>
                <action android:name="android.intent.action.ASSIST" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VOICE_COMMAND" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.speech.action.VOICE_SEARCH_HANDS_FREE" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>
`;
if (!x.includes('.AssistActivity')) x = x.replace(/<\/application>/, assistAct + '    </application>');
fs.writeFileSync(mf, x);

// --- versioning (drives auto-update): versionName from package.json, versionCode = M*10000+m*100+p ---
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const vName = pkg.version || '0.0.0';
const mm = vName.split('.').map((n) => parseInt(n, 10) || 0);
const vCode = mm[0] * 10000 + mm[1] * 100 + (mm[2] || 0);
const gradle = path.join(ROOT, 'android', 'app', 'build.gradle');
let g = fs.readFileSync(gradle, 'utf8');
g = g.replace(/versionCode\s+\d+/, 'versionCode ' + vCode).replace(/versionName\s+"[^"]*"/, 'versionName "' + vName + '"');
// androidx.webkit for WebView WebAuthn (passkeys inside the app).
if (!g.includes('androidx.webkit:webkit')) g = g.replace(/dependencies\s*\{/, 'dependencies {\n    implementation "androidx.webkit:webkit:1.12.1"');
// Vosk offline wake-word engine — the phrase is a runtime grammar string (no per-phrase model), and the
// ~40MB model is downloaded once to the phone. Fully configurable in Settings, offline, no external site.
// Pin >= 0.3.70: earlier builds (0.3.47) shipped libvosk.so with 4 KB-aligned LOAD segments, which fails
// the 16 KB page-size check on Android 15+ devices. Rewrite an existing pin so a stale project is upgraded.
const VOSK = 'com.alphacephei:vosk-android:0.3.75';
if (!g.includes('vosk-android')) g = g.replace(/dependencies\s*\{/, 'dependencies {\n    implementation "' + VOSK + '"');
else g = g.replace(/com\.alphacephei:vosk-android:[0-9.]+/g, VOSK);

// 16 KB page-size support. Native libs must be STORED uncompressed so the loader can map them straight
// out of the APK; the packaging step then aligns each .so on a 16 KB boundary (scripts/package-apk.sh).
// Uncompressed JNI libs require minSdk >= 23, which is why variables.gradle is bumped below.
if (!g.includes('useLegacyPackaging')) {
  g = g.replace(/buildTypes\s*\{/, 'packaging {\n        jniLibs {\n            useLegacyPackaging false\n        }\n    }\n    buildTypes {');
}
fs.writeFileSync(gradle, g);

// minSdk 23 — required for uncompressed JNI libs (see above). `cap add android` scaffolds 22.
const varsFile = path.join(ROOT, 'android', 'variables.gradle');
try {
  let v = fs.readFileSync(varsFile, 'utf8');
  const bumped = v.replace(/minSdkVersion\s*=\s*(\d+)/, (m, n) => (parseInt(n, 10) < 23 ? 'minSdkVersion = 23' : m));
  if (bumped !== v) fs.writeFileSync(varsFile, bumped);
} catch (_) { /* variables.gradle absent on older Capacitor scaffolds */ }
// Sidecar the connector's /gw/app reads to report the served version.
fs.writeFileSync(path.join(ROOT, 'app-version.json'), JSON.stringify({ versionCode: vCode, versionName: vName }) + '\n');
console.log('patched: java, res/xml, permissions, assist services + version', vName, '(' + vCode + ') →', mf);
