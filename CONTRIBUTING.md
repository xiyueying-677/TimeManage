# 贡献指南

感谢关注 TimeManage！欢迎提交 Issue 和 Pull Request。

## 开始之前

- 错别字、文档修正这类小改动，可以直接提 PR。
- 较大的功能或行为变更，建议先开 Issue 讨论，避免方向不一致导致白做。

## 开发环境

- Node.js 22+
- Rust（stable）
- Windows：Visual Studio C++ 生成工具、WebView2 Runtime
- Android（可选）：JDK 17、Android SDK 36、NDK、`aarch64-linux-android` target、adb

## 本地运行与测试

```bash
npm install
npm run dev              # 开发模式

npm test                 # 前端纯函数单测
cd src-tauri && cargo test --lib   # Rust 单测
```

提交前 `npm test` 与 `cargo test --lib` 都必须通过。

## 代码约定

1. 前端保持**无框架、无打包器**：原生 HTML / CSS / ES Module。
2. **后端是唯一写入方**：前端不要整份写数据，所有改动走 `store.actions.*` → 后端 `invoke` → 持久化 → `emit("data:changed")` → 各窗口重新加载。
3. **持 store 锁时不要调用窗口方法**（`show` / `set_position` 会触发事件回调再次加锁，导致同线程死锁）。先读数据、释放锁，再操作窗口。
4. 新增 Rust 命令必须在 `src-tauri/src/lib.rs` 的 `generate_handler!` 里注册；新增窗口要同时加进 `tauri.conf.json` 与 `capabilities/default.json`。
5. 数据模型改动要写迁移，并保持导入 / 同步的**按 id 合并、只增不删**语义；`ui` 字段不参与导入 / 同步。
6. Android 相关：**不要删除** `src-tauri/tauri.js` 与 `src-tauri/gen/android/gradle.properties` 中的 `kotlin.incremental=false`，详见 [docs/android-build.md](docs/android-build.md)。
7. 不要提交 `data/`、`backup/`、构建产物或任何个人数据（`.gitignore` 已覆盖）。

## 提交信息

采用简化版 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```text
feat: 新增倒计时重复提醒
fix: 修复冷启动时内容区空白
docs: 补充 Android 构建说明
refactor: 拆分统计页扁平化逻辑
test: 补充日历纯函数用例
chore: 更新依赖
```

一次提交只做一件事；正文可用中文或英文，说明「做了什么、为什么」。

## Pull Request

- 说明动机、改动点和验证方式；
- UI 改动请附截图（注意脱敏）；
- 关联相关 Issue；
- 保持 diff 聚焦，不夹带无关格式化改动。

## 安全问题

请勿在公开 Issue 中披露漏洞细节，报告方式见 [SECURITY.md](SECURITY.md)。
