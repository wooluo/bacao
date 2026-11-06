#!/bin/bash
# 工资拔草机 · 一键重建安卓 APK（同步前端 + Gradle 构建）
# 自带工具链校验：强制使用 tools/ 内的 JDK 21，清掉旧 daemon，不受系统 Java/环境变量干扰。
set -e
cd "$(dirname "$0")"
export JAVA_HOME="$PWD/../tools/amazon-corretto-21.jdk/Contents/Home"
export ANDROID_HOME="$PWD/../tools/android-sdk"

# 1) 工具链自检：JDK 必须 ≥ 21（Capacitor 7.4 要求），SDK 目录必须存在
if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "✗ 缺少 JDK 21（$JAVA_HOME），请先按 README 安装到 tools/" && exit 1
fi
JAVA_MAJOR=$("$JAVA_HOME/bin/java" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')
if [ "${JAVA_MAJOR:-0}" -lt 21 ]; then
  echo "✗ JDK 版本过低（$JAVA_MAJOR < 21），请使用 tools/amazon-corretto-21" && exit 1
fi
if [ ! -d "$ANDROID_HOME" ]; then echo "✗ 缺少 Android SDK（tools/android-sdk）" && exit 1; fi

echo "▸ JDK:  $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"

# 2) 同步前端到 www 并交给 Capacitor
mkdir -p www && cp -R ../static/* www/
npm install --no-audit --no-fund
npx cap sync android

# 3) 清理可能携带旧 JDK 的 Gradle daemon，强制本次构建的 JVM 与 JAVA_HOME 一致
(cd android && ./gradlew --stop > /dev/null 2>&1 || true)
(cd android && ./gradlew -Dorg.gradle.java.home="$JAVA_HOME" assembleDebug)
cp android/app/build/outputs/apk/debug/app-debug.apk ./工资拔草机-debug.apk

# 4) 正式签名版（keystore.properties 存在时）
if [ -f keystore.properties ]; then
  (cd android && ./gradlew -Dorg.gradle.java.home="$JAVA_HOME" assembleRelease)
  cp android/app/build/outputs/apk/release/app-release.apk ./工资拔草机.apk
  echo "✓ 正式版：$(pwd)/工资拔草机.apk"
fi
echo "✓ 调试版：$(pwd)/工资拔草机-debug.apk"
