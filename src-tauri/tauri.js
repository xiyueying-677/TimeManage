// src-tauri/tauri.js — 构建用转发 shim，不属于应用源码。
//
// 原因：tauri-cli 2.11.4 生成的 src-tauri/gen/android/buildSrc/.../BuildTask.kt 里
//   executable("node")，args = ["tauri", "android", "android-studio-script", ...]
//   workingDir = src-tauri
// 因此 `node tauri ...` 必须在 src-tauri 下能解析到一个名为 tauri 的模块。
// 真正的 npm CLI 入口在 node_modules/@tauri-apps/cli/tauri.js，这里转发过去。
// 同类问题见 tauri-apps/tauri#13892。
//
// 注意：`tauri android init` 会重写 BuildTask.kt，但不会删除本文件，所以修复对 re-init 免疫。
// 上游修好后可安全删除本文件。
import '../node_modules/@tauri-apps/cli/tauri.js';
