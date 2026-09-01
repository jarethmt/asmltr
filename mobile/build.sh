#!/usr/bin/env bash
# Build the debug APK. Resource-limited so it can't starve a small host (Gradle daemon off, capped heap,
# single worker, niced). Run on a box with the Android SDK + JDK 17/21. Produces android/app/build/outputs/apk/debug/app-debug.apk
set -euo pipefail
cd "$(dirname "$0")"

export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export GRADLE_OPTS="-Dorg.gradle.daemon=false -Dorg.gradle.workers.max=1 -Dorg.gradle.jvmargs=-Xmx1024m"

echo "==> npm install"; npm install --no-audit --no-fund
if [ ! -d android ]; then echo "==> cap add android"; npx cap add android; fi
# Vendor shared browser modules into www BEFORE cap sync copies them into the APK. www/shared/ is a
# build artifact and gitignored — a committed copy is exactly the drift the shared tree prevents.
echo "==> vendor shared modules into www"
mkdir -p www/shared && cp ../shared/rtc/viewer.js www/shared/rtc-viewer.js

echo "==> cap sync";   npx cap sync android
echo "==> theme launcher icon from identity palette"; node scripts/gen-icon.js || true
echo "==> patch native assist layer"; node scripts/patch-android.js
# `./build.sh release` produces a signed, 16 KB-aligned release APK at dist/asmltr.apk (what the
# connector serves). Release needs a keystore — it MUST be the same one previous releases used, or the
# update cannot install over an existing app and users lose their data. Anything else builds debug.
MODE="${1:-debug}"

if [ "$MODE" = "release" ]; then
  : "${ASMLTR_ANDROID_KEYSTORE:?release builds need ASMLTR_ANDROID_KEYSTORE (same key as previous releases)}"
  echo "==> gradle assembleRelease (no daemon, 1 worker, Xmx1024m)"
  cd android
  nice -n 19 ionice -c3 ./gradlew --no-daemon --max-workers=1 assembleRelease
  APK="app/build/outputs/apk/release/app-release-unsigned.apk"
else
  echo "==> gradle assembleDebug (no daemon, 1 worker, Xmx1024m)"
  cd android
  nice -n 19 ionice -c3 ./gradlew --no-daemon --max-workers=1 assembleDebug
  APK="app/build/outputs/apk/debug/app-debug.apk"
fi
echo "==> APK: $(pwd)/$APK"
ls -lh "$APK"
# Assert the built APK's version matches package.json — so a stale/cached APK can never masquerade as new.
WANT="$(node -e "console.log(require('../package.json').version)")"
AAPT="$(ls "$ANDROID_SDK_ROOT"/build-tools/*/aapt 2>/dev/null | tail -1)"
if [ -n "$AAPT" ]; then
  GOT="$("$AAPT" dump badging "$APK" 2>/dev/null | sed -n "s/.*versionName='\([^']*\)'.*/\1/p" | head -1)"
  echo "==> APK versionName=$GOT (want $WANT)"
  [ "$GOT" = "$WANT" ] || { echo "FATAL: built APK is $GOT, expected $WANT — build did not produce the new binary"; exit 3; }
fi

if [ "$MODE" = "release" ]; then
  # 16 KB-align then sign. Alignment must precede signing — zipalign rewrites offsets and would
  # invalidate the signature. Needs build-tools >= 35.0.1 for zipalign's -P flag.
  mkdir -p ../dist
  ../scripts/package-apk.sh "$APK" ../dist/asmltr.apk
  echo "==> release APK: $(cd .. && pwd)/dist/asmltr.apk"
fi
