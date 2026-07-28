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
echo "==> cap sync";   npx cap sync android
echo "==> patch native assist layer"; node scripts/patch-android.js
echo "==> gradle assembleDebug (no daemon, 1 worker, Xmx1024m)"
cd android
nice -n 19 ionice -c3 ./gradlew --no-daemon --max-workers=1 assembleDebug
APK="app/build/outputs/apk/debug/app-debug.apk"
echo "==> APK: $(pwd)/$APK"
ls -lh "$APK"
