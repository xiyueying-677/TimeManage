mod countdown;
mod storage;
mod sync;
mod timer;
#[cfg(desktop)]
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "android")]
use std::io::Write;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_timer_notification::{FinishedPayload, TimerPayload};

#[cfg(target_os = "android")]
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "android")]
use tauri_plugin_fs::{FsExt, OpenOptions};

use storage::Store;
use timer::{Engine, Phase};

pub struct AppState {
    pub store: Mutex<Store>,
    pub engine: Mutex<Engine>,
}

enum NotifyCommand {
    Update(TimerPayload),
    Stop,
    Finished(FinishedPayload),
}

static LAST_POS_SAVE: AtomicU64 = AtomicU64::new(0);
static SNAPSHOT_PATH: OnceLock<PathBuf> = OnceLock::new();
static NOTIFY_TX: OnceLock<mpsc::Sender<NotifyCommand>> = OnceLock::new();

fn init_notification_worker() {
    let (tx, rx) = mpsc::channel::<NotifyCommand>();
    if NOTIFY_TX.set(tx).is_err() {
        return;
    }
    std::thread::spawn(move || {
        while let Ok(command) = rx.recv() {
            match command {
                NotifyCommand::Update(payload) => tauri_plugin_timer_notification::update(payload),
                NotifyCommand::Stop => tauri_plugin_timer_notification::stop(),
                NotifyCommand::Finished(payload) => {
                    tauri_plugin_timer_notification::finished(payload)
                }
            }
        }
    });
}

fn send_notify(command: NotifyCommand) {
    if let Some(tx) = NOTIFY_TX.get() {
        let _ = tx.send(command);
    }
}

fn persist_timer_snapshot(app: &AppHandle) {
    let Some(path) = SNAPSHOT_PATH.get() else {
        return;
    };
    let snapshot = {
        let state = app.state::<AppState>();
        let engine = state.engine.lock().unwrap();
        engine.snapshot()
    };
    if snapshot.get("phase").and_then(|v| v.as_str()) == Some("idle") {
        let _ = std::fs::remove_file(path);
        return;
    }
    let tmp = path.with_extension("json.tmp");
    if let Ok(text) = serde_json::to_string_pretty(&snapshot) {
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

fn notification_sig(state: &Value) -> String {
    let paused = state["paused"].as_bool().unwrap_or(false);
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}",
        state["phase"],
        state["pending"],
        state["cycleIndex"],
        state["mode"],
        paused,
        state["endAt"],
        if paused { state["remaining"].clone() } else { json!(0) },
        state["categoryId"],
        state["eventId"],
    )
}

