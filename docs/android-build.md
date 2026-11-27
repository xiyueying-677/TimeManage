# Android 构建说明

本文记录 `src-tauri/gen/android`（tauri android 生成的工程）与本地插件 `src-tauri/plugins/timer-notification` 的构建方式、必须保留的修复和常见坑。

## 环境要求

- JDK 17
- Android SDK（compileSdk / targetSdk 36）、NDK
- Rust target `aarch64-linux-android`
- Node.js + 已执行 `npm install`

## 构建与安装

```powershell
# debug APK（首次或改 Rust / Kotlin 后）
$env:CARGO_NET_OFFLINE='true'
node_modules\.bin\tauri.cmd android build --debug --apk --target aarch64

# 安装到已连接手机
adb install -r "src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk"
adb shell am start -n com.timemanage.desktop/.MainActivity
```

- 产物：`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- 包名 `com.timemanage.desktop`，minSdk 24，ABI `arm64-v8a`，入口 `com.timemanage.desktop.MainActivity`。
- 增量构建通常约 75 秒；首次构建或改动 Kotlin 插件后可能需要数分钟。

## 必须保留的构建修复

### 1. `src-tauri/tauri.js` 转发 shim

tauri-cli 会在 `src-tauri` 目录执行 `node tauri android android-studio-script`，但项目内没有名为 `tauri` 的模块。该 shim 只有两行，转发到 `node_modules/@tauri-apps/cli/tauri.js`。

**删除它会导致 `:app:rustBuildArm64Debug` 报 `Cannot find module '...\src-tauri\tauri'`。** `tauri android init` 会重写 `BuildTask.kt`，但不会删除该 shim，因此重新 init 后仍然有效。

### 2. `src-tauri/gen/android/gradle.properties` 保留 `kotlin.incremental=false`

Tauri 的 Kotlin 源码位于 `%USERPROFILE%\.cargo\registry\...`，与工程可能不在同一磁盘，跨盘增量缓存无法换算相对路径，会抛 `this and base files have different roots`。该文件「仅当不存在才生成」，手工追加后可长期保留。

### 3. `src-tauri/gen/android/app/build.gradle.kts` 的 `usesCleartextTraffic=true`

局域网同步使用明文 HTTP，debug / release 的 `manifestPlaceholder` 都设为 `true`。**仅限可信局域网，不要做公网端口映射。**

### 4. Gradle 发行包的预置（网络慢时可选）

若下载 `services.gradle.org` 很慢，可把同版本完整发行包放到本机 Gradle 缓存目录（`%USERPROFILE%\.gradle\wrapper\dists\<gradle-版本>-bin\<hash>\`），并用 MD5 校验一致。升级 Gradle 时同步修改 `src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl`。

## 首次启动空白问题

**症状**：冷启动时侧栏可见、内容区空白、导航无响应；控制台报 `Uncaught (in promise) .../js/main.js undefined`。

**根因**：boot 阶段首次 `store.loadData()` 在 Tauri IPC 尚未就绪时瞬态失败，异常中断了后续 mount。

**修复（已包含在代码中）**：

- `src/js/main.js`：`loadInitialData()` 最多重试 30 次、每次间隔 100ms，并加 `showBootError(err)`；启动链改为 `boot().catch(showBootError)`。
- 悬浮番茄钟 / 倒计时 / 提醒窗：`src/js/store.js` 提供 `loadDataWithRetry()`，分别应用到 `float.js`、`countdown-float.js`、`alert.js`。

若再出现空白页，先看 CDP console 是否有 `BOOT_FAILED` 或 `state not managed`，再检查 `.content` 是否被注入了错误卡片。

## 常见坑

- **CDP 端口**：桌面调试用 9222，手机用 9223；`adb forward tcp:9222` 指到手机会让人误把手机页面当成桌面窗口。
- **APK 体积**：debug 包约 306 MiB，原因是 `packaging { jniLibs.keepDebugSymbols }` 保留了未 strip 的 Rust `.so`；正式分发应使用 release 构建并 strip。
- **签名**：当前 debug APK 使用 `CN=Android Debug` 签名，不能用于正式分发；上架或长期分发需要自有 keystore 的 release 签名。
- **同步网络**：手机作主机时，电脑端填手机热点的网关地址；电脑作主机时，手机端填电脑的局域网 IP。Windows 防火墙需放行专用网络与 18923 端口。
- **明文 HTTP**：只适合同一可信 Wi-Fi / 热点，不要暴露到公网。
