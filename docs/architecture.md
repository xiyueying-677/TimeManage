# 架构说明

TimeManage 是「番茄钟 + 倒计时日历」跨平台应用：Windows 桌面（Tauri v2 + WebView2）与 Android（Tauri v2 + 系统 WebView）。数据全部保存在本机，可导出 / 导入，并支持同一局域网内双向同步。

## 技术栈

- **Tauri v2**：Rust 后端 + 系统 WebView。
- 前端：原生 HTML / CSS / ES Module，**无前端框架、无打包器**。
- `tauri.conf.json` 开启 `withGlobalTauri`，前端通过 `window.__TAURI__` 调用后端。
- release 产物约 4.2 MB（含 `tauri-plugin-single-instance`）。

## 运行、构建与测试

```bash
npm install                 # 仅安装 @tauri-apps/cli

cd src-tauri && cargo build # 开发构建
cargo build --release       # 发布构建

npm test                    # node --test，前端纯函数单测（stats / calendar）
cargo test --lib            # Rust 计时引擎、同步与存储单测

npm run tauri build         # 仅当需要 MSI / NSIS 安装包时使用
```

> ⚠️ 前端资源在编译期嵌入可执行文件：改动任何 JS / CSS 后必须重新 `cargo build` 才生效（`tauri dev` 除外）。

Android 构建见 [android-build.md](android-build.md)。

## 目录结构

```text
src/                        前端（Tauri frontendDist）
  index.html                主窗口
  float.html                番茄钟悬浮窗
  countdown-float.html      倒计时悬浮窗
  alert.html                计时结束的置顶提醒窗
  css/                      theme.css（变量/通用） main.css float.css alert.css mobile.css
  js/
    tauri.js                __TAURI__ 封装：invoke/listen/currentWindow/setWindowSize/startResizeDragging
    store.js                数据加载 / 订阅 / 同步 + 所有写操作 actions.*
    timerClient.js          计时命令封装 timer.* + 事件订阅
    stats.js / calendar.js  纯函数（有单测）
    utils.js modal.js audio.js
    main.js                 主窗口：导航 + 各视图挂载 + 全局事件
    view-pomodoro.js        番茄钟页（事件配置卡、模式切换）
    view-stats.js           统计页（图表 / 分类表 / 记录明细分组分页 + 批量 / 跳到日期）
    view-calendar.js        倒计时日历页
    view-settings.js        设置页（全局默认 + 事件自定义 + 数据导入导出 + 局域网同步）
    float.js                番茄钟悬浮窗
    countdown-float.js      倒计时悬浮窗
    alert.js                置顶提醒窗
    floatShell.js           悬浮窗公共外壳（拖动 / 缩放 / 折叠 / 贴边收缩 / 位置记忆）
    notifications.js        通知动作 → 计时命令
src-tauri/
  src/lib.rs                命令注册、后台 tick 线程、窗口事件
  src/timer.rs              计时引擎（状态机）
  src/storage.rs            数据读写（原子写）、有效设置解析
  src/countdown.rs          倒计时到期检查
  src/tray.rs               托盘菜单、悬浮窗显隐 / 位置持久化
  src/sync.rs               局域网同步（主机 HTTP、客户端、配对码、配置）
  tauri.conf.json           窗口定义、bundle、withGlobalTauri
  capabilities/default.json 权限（窗口 / 事件）
  plugins/timer-notification/  Android 前台服务通知插件（Kotlin + Rust）
  gen/android/              tauri android 生成的 Android 工程
src/assets/icon-source.png  图标源图
```

## 数据模型 `data/app-data.json`

