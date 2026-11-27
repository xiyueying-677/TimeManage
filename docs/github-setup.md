# GitHub 发布清单

推送前/后的操作清单。仓库与标签已在本机准备好，剩下的是远端设置。

## 1. 创建仓库

在 GitHub 新建空仓库 `TimeManage`，**不要**勾选「Add a README / .gitignore / license」，本地已经有这些内容。仓库应与下面地址一致：

`https://github.com/xiyueying-677/TimeManage`

如需改名，记得同步修改 `package.json`、`src-tauri/Cargo.toml` 及 README / 文档里的链接。

## 2. 推送

```bash
git remote -v                 # 应显示 origin 指向 github.com/xiyueying-677/TimeManage
git push -u origin main
git push origin v0.1.0        # 推送标签，触发 Release workflow
```

推送 `v0.1.0` 标签后，`Release` workflow 会在 Windows runner 上构建 `TimeManage.exe` 并自动创建 Release；确认产物后再编辑说明、标记为 latest。

## 3. 仓库基本设置

- **Description**：`番茄钟 + 倒计时日历，Windows 桌面与 Android，本地数据、局域网同步`
- **Topics**：`tauri` `pomodoro` `timer` `countdown` `windows` `android` `rust` `vanilla-js`
- **Social preview**：上传 1280×640 图片（可用 `docs/images/desktop-pomodoro.png` 裁剪）
- **Default branch**：`main`
- **Features**：保留 Issues；Discussions、Projects、Wiki 按需关闭

## 4. 分支保护 / Rulesets

对 `main` 建议：

- Require status checks：`CI / Frontend tests`、`CI / Rust lib tests (Windows)`
- Require a pull request（单人维护可暂时关闭）
- 禁止 force push 与删除分支

## 5. 安全设置

- Settings → Code security：开启 **Dependabot alerts**、**Dependabot security updates**、**Secret scanning**（公开仓库免费）
- 开启 **Private vulnerability reporting**，让 `SECURITY.md` 里的 Security Advisories 链接可用

## 6. Release 检查

- [ ] 标签推送后 `Release` workflow 成功
- [ ] Release 附件 `TimeManage.exe` 可下载并运行
- [ ] Release notes 由 `generate_release_notes` 生成，必要时补充
- [ ] 标记为 latest，`CHANGELOG.md` 中的链接可访问

## 7. 说明

- 仓库单文件最大 707KB，无需 Git LFS；已忽略 `dist/`、`backup/`、`data/` 与构建产物。
- exe 未做代码签名，Windows SmartScreen 可能提示「未知发布者」；如需消除，需要另外购买代码签名证书。
- 本次不发布 APK；如需发布 Android，请先按 [android-build.md](android-build.md) 做 release 签名，再补 Release 附件。
