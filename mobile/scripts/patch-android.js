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
const xmlDst = path.join(APP, 'res', 'xml');
fs.mkdirSync(xmlDst, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'native', 'res', 'xml'))) {
  fs.copyFileSync(path.join(ROOT, 'native', 'res', 'xml', f), path.join(xmlDst, f));
}

const mf = path.join(APP, 'AndroidManifest.xml');
let x = fs.readFileSync(mf, 'utf8');
const perms = ['android.permission.RECORD_AUDIO', 'android.permission.INTERNET', 'android.permission.MODIFY_AUDIO_SETTINGS'];
let permXml = perms.filter((p) => !x.includes(p)).map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
if (permXml) x = x.replace(/<application/, permXml + '\n\n    <application');

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
fs.writeFileSync(mf, x);
console.log('patched: java, res/xml, permissions, assist services →', mf);