```jsonc
{
  "schemaVersion": 2,
  "settings": {              // 全局默认
    "studyMinutes": 25, "breakMinutes": 5, "cycles": 4,
    "extendStudyMinutes": 5, "extendBreakMinutes": 1,
    "autoStartNext": false, "soundEnabled": true, "soundVolume": 0.5
  },
  "categories": [            // 固定四大类，事件可增删
    { "id": "study", "name": "学习", "icon": "📚", "color": "#ff9fb2", "events": [{ "id": "e_example", "name": "示例事件" }] },
    { "id": "fun",   "name": "娱乐", "icon": "🎮", "color": "#9fc7ff", "events": [] },
    { "id": "life",  "name": "生活", "icon": "🏠", "color": "#a8e6c9", "events": [] },
    { "id": "other", "name": "其他", "icon": "🗂️", "color": "#b8c2d0", "events": [] }
  ],
  "eventConfigs": {          // 每个事件的计时覆盖，键 "大类|事件"
    "fun|e_game": { "studyMinutes": 45, "breakMinutes": 10 }
  },
  "sessions": [{             // 统计唯一数据源（计时器仅自动写入 study；休息不再自动记录）
    "id": "uuid", "kind": "study|break",   // break 仅可能来自手动补录
    "categoryId": "study", "eventId": "e_example",
    "startedAt": 0, "endedAt": 0,
    "plannedSeconds": 1500, "focusedSeconds": 1500,
    "pausedSeconds": 0, "extendedSeconds": 0, "extendedCount": 0,
    "completed": true
  }],
  "countdowns": [{
    "id": "c1", "title": "考试", "date": "2026-06-07",
    "recurring": "none|yearly", "color": "#6fa8ff",
    "note": "", "remindDaysBefore": 0, "lastNotifiedOn": null
  }],
  "ui": {
    "pomodoro": { "categoryId": "study", "eventId": "e_example", "mode": "pomodoro", "countdownMinutes": 25 },
    "pomodoroFloat": { "visible": false, "collapsed": false, "dock": null, "panel": false, "x": null, "y": null, "cx": null, "cy": null, "w": null, "h": null },
    "countdownFloat": { /* 同上 */ }
  }
}
```

- **有效设置** = `settings` 叠加 `eventConfigs["大类|事件"]`（后端 `Store::effective_settings` 实现）。
- **schema v2 增量字段**：`sessions` / `countdowns` / events 带 `updatedAt`；新增 `syncMeta.settingsUpdatedAt` 与 `syncMeta.eventConfigUpdatedAt`；`ui` 是设备本地状态，**永不参与导入 / 同步**。
- 导入与同步都按 `id` 合并，**只增不删**；设置与事件配置按键合并，并保留本机独有的键。

## 核心接口

### Rust 命令（`invoke('名', { 参数 })`，参数用 camelCase）

- **数据**：`load_data` `update_settings{settings}` `set_selection{categoryId,eventId,mode,countdownMinutes}` `add_event{categoryId,name}→id` `delete_event{categoryId,eventId}` `save_countdown{countdown}` `delete_countdown{id}` `save_session{session}` `delete_session{id}` `save_sessions{sessions}` `delete_sessions{ids}` `set_event_config{categoryId,eventId,patch}` `clear_event_config{categoryId,eventId}` `import_data`（按 id 合并）`export_data` `get_data_dir` `open_data_dir`
- **同步**：`sync_info` `sync_apply{config}` `sync_stop` `sync_regenerate_token` `sync_now`；配置存本机 `sync-config.json`，不参与导出 / 同步；主机默认端口 18923，`/v1/ping` 与 `/v1/sync` 需 `X-Sync-Token` 6 位配对码。
- **计时**：`start_timer{categoryId,eventId,mode,countdownMinutes}` `pause_timer` `resume_timer` `extend_study` `extend_break` `end_phase_early` `start_break` `next_study` `stop_timer` `timer_state`；`mode` 取 `"pomodoro" | "countup" | "countdown"`。
- **窗口**：`set_float_visible{label,visible}` `toggle_float{label}` `set_float_ui{label,patch}` `show_main` `set_main_on_top{on}` `show_alert` `hide_alert`

### Tauri 事件

`timer:tick`(state) · `timer:finished`(payload) · `countdown:due`(列表) · `float:changed` · `data:changed`

### 前端封装

- `store.js`：`loadData() / getData() / subscribe(fn) / initDataSync()`；写操作走 `store.actions.*`；`effectiveSettings(catId,evId)`、`hasEventConfig(catId,evId)`
- `timerClient.js`：`timer.*`（同计时命令）+ `onTick / onFinished / onCountdownDue / onFloatChanged`
- `floatShell.js`：`createFloatShell({label})` → `{ collapse, expand, applyInitial(ui), noteSize(w,h), setUi(patch), isCollapsed() }`
- `stats.js`：`rangeBounds / rangeLabel / shiftRef / summarize / aggregate / breakdown / seriesByGroup / filterByRange` 等纯函数
- `calendar.js`：`nextOccurrence / daysUntil / occursOn / monthMatrix / sortUpcoming` 等纯函数

## 关键代码约定