fn notification_texts(app: &AppHandle, state: &Value) -> (String, String, bool) {
    let phase = state["phase"].as_str().unwrap_or("study");
    let mode = state["mode"].as_str().unwrap_or("pomodoro");
    let category_id = state["categoryId"].as_str();
    let event_id = state["eventId"].as_str();

    let (category_name, event_name, sound_enabled) = {
        let app_state = app.state::<AppState>();
        let store = app_state.store.lock().unwrap();
        let categories = store
            .data
            .get("categories")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let category = category_id.and_then(|id| {
            categories
                .iter()
                .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(id))
        });
        let category_name = category
            .and_then(|c| c.get("name"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let event_name = category
            .and_then(|c| c.get("events"))
            .and_then(|v| v.as_array())
            .and_then(|events| {
                event_id.and_then(|id| {
                    events
                        .iter()
                        .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(id))
                })
            })
            .and_then(|e| e.get("name"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        (
            category_name,
            event_name,
            store.settings_bool("soundEnabled", true),
        )
    };

    let title = if phase == "break" {
        "休息一下".to_string()
    } else if let Some(category) = category_name {
        match event_name {
            Some(event) if !event.is_empty() => format!("{} · {}", category, event),
            _ => category,
        }
    } else {
        "专注计时".to_string()
    };

    let text = if phase == "break" {
        "休息计时中".to_string()
    } else if mode == "countup" {
        "正计时".to_string()
    } else if mode == "countdown" {
        "倒计时".to_string()
    } else {
        let cycle_index = state["cycleIndex"].as_i64().unwrap_or(0);
        let cycles = state["cycles"].as_i64().unwrap_or(1).max(1);
        format!("第 {}/{} 轮", (cycle_index + 1).min(cycles), cycles)
    };

    (title, text, sound_enabled)
}

#[cfg(target_os = "android")]
fn sync_notification(app: &AppHandle, state: &Value) {
    let phase = state["phase"].as_str().unwrap_or("idle");
    if phase == "idle" || state["pending"].as_bool().unwrap_or(false) {
        send_notify(NotifyCommand::Stop);
        return;
    }
    let (title, text, sound_enabled) = notification_texts(app, state);
    send_notify(NotifyCommand::Update(TimerPayload {
        title,
        text,
        mode: state["mode"].as_str().unwrap_or("pomodoro").to_string(),
        end_at: state["endAt"].as_i64().unwrap_or(0),
        elapsed_seconds: state["elapsedSeconds"].as_i64().unwrap_or(0),
        paused: state["paused"].as_bool().unwrap_or(false),
        remaining_seconds: state["remaining"].as_i64().unwrap_or(0),
        sound_enabled,
    }));
}

#[cfg(not(target_os = "android"))]
fn sync_notification(_app: &AppHandle, _state: &Value) {}

fn notify_finished(app: &AppHandle, payload: &Value) {
    #[cfg(target_os = "android")]
    {
        let sound_enabled = {
            let app_state = app.state::<AppState>();
            let store = app_state.store.lock().unwrap();
            store.settings_bool("soundEnabled", true)
        };
        let (title, text) = if payload["kind"].as_str() == Some("study") {
            ("学习时间到啦！", "辛苦啦，起来活动一下～")
        } else {
            ("休息结束～", "准备好开始下一轮了吗？")
        };
        send_notify(NotifyCommand::Finished(FinishedPayload {
            title: title.to_string(),
            text: text.to_string(),
            sound_enabled,
        }));
    }
    #[cfg(not(target_os = "android"))]
    let _ = (app, payload);
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn is_recordable(session: &Value) -> bool {
    session.get("kind").and_then(|v| v.as_str()) == Some("study")
}

fn should_save_pos() -> bool {
    let now = now_millis();
    let last = LAST_POS_SAVE.load(Ordering::Relaxed);
    if now.saturating_sub(last) >= 1000 {
        LAST_POS_SAVE.store(now, Ordering::Relaxed);
        true
    } else {
        false
    }
}

#[tauri::command]
fn load_data(state: State<AppState>) -> Value {
    state.store.lock().unwrap().data.clone()
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: State<AppState>,
    settings: Value,
) -> Result<(), String> {
    {
        let mut store = state.store.lock().unwrap();
        let mut merged = store.data.get("settings").cloned().unwrap_or_else(|| json!({}));
        if let (Some(target), Some(patch)) = (merged.as_object_mut(), settings.as_object()) {
            for (key, value) in patch {
                target.insert(key.clone(), value.clone());
            }
        }
        if let Some(obj) = store.data.as_object_mut() {
            obj.insert("settings".into(), merged);
        }
        storage::stamp_settings_updated(&mut store.data);
        store.persist()?;
    }
    let _ = app.emit("data:changed", ());
    Ok(())
}

#[tauri::command]
fn set_selection(
    app: AppHandle,
    state: State<AppState>,
    category_id: Option<String>,
    event_id: Option<String>,
    mode: Option<String>,
    countdown_minutes: Option<i64>,
) -> Result<(), String> {
    {
        let mut store = state.store.lock().unwrap();
        if let Some(ui) = store.data.get_mut("ui").and_then(|v| v.as_object_mut()) {
            ui.insert(
                "pomodoro".into(),
                json!({
                    "categoryId": category_id,
                    "eventId": event_id,
                    "mode": mode,
                    "countdownMinutes": countdown_minutes,
                }),
            );
        }
        store.persist()?;
    }
    let _ = app.emit("data:changed", ());
    Ok(())
}

#[tauri::command]
fn add_event(
    app: AppHandle,
    state: State<AppState>,
    category_id: String,
    name: String,
) -> Result<String, String> {
    let id = format!("ev_{}", uuid::Uuid::new_v4().simple());
    {
        let mut store = state.store.lock().unwrap();
        if let Some(cats) = store.data.get_mut("categories").and_then(|v| v.as_array_mut()) {
            if let Some(cat) = cats
                .iter_mut()
                .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(category_id.as_str()))
            {
                if let Some(obj) = cat.as_object_mut() {
                    let events = obj.entry("events").or_insert_with(|| json!([]));
                    if let Some(arr) = events.as_array_mut() {
                        let mut event = json!({ "id": id, "name": name });
                        storage::stamp_record(&mut event);
                        arr.push(event);
                    }
                }
            }
        }
        store.persist()?;
    }
    let _ = app.emit("data:changed", ());
    Ok(id)
}

#[tauri::command]
fn delete_event(
    app: AppHandle,
    state: State<AppState>,
    category_id: String,
    event_id: String,
) -> Result<(), String> {
    {
        let mut store = state.store.lock().unwrap();
        if let Some(cats) = store.data.get_mut("categories").and_then(|v| v.as_array_mut()) {
            if let Some(cat) = cats
                .iter_mut()
                .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(category_id.as_str()))
            {
                if let Some(events) = cat.get_mut("events").and_then(|v| v.as_array_mut()) {
                    events.retain(|e| {
                        e.get("id").and_then(|v| v.as_str()) != Some(event_id.as_str())
                    });
                }
            }
        }
        store.persist()?;
    }
    let _ = app.emit("data:changed", ());
    Ok(())
}

#[tauri::command]
fn save_countdown(
    app: AppHandle,
    state: State<AppState>,
    countdown: Value,
) -> Result<(), String> {
    let mut countdown = countdown;
    let id = countdown
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return Err("missing id".into());
    }
    storage::stamp_record(&mut countdown);
    {
        let mut store = state.store.lock().unwrap();
        let obj = store
            .data
            .as_object_mut()
            .ok_or_else(|| "invalid data".to_string())?;
        let arr = obj.entry("countdowns").or_insert_with(|| json!([]));
        if let Some(list) = arr.as_array_mut() {
            match list
                .iter()
                .position(|c| c.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
            {
                Some(pos) => list[pos] = countdown,
                None => list.push(countdown),
            }
        }
        store.persist()?;
    }
    let _ = app.emit("data:changed", ());
    Ok(())
}

#[tauri::command]
fn delete_countdown(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    {
        let mut store = state.store.lock().unwrap();
        if let Some(list) = store.data.get_mut("countdowns").and_then(|v| v.as_array_mut()) {
            list.retain(|c| c.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
        }
        store.persist()?;
    }
    let _ = app.emit("data:changed", ());
    Ok(())
}

#[tauri::command]
fn save_session(app: AppHandle, state: State<AppState>, session: Value) -> Result<(), String> {
    let mut session = session;
    let id = session
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return Err("missing id".into());
    }
    storage::stamp_record(&mut session);
    {
        let mut store = state.store.lock().unwrap();
        let obj = store
            .data
            .as_object_mut()
            .ok_or_else(|| "invalid data".to_string())?;
        let arr = obj.entry("sessions").or_insert_with(|| json!([]));
        if let Some(list) = arr.as_array_mut() {
            match list
                .iter()
                .position(|s| s.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
            {
                Some(pos) => list[pos] = session,
                None => list.push(session),
            }
        }
        store.persist()?;
    }
    let _ = app.emit("data:changed", ());
    Ok(())
}

#[tauri::command]
fn delete_session(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    {
        let mut store = state.store.lock().unwrap();
        if let Some(list) = store.data.get_mut("sessions").and_then(|v| v.as_array_mut()) {
            list.retain(|s| s.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
        }
        store.persist()?;
    }
    let _ = app.emit("data:changed", ());
    Ok(())
}

#[tauri::command]
fn delete_sessions(app: AppHandle, state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    {
        let mut store = state.store.lock().unwrap();
        if let Some(list) = store.data.get_mut("sessions").and_then(|v| v.as_array_mut()) {
            list.retain(|s| {
                let id = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
                !ids.iter().any(|x| x == id)
            });
        }
        store.persist()?;
    }
    let _ = app.emit("data:changed", ());
    Ok(())
}

#[tauri::command]
fn save_sessions(
    app: AppHandle,
    state: State<AppState>,
    sessions: Vec<Value>,
) -> Result<(), String> {
    if sessions.is_empty() {
        return Ok(());
    }
    {
        let mut store = state.store.lock().unwrap();
        let obj = store
            .data
            .as_object_mut()
            .ok_or_else(|| "invalid data".to_string())?;
        let arr = obj.entry("sessions").or_insert_with(|| json!([]));
        if let Some(list) = arr.as_array_mut() {
            for mut session in sessions {
                storage::stamp_record(&mut session);
                let id = session
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    continue;
                }
                match list
                    .iter()
                    .position(|s| s.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
                {
                    Some(pos) => list[pos] = session,
                    None => list.push(session),
                }
            }
        }
        store.persist()?;
    }
    let _ = app.emit("data:changed", ());
    Ok(())
}

#[tauri::command]
fn set_event_config(
    app: AppHandle,
    state: State<AppState>,
    category_id: String,
    event_id: String,
    patch: Value,
) -> Result<(), String> {
    let key = format!("{}|{}", category_id, event_id);
    {
        let mut store = state.store.lock().unwrap();
        {
            let obj = store
                .data
                .as_object_mut()
                .ok_or_else(|| "invalid data".to_string())?;
            let configs = obj.entry("eventConfigs").or_insert_with(|| json!({}));
            if let Some(map) = configs.as_object_mut() {
                let entry = map.entry(key.clone()).or_insert_with(|| json!({}));
                if let Some(cfg) = entry.as_object_mut() {
                    if let Some(patch) = patch.as_object() {
                        for (k, v) in patch {
                            cfg.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
        }
        storage::stamp_event_config_updated(&mut store.data, &key);
        store.persist()?;
    }
    let _ = app.emit("data:changed", ());
    Ok(())
}

#[tauri::command]
fn clear_event_config(
    app: AppHandle,
    state: State<AppState>,
    category_id: String,
    event_id: String,
) -> Result<(), String> {
    let key = format!("{}|{}", category_id, event_id);
    {
        let mut store = state.store.lock().unwrap();
        if let Some(map) = store
            .data
            .get_mut("eventConfigs")
            .and_then(|v| v.as_object_mut())
        {
            map.remove(&key);
        }
        if let Some(times) = store
            .data
            .get_mut("syncMeta")
            .and_then(|m| m.get_mut("eventConfigUpdatedAt"))
            .and_then(|v| v.as_object_mut())
        {
            times.remove(&key);
        }
        store.persist()?;
    }
    let _ = app.emit("data:changed", ());
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn set_float_ui(
    app: AppHandle,
    state: State<AppState>,
    label: String,
    patch: Value,
) -> Result<(), String> {
    let key = tray::key_for(&label);
    {
        let mut store = state.store.lock().unwrap();
        if let Some(ui) = store.data.get_mut("ui").and_then(|v| v.as_object_mut()) {
            let entry = ui.entry(key.to_string()).or_insert_with(|| json!({}));
            if let Some(obj) = entry.as_object_mut() {
                if let Some(patch) = patch.as_object() {
                    for (k, v) in patch {
                        obj.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        store.persist()?;
    }
    tray::emit_float(&app, &label);
    Ok(())
}

/// 手机端没有桌面悬浮窗，保持命令存在但为空操作。
#[cfg(mobile)]
#[tauri::command]
fn set_float_ui(
    _app: AppHandle,
    _state: State<AppState>,
    _label: String,
    _patch: Value,
) -> Result<(), String> {
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn set_main_on_top(app: AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(on);
    }
}

#[cfg(mobile)]
#[tauri::command]
fn set_main_on_top(_app: AppHandle, _on: bool) {}

#[tauri::command]
fn get_data_dir(state: State<AppState>) -> String {
    state.store.lock().unwrap().dir.to_string_lossy().to_string()
}

#[cfg(desktop)]
#[tauri::command]
fn open_data_dir(state: State<AppState>) -> Result<(), String> {
    let dir = state.store.lock().unwrap().dir.clone();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
fn open_data_dir(_state: State<AppState>) -> Result<(), String> {
    Err("手机端没有可打开的文件夹".into())
}

#[cfg(desktop)]
#[tauri::command]
async fn export_data(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let data = state.store.lock().unwrap().data.clone();
    let path = rfd::FileDialog::new()
        .set_title("导出数据")
        .set_file_name("timemanage-data.json")
        .add_filter("JSON", &["json"])
        .save_file();
    match path {
        Some(p) => {
            let text = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
            std::fs::write(&p, text).map_err(|e| e.to_string())?;
            Ok(Some(p.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

#[cfg(mobile)]
#[tauri::command]
async fn export_data(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let data = state.store.lock().unwrap().data.clone();
    let text = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("导出数据")
            .set_file_name("timemanage-data.json")
            .add_filter("JSON", &["json", "application/json"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let mut file = app
        .fs()
        .open(path, options)
        .map_err(|e| format!("打开导出文件失败：{}", e))?;
    file.write_all(text.as_bytes())
        .map_err(|e| format!("写入导出文件失败：{}", e))?;
    Ok(Some("已保存到你选择的位置".into()))
}

#[cfg(desktop)]
#[tauri::command]
async fn import_data(app: AppHandle, state: State<'_, AppState>) -> Result<Option<Value>, String> {
    let path = rfd::FileDialog::new()
        .set_title("导入数据")
        .add_filter("JSON", &["json"])
        .pick_file();
    match path {
        Some(p) => {
            let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
            let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            let result = {
                let mut store = state.store.lock().unwrap();
                store.merge(value)?;
                store.data.clone()
            };
            let _ = app.emit("data:changed", ());
            Ok(Some(result))
        }
        None => Ok(None),
    }
}

#[cfg(mobile)]
#[tauri::command]
async fn import_data(app: AppHandle, state: State<'_, AppState>) -> Result<Option<Value>, String> {
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("导入数据")
            .add_filter(
                "JSON",
                &["json", "application/json", "text/plain", "application/octet-stream"],
            )
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let text = app
        .fs()
        .read_to_string(path)
        .map_err(|e| format!("读取导入文件失败：{}", e))?;
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("不是有效 JSON：{}", e))?;
    let result = {
        let mut store = state.store.lock().unwrap();
        store.merge_additive(value)?;
        store.data.clone()
    };
    let _ = app.emit("data:changed", ());
    Ok(Some(result))
}

fn emit_state(app: &AppHandle, state: &State<AppState>) -> Value {
    let s = state.engine.lock().unwrap().public_state();
    let _ = app.emit("timer:tick", &s);
    sync_notification(app, &s);
    persist_timer_snapshot(app);
    s
}

#[tauri::command]
fn timer_state(state: State<AppState>) -> Value {
    state.engine.lock().unwrap().public_state()
}

#[tauri::command]
fn start_timer(
    app: AppHandle,
    state: State<AppState>,
    category_id: Option<String>,
    event_id: Option<String>,
    mode: Option<String>,
    countdown_minutes: Option<i64>,
) -> Value {
    hide_alert_window(&app);
    let recorded = {
        let mut store = state.store.lock().unwrap();
        let mut engine = state.engine.lock().unwrap();
        let mut recorded = false;
        if let Some(session) = engine.flush_session() {
            if is_recordable(&session) {
                let _ = store.append_session(session);
                recorded = true;
            }
        }
        match mode.as_deref() {
            Some("countup") => engine.start_countup(&store, category_id, event_id),
            Some("countdown") => engine.start_countdown(
                &store,
                category_id,
                event_id,
                countdown_minutes.unwrap_or(25),
            ),
            _ => engine.start(&store, category_id, event_id),
        }
        recorded
    };
    if recorded {
        let _ = app.emit("data:changed", ());
    }
    emit_state(&app, &state)
}

#[tauri::command]
fn pause_timer(app: AppHandle, state: State<AppState>) -> Value {
    state.engine.lock().unwrap().pause();
    emit_state(&app, &state)
}

#[tauri::command]
fn resume_timer(app: AppHandle, state: State<AppState>) -> Value {
    state.engine.lock().unwrap().resume();
    emit_state(&app, &state)
}

#[tauri::command]
fn extend_study(app: AppHandle, state: State<AppState>) -> Value {
    hide_alert_window(&app);
    let warn = state.engine.lock().unwrap().extend_study();
    let s = emit_state(&app, &state);
    json!({ "state": s, "warn": warn })
}

#[tauri::command]
fn extend_break(app: AppHandle, state: State<AppState>) -> Value {
    hide_alert_window(&app);
    state.engine.lock().unwrap().extend_break();
    emit_state(&app, &state)
}

#[tauri::command]
fn end_phase_early(app: AppHandle, state: State<AppState>) -> Value {
    let finished = state.engine.lock().unwrap().early_end();
    let s = emit_state(&app, &state);
    if let Some(f) = &finished {
        let _ = app.emit("timer:finished", f);
        notify_finished(&app, f);
    }
    json!({ "state": s, "finished": finished })
}

#[tauri::command]
fn start_break(app: AppHandle, state: State<AppState>) -> Value {
    hide_alert_window(&app);
    let recorded = {
        let mut store = state.store.lock().unwrap();
        let mut engine = state.engine.lock().unwrap();
        if let Some(session) = engine.start_break() {
            if is_recordable(&session) {
                let _ = store.append_session(session);
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    if recorded {
        let _ = app.emit("data:changed", ());
    }
    emit_state(&app, &state)
}

#[tauri::command]
fn next_study(app: AppHandle, state: State<AppState>) -> Value {
    hide_alert_window(&app);
    let recorded = {
        let mut store = state.store.lock().unwrap();
        let mut engine = state.engine.lock().unwrap();
        if let Some(session) = engine.next_study() {
            if is_recordable(&session) {
                let _ = store.append_session(session);
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    if recorded {
        let _ = app.emit("data:changed", ());
    }
    emit_state(&app, &state)
}

#[tauri::command]
fn stop_timer(app: AppHandle, state: State<AppState>) -> Value {
    hide_alert_window(&app);
    let recorded = {
        let mut store = state.store.lock().unwrap();
        let mut engine = state.engine.lock().unwrap();
        if let Some(session) = engine.flush_session() {
            if is_recordable(&session) {
                let _ = store.append_session(session);
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    if recorded {
        let _ = app.emit("data:changed", ());
    }
    emit_state(&app, &state)
}

#[cfg(desktop)]
#[tauri::command]
fn set_float_visible(app: AppHandle, label: String, visible: bool) {
    tray::set_float_visible(&app, &label, visible);
}

#[cfg(mobile)]
#[tauri::command]
fn set_float_visible(_app: AppHandle, _label: String, _visible: bool) {}

#[cfg(desktop)]
#[tauri::command]
fn toggle_float(app: AppHandle, label: String) {
    tray::toggle_float(&app, &label);
}

#[cfg(mobile)]
#[tauri::command]
fn toggle_float(_app: AppHandle, _label: String) {}

#[tauri::command]
fn show_main(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        #[cfg(desktop)]
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn show_alert_window(app: &AppHandle) {
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window("alert") {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }
    #[cfg(mobile)]
    let _ = app;
}

fn hide_alert_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("alert") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn hide_alert(app: AppHandle) {
    hide_alert_window(&app);
}

#[tauri::command]
fn show_alert(app: AppHandle) {
    show_alert_window(&app);
}

fn spawn_background(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_sig = String::new();
        let mut last_notify_sig = String::new();
        let mut ticks: u64 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(200));
            ticks += 1;

            let (finished, state, auto_session) = {
                let app_state = app.state::<AppState>();
                let mut engine = app_state.engine.lock().unwrap();
                let finished = engine.tick();
                let mut session = None;
                if finished.is_some() && engine.auto_next {
                    session = if engine.phase == Phase::Study {
                        engine.start_break()
                    } else {
                        engine.next_study()
                    };
                }
                (finished, engine.public_state(), session)
            };

            if let Some(session) = auto_session {
                if is_recordable(&session) {
                    let app_state = app.state::<AppState>();
                    let mut store = app_state.store.lock().unwrap();
                    let _ = store.append_session(session);
                    drop(store);
                    let _ = app.emit("data:changed", ());
                }
            }

            let notify_sig = notification_sig(&state);
            if notify_sig != last_notify_sig {
                last_notify_sig = notify_sig;
                sync_notification(&app, &state);
                persist_timer_snapshot(&app);
            }

            if let Some(payload) = finished {
                let _ = app.emit("timer:finished", &payload);
                if !payload["autoNext"].as_bool().unwrap_or(false) {
                    notify_finished(&app, &payload);
                }
            }

            let sig = format!(
                "{}|{}|{}|{}|{}",
                state["phase"], state["paused"], state["pending"], state["remaining"], state["cycleIndex"]
            );
            if sig != last_sig {
                last_sig = sig;
                let _ = app.emit("timer:tick", &state);
            }

            if ticks % 25 == 0 {
                persist_timer_snapshot(&app);
            }

            if ticks == 1 || ticks % 150 == 0 {
                let due = {
                    let app_state = app.state::<AppState>();
                    let mut store = app_state.store.lock().unwrap();
                    countdown::check_due(&mut store)
                };
                if !due.is_empty() {
                    let _ = app.emit("countdown:due", &due);
                    let _ = app.emit("data:changed", ());
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::<tauri::Wry>::default()
        .plugin(tauri_plugin_timer_notification::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }

    #[cfg(target_os = "android")]
    {
        builder = builder
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_fs::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            load_data,
            update_settings,
            set_selection,
            add_event,
            delete_event,
            save_countdown,
            delete_countdown,
            save_session,
            delete_session,
            save_sessions,
            delete_sessions,
            set_event_config,
            clear_event_config,
            set_float_ui,
            set_main_on_top,
            hide_alert,
            show_alert,
            get_data_dir,
            open_data_dir,
            export_data,
            import_data,
            sync::sync_info,
            sync::sync_apply,
            sync::sync_stop,
            sync::sync_regenerate_token,
            sync::sync_now,
            timer_state,
            start_timer,
            pause_timer,
            resume_timer,
            extend_study,
            extend_break,
            end_phase_early,
            start_break,
            next_study,
            stop_timer,
            set_float_visible,
            toggle_float,
            show_main,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            #[allow(unused_variables)]
            let data_dir: std::path::PathBuf = {
                #[cfg(desktop)]
                {
                    storage::resolve_data_dir()
                }
                #[cfg(mobile)]
                {
                    app.path()
                        .app_data_dir()
                        .unwrap_or_else(|_| std::path::PathBuf::from("data"))
                }
            };

            let store = Store::load(data_dir);
            let store_dir = store.dir.clone();
            let snapshot_path = store.dir.join("timer-snapshot.json");
            let engine = std::fs::read_to_string(&snapshot_path)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|snapshot| Engine::restore(&snapshot, &store))
                .unwrap_or_default();
            let _ = SNAPSHOT_PATH.set(snapshot_path);

            app.manage(AppState {
                store: Mutex::new(store),
                engine: Mutex::new(engine),
            });
            app.manage(sync::SyncState::load(&store_dir));
            init_notification_worker();

            let restored_state = {
                let state = handle.state::<AppState>();
                let engine = state.engine.lock().unwrap();
                engine.public_state()
            };
            sync_notification(&handle, &restored_state);
            sync::startup(&handle);

            #[cfg(desktop)]
            {
                tray::setup_tray(&handle)?;

                let restore: Vec<(String, bool)> = {
                    let state = handle.state::<AppState>();
                    let store = state.store.lock().unwrap();
                    ["pomodoro-float", "countdown-float"]
                        .iter()
                        .map(|label| {
                            let key = tray::key_for(label);
                            let visible = store
                                .data
                                .get("ui")
                                .and_then(|u| u.get(key))
                                .and_then(|e| e.get("visible"))
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            (label.to_string(), visible)
                        })
                        .collect()
                };
                for (label, visible) in restore {
                    if visible {
                        tray::set_float_visible(&handle, &label, true);
                    }
                }
            }

            spawn_background(handle.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            match event {
                tauri::WindowEvent::Moved(pos) => {
                    let label = window.label();
                    if label == "pomodoro-float" || label == "countdown-float" {
                        if should_save_pos() {
                            let key = tray::key_for(label);
                            tray::save_position_value(window.app_handle(), pos.x, pos.y, key);
                        }
                    }
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
            #[cfg(mobile)]
            {
                let _ = (window, event);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