1. **后端是唯一写入方**：JS 绝不整份写数据（`save_data` 已移除）。所有改动走 `store.actions.*` → 后端改内存并 `persist()` → `emit("data:changed")` → 各窗口 `loadData()` 重渲染。
2. **持 store 锁时禁止调用窗口方法**。`win.show()/set_position()` 会同步触发 `Moved` 事件，事件处理器再去锁 store，同一线程会自死锁（曾导致「点悬挂番茄钟卡死」）。正确做法：先读数据、释放锁、再操作窗口。
3. 全局 Window API **没有 `currentMonitor`**；屏幕边界用 `window.screen.availLeft / availWidth` 等乘以 `scaleFactor()`。
4. 悬浮窗必须 `resizable: true`（否则 `setSize` 失效），并设 `maximizable / minimizable: false`；折叠态在 `onResized` 中强制回到 62×62，防止 Aero Snap 放大。
5. 折叠图标拖动用 `win.startDragging()`（需权限 `core:window:allow-start-dragging`）；贴边判定阈值 26px、露出细条 14px。
6. 图标：在项目根运行 `npx tauri icon src/assets/icon-source.png` 后重新编译；桌面快捷方式图标指向 `src-tauri/icons/app-v2.ico`（换文件名以绕过 Windows 图标缓存）。
7. 新增命令必须在 `lib.rs` 的 `generate_handler!` 注册；新增窗口要同时加进 `tauri.conf.json` 与 `capabilities/default.json` 的 `windows` 列表。

## 计时引擎 `timer.rs`

- `Mode{ Pomodoro, CountUp, CountDown }`、`Phase{ Idle, Study, Break }`。
- 后台线程每 200ms tick，按秒广播；用 `deadline: Instant` 计算剩余（防漂移）；countup 用 `phase_start_ms` 算 `elapsed`。
- 暂停不计时（`paused_ms` 累加）；延长累计到 `extended / extended_count`。
- 阶段自然结束 → `pending=true`，等前端选择 `start_break / next_study / extend_study / stop`；countup 无 pending，结束即记录。
- `extend_study` 累计超过 `extendStudySeconds` 时返回 `warn: true`（前端提示「应该休息了」但仍可继续）。
- 结束提醒：`timer:finished` 且非 `autoNext`、非 countup 时，由**主窗口 JS** 调 `show_alert`（后台线程直接调窗口方法不生效）。
- **仅学习阶段写入记录**：`lib.rs` 用 `is_recordable()` 过滤，`start_break / next_study / flush_session / 自动下一阶段` 产生的休息会话一律丢弃（休息计时本身不受影响）。

## 功能概览

- **番茄钟**：三种模式（番茄钟 / 正计时 / 倒计时）；四大类（学习 / 娱乐 / 生活 / 其他）+ 自定义事件；每个事件独立记忆计时配置；暂停 / 延长 / 提前结束；延长超默认值提醒；结束置顶提醒窗 + 提示音（音量可调）。
- **统计**：顶部按大类分卡显示时长 / 次数 / 延长；日 / 周 / 月 / 年 / 总计 + 跳到日期；大分类 / 小分类切换；按分类堆叠趋势图；记录明细按日 / 月 / 年分组、分页（每页 10 条），可编辑 / 删除 / 补录，支持批量操作；不含休息统计。
- **倒计时日历**：添加 / 编辑 / 删除、每年重复、日历显示剩余天数、到期与提前提醒。
- **悬浮窗**：番茄钟（置顶）与倒计时（不置顶）均可完整操作，支持右下角缩放、折叠为透明小圆图标、拖到屏幕左右边缘自动收缩成细条（悬停滑出 / 移开缩回）、位置与尺寸记忆。
- **其他**：系统托盘、数据导入导出（按 id 合并）、便携数据目录、单实例（重复启动聚焦已有窗口）。

## 运行注意事项

- 数据目录：桌面版为可执行文件同目录下的 `data/`；不可写时回退 `%APPDATA%\TimeManage\data`；可用环境变量 `TIMEMANAGE_DATA_DIR` 覆盖。
- Android 数据：`/data/user/0/com.timemanage.desktop/` 下的应用私有目录；调试版可用 `adb shell run-as` 读取，普通用户通过设置页 SAF 导入 / 导出。
- 已启用单实例（`tauri-plugin-single-instance`）。
- `import_data` 与同步均为按 id 合并，不会覆盖或删除本机已有记录。
- 局域网同步为**明文 HTTP**，只限可信 Wi-Fi / 热点；电脑作主机时需在防火墙放行专用网络与 18923 端口。
- 图标源图 `src/assets/icon-source.png` 由渲染 🍅 表情生成，非脚本产出。
