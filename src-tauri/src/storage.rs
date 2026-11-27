use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Map, Value};

pub struct Store {
    pub dir: PathBuf,
    pub file: PathBuf,
    pub data: Value,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct MergeStats {
    pub added: usize,
    pub updated: usize,
    pub kept: usize,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn record_time(value: &Value) -> i64 {
    value.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0)
}

fn canonical(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// 时间戳相同（或都缺失）时用内容字典序稳定决胜，保证两端反复合并也能收敛。
fn incoming_is_newer(local: &Value, incoming: &Value) -> bool {
    let local_time = record_time(local);
    let incoming_time = record_time(incoming);
    if incoming_time != local_time {
        return incoming_time > local_time;
    }
    canonical(incoming) > canonical(local)
}

/// 写入/编辑记录时统一打时间戳；同步合并不会改写它。
pub fn stamp_record(value: &mut Value) {
    if let Some(obj) = value.as_object_mut() {
        obj.insert("updatedAt".into(), json!(now_ms()));
    }
}

fn ensure_sync_meta(data: &mut Value) -> &mut Map<String, Value> {
    if !data.get("syncMeta").map(|v| v.is_object()).unwrap_or(false) {
        if let Some(obj) = data.as_object_mut() {
            obj.insert(
                "syncMeta".into(),
                json!({ "settingsUpdatedAt": 0, "eventConfigUpdatedAt": {} }),
            );
        }
    }
    data.get_mut("syncMeta")
        .and_then(|v| v.as_object_mut())
        .expect("syncMeta")
}

pub fn stamp_settings_updated(data: &mut Value) {
    let meta = ensure_sync_meta(data);
    meta.insert("settingsUpdatedAt".into(), json!(now_ms()));
}

pub fn stamp_event_config_updated(data: &mut Value, key: &str) {
    let time = now_ms();
    let meta = ensure_sync_meta(data);
    if !meta
        .get("eventConfigUpdatedAt")
        .map(|v| v.is_object())
        .unwrap_or(false)
    {
        meta.insert("eventConfigUpdatedAt".into(), json!({}));
    }
    if let Some(map) = meta
        .get_mut("eventConfigUpdatedAt")
        .and_then(|v| v.as_object_mut())
    {
        map.insert(key.to_string(), json!(time));
    }
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let file = dir.join("app-data.json");
        let data = fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(migrate)
            .unwrap_or_else(|| migrate(default_data()));
        let store = Store { dir, file, data };
        let _ = store.persist();
        store
    }

    pub fn persist(&self) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let tmp = self.file.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&self.data).map_err(|e| e.to_string())?;
        fs::write(&tmp, text).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.file).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn replace(&mut self, data: Value) -> Result<(), String> {
        self.data = migrate(data);
        self.persist()
    }

    /// 导入/同步共用的合并入口；只增不删，同 id 取较新内容。
    pub fn merge(&mut self, incoming: Value) -> Result<(), String> {
        self.merge_additive(incoming).map(|_| ())
    }

    pub fn merge_additive(&mut self, incoming: Value) -> Result<MergeStats, String> {
        let incoming = migrate(incoming);
        let mut local = migrate(std::mem::replace(&mut self.data, Value::Null));
        let stats = merge_additive_data(&mut local, &incoming);
        local["schemaVersion"] = json!(2);
        self.data = local;
        self.persist()?;
        Ok(stats)
    }

    pub fn append_session(&mut self, mut session: Value) -> Result<(), String> {
        if record_time(&session) == 0 {
            stamp_record(&mut session);
        }
        let obj = self
            .data
            .as_object_mut()
            .ok_or_else(|| "data is not an object".to_string())?;
        let sessions = obj
            .entry("sessions")
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Some(arr) = sessions.as_array_mut() {
            arr.push(session);
        }
        self.persist()
    }

    pub fn settings_i64(&self, key: &str, fallback: i64) -> i64 {
        self.data
            .get("settings")
            .and_then(|s| s.get(key))
            .and_then(|v| v.as_i64())
            .unwrap_or(fallback)
    }

    pub fn settings_bool(&self, key: &str, fallback: bool) -> bool {
        self.data
            .get("settings")
            .and_then(|s| s.get(key))
            .and_then(|v| v.as_bool())
            .unwrap_or(fallback)
    }

    /// 全局默认设置叠加某个事件的自定义配置。
    pub fn effective_settings(
        &self,
        category_id: Option<&str>,
        event_id: Option<&str>,
    ) -> Value {
        let mut base = self
            .data
            .get("settings")
            .cloned()
            .unwrap_or_else(default_settings);
        if let (Some(cat), Some(ev)) = (category_id, event_id) {
            let key = format!("{}|{}", cat, ev);
            if let Some(cfg) = self.data.get("eventConfigs").and_then(|v| v.get(&key)) {
                if let (Some(b), Some(c)) = (base.as_object_mut(), cfg.as_object()) {
                    for (k, v) in c {
                        b.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        base
    }
}

fn merge_record_list(list: &mut Vec<Value>, incoming: &Value, stats: &mut MergeStats) {
    let id = incoming
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if id.is_empty() {
        list.push(incoming.clone());
        stats.added += 1;
        return;
    }
    match list
        .iter_mut()
        .find(|item| item.get("id").and_then(|v| v.as_str()) == Some(id))
    {
        Some(local) => {
            if incoming_is_newer(local, incoming) {
                *local = incoming.clone();
                stats.updated += 1;
            } else {
                stats.kept += 1;
            }
        }
        None => {
            list.push(incoming.clone());
            stats.added += 1;
        }
    }
}

fn merge_sync_meta(local: &mut Map<String, Value>, incoming: &Map<String, Value>) {
    let local_meta = local
        .entry("syncMeta")
        .or_insert_with(|| json!({ "settingsUpdatedAt": 0, "eventConfigUpdatedAt": {} }));
    if !local_meta.is_object() {
        *local_meta = json!({ "settingsUpdatedAt": 0, "eventConfigUpdatedAt": {} });
    }
    let incoming_meta = incoming.get("syncMeta").and_then(|v| v.as_object());

    let local_settings_time = local_meta
        .get("settingsUpdatedAt")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let incoming_settings_time = incoming_meta
        .and_then(|m| m.get("settingsUpdatedAt"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if let Some(obj) = local_meta.as_object_mut() {
        obj.insert(
            "settingsUpdatedAt".into(),
            json!(local_settings_time.max(incoming_settings_time)),
        );
        if !obj
            .get("eventConfigUpdatedAt")
            .map(|v| v.is_object())
            .unwrap_or(false)
        {
            obj.insert("eventConfigUpdatedAt".into(), json!({}));
        }
    }

    let incoming_times = incoming_meta
        .and_then(|m| m.get("eventConfigUpdatedAt"))
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    if let Some(local_times) = local_meta
        .get_mut("eventConfigUpdatedAt")
        .and_then(|v| v.as_object_mut())
    {
        for (key, value) in incoming_times {
            let next = local_times
                .get(&key)
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                .max(value.as_i64().unwrap_or(0));
            local_times.insert(key, json!(next));
        }
    }
}

fn merge_settings(local: &mut Map<String, Value>, incoming: &Map<String, Value>, stats: &mut MergeStats) {
    let incoming_settings = incoming.get("settings").and_then(|v| v.as_object());
    let Some(incoming_settings) = incoming_settings else {
        return;
    };
    let local_time = local
        .get("syncMeta")
        .and_then(|m| m.get("settingsUpdatedAt"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let incoming_time = incoming
        .get("syncMeta")
        .and_then(|m| m.get("settingsUpdatedAt"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let mut settings = local
        .get("settings")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    for (key, incoming_value) in incoming_settings {
        let use_incoming = match settings.get(key) {
            None => true,
            Some(local_value) => {
                if incoming_time != local_time {
                    incoming_time > local_time
                } else {
                    canonical(incoming_value) > canonical(local_value)
                }
            }
        };
        if use_incoming {
            settings.insert(key.clone(), incoming_value.clone());
            stats.updated += 1;
        }
    }
    local.insert("settings".into(), Value::Object(settings));
}

fn merge_event_configs(
    local: &mut Map<String, Value>,
    incoming: &Map<String, Value>,
    stats: &mut MergeStats,
) {
    let incoming_configs = incoming
        .get("eventConfigs")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    if incoming_configs.is_empty() {
        return;
    }
    if !local
        .get("eventConfigs")
        .map(|v| v.is_object())
        .unwrap_or(false)
    {
        local.insert("eventConfigs".into(), json!({}));
    }
    let incoming_times = incoming
        .get("syncMeta")
        .and_then(|m| m.get("eventConfigUpdatedAt"))
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let mut configs = local
        .get("eventConfigs")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    for (key, incoming_value) in &incoming_configs {
        let incoming_time = incoming_times
            .get(key)
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let local_time = local
            .get("syncMeta")
            .and_then(|m| m.get("eventConfigUpdatedAt"))
            .and_then(|v| v.get(key))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let use_incoming = match configs.get(key) {
            None => true,
            Some(local_value) => {
                if incoming_time != local_time {
                    incoming_time > local_time
                } else {
                    canonical(incoming_value) > canonical(local_value)
                }
            }
        };
        if use_incoming {
            configs.insert(key.clone(), incoming_value.clone());
            stats.updated += 1;
        }
    }
    local.insert("eventConfigs".into(), Value::Object(configs));
}

/// 只增不删的合并：同 id 取较新内容，任何一端独有的记录都保留。
pub fn merge_additive_data(local: &mut Value, incoming: &Value) -> MergeStats {
    let mut stats = MergeStats::default();
    let Some(local_obj) = local.as_object_mut() else {
        return stats;
    };
    let Some(incoming_obj) = incoming.as_object() else {
        return stats;
    };

    for key in ["sessions", "countdowns"] {
        if let Some(incoming_items) = incoming_obj.get(key).and_then(|v| v.as_array()) {
            if !local_obj.get(key).map(|v| v.is_array()).unwrap_or(false) {
                local_obj.insert(key.into(), json!([]));
            }
            if let Some(local_items) = local_obj.get_mut(key).and_then(|v| v.as_array_mut()) {
                for item in incoming_items {
                    merge_record_list(local_items, item, &mut stats);
                }
            }
        }
    }

    if let Some(incoming_categories) = incoming_obj.get("categories").and_then(|v| v.as_array()) {
        if !local_obj
            .get("categories")
            .map(|v| v.is_array())
            .unwrap_or(false)
        {
            local_obj.insert("categories".into(), json!([]));
        }
        if let Some(local_categories) = local_obj.get_mut("categories").and_then(|v| v.as_array_mut()) {
            for incoming_category in incoming_categories {
                let id = incoming_category
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if id.is_empty() {
                    continue;
                }
                match local_categories
                    .iter_mut()
                    .find(|category| category.get("id").and_then(|v| v.as_str()) == Some(id))
                {
                    Some(local_category) => {
                        let incoming_events = incoming_category
                            .get("events")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        if !local_category
                            .get("events")
                            .map(|v| v.is_array())
                            .unwrap_or(false)
                        {
                            if let Some(obj) = local_category.as_object_mut() {
                                obj.insert("events".into(), Value::Array(incoming_events));
                            }
                        } else if let Some(local_events) =
                            local_category.get_mut("events").and_then(|v| v.as_array_mut())
                        {
                            for event in &incoming_events {
                                merge_record_list(local_events, event, &mut stats);
                            }
                        }
                    }
                    None => {
                        local_categories.push(incoming_category.clone());
                        stats.added += 1;
                    }
                }
            }
        }
    }

    merge_settings(local_obj, incoming_obj, &mut stats);
    merge_event_configs(local_obj, incoming_obj, &mut stats);
    merge_sync_meta(local_obj, incoming_obj);

    local_obj.insert("schemaVersion".into(), json!(2));
    stats
}


#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_writable(dir: &std::path::Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-test");
    match fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 桌面端数据目录：环境变量覆盖 → 程序目录 data/ → 当前目录 data/ → APPDATA。
/// Android 由 lib.rs 使用 Tauri 的 app_data_dir 决定。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn resolve_data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("TIMEMANAGE_DATA_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join("data");
            if is_writable(&candidate) {
                return candidate;
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join("data");
        if is_writable(&candidate) {
            return candidate;
        }
    }

    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let candidate = base.join("TimeManage").join("data");
    let _ = fs::create_dir_all(&candidate);
    candidate
}

fn default_categories() -> Value {
    json!([
        {
            "id": "study",
            "name": "学习",
            "icon": "📚",
            "color": "#ff9fb2",
            "events": [
                { "id": "e_java", "name": "学习 Java" },
                { "id": "e_python", "name": "学习 Python" }
            ]
        },
        {
            "id": "fun",
            "name": "娱乐",
            "icon": "🎮",
            "color": "#9fc7ff",
            "events": [
                { "id": "e_movie", "name": "看电影" },
                { "id": "e_game", "name": "打游戏" }
            ]
        },
        {
            "id": "life",
            "name": "生活",
            "icon": "🏠",
            "color": "#a8e6c9",
            "events": [
                { "id": "e_cook", "name": "做饭" },
                { "id": "e_tidy", "name": "整理房间" }
            ]
        },
        {
            "id": "other",
            "name": "其他",
            "icon": "🗂️",
            "color": "#b8c2d0",
            "events": []
        }
    ])
}

pub fn default_settings() -> Value {
    json!({
        "studyMinutes": 25,
        "breakMinutes": 5,
        "cycles": 4,
        "extendStudyMinutes": 5,
        "extendBreakMinutes": 1,
        "autoStartNext": false,
        "soundEnabled": true,
        "soundVolume": 0.5,
        "theme": "sweet"
    })
}

pub fn default_data() -> Value {
    json!({
        "schemaVersion": 2,
        "settings": default_settings(),
        "categories": default_categories(),
        "sessions": [],
        "countdowns": [],
        "eventConfigs": {},
        "syncMeta": {
            "settingsUpdatedAt": 0,
            "eventConfigUpdatedAt": {}
        },
        "ui": {
            "pomodoroFloat": { "visible": false, "collapsed": false, "panel": false, "x": null, "y": null, "cx": null, "cy": null, "w": null, "h": null },
            "countdownFloat": { "visible": false, "collapsed": false, "panel": false, "x": null, "y": null, "cx": null, "cy": null, "w": null, "h": null }
        }
    })
}

fn migrate(mut data: Value) -> Value {
    let defaults = default_data();
    let obj = match data.as_object_mut() {
        Some(o) => o,
        None => return defaults,
    };

    let schema = obj
        .get("schemaVersion")
        .and_then(|v| v.as_i64())
        .unwrap_or(1);
    obj.insert("schemaVersion".into(), json!(schema.max(2)));

    if !obj.get("settings").map(|v| v.is_object()).unwrap_or(false) {
        obj.insert("settings".into(), default_settings());
    } else {
        let mut settings = obj.get("settings").cloned().unwrap_or_else(default_settings);
        if let (Some(s), Some(d)) = (settings.as_object_mut(), default_settings().as_object()) {
            for (k, v) in d {
                if !s.contains_key(k) {
                    s.insert(k.clone(), v.clone());
                }
            }
        }
        obj.insert("settings".into(), settings);
    }

    if !obj.get("categories").map(|v| v.is_array()).unwrap_or(false) {
        obj.insert("categories".into(), default_categories());
    }
    if let Some(cats) = obj.get_mut("categories").and_then(|v| v.as_array_mut()) {
        let has_other = cats
            .iter()
            .any(|c| c.get("id").and_then(|v| v.as_str()) == Some("other"));
        if !has_other {
            cats.push(json!({
                "id": "other",
                "name": "其他",
                "icon": "🗂️",
                "color": "#b8c2d0",
                "events": []
            }));
        }
    }
    if !obj.get("sessions").map(|v| v.is_array()).unwrap_or(false) {
        obj.insert("sessions".into(), json!([]));
    }
    if !obj.get("countdowns").map(|v| v.is_array()).unwrap_or(false) {
        obj.insert("countdowns".into(), json!([]));
    }
    if !obj.get("eventConfigs").map(|v| v.is_object()).unwrap_or(false) {
        obj.insert("eventConfigs".into(), json!({}));
    }
    if !obj.get("syncMeta").map(|v| v.is_object()).unwrap_or(false) {
        obj.insert(
            "syncMeta".into(),
            json!({ "settingsUpdatedAt": 0, "eventConfigUpdatedAt": {} }),
        );
    }
    if !obj.get("ui").map(|v| v.is_object()).unwrap_or(false) {
        obj.insert(
            "ui".into(),
            json!({
                "pomodoroFloat": { "visible": false, "x": null, "y": null },
                "countdownFloat": { "visible": false, "x": null, "y": null }
            }),
        );
    }

    // v1 → v2：给记录补 updatedAt，供只增不删的合并判断新旧。
    if let Some(sessions) = obj.get_mut("sessions").and_then(|v| v.as_array_mut()) {
        for session in sessions.iter_mut() {
            if session.get("updatedAt").is_none() {
                let time = session
                    .get("endedAt")
                    .and_then(|v| v.as_i64())
                    .or_else(|| session.get("startedAt").and_then(|v| v.as_i64()))
                    .unwrap_or(0);
                if let Some(record) = session.as_object_mut() {
                    record.insert("updatedAt".into(), json!(time));
                }
            }
        }
    }
    if let Some(countdowns) = obj.get_mut("countdowns").and_then(|v| v.as_array_mut()) {
        for countdown in countdowns.iter_mut() {
            if countdown.get("updatedAt").is_none() {
                if let Some(record) = countdown.as_object_mut() {
                    record.insert("updatedAt".into(), json!(0));
                }
            }
        }
    }
    if let Some(categories) = obj.get_mut("categories").and_then(|v| v.as_array_mut()) {
        for category in categories.iter_mut() {
            if let Some(events) = category.get_mut("events").and_then(|v| v.as_array_mut()) {
                for event in events.iter_mut() {
                    if event.get("updatedAt").is_none() {
                        if let Some(record) = event.as_object_mut() {
                            record.insert("updatedAt".into(), json!(0));
                        }
                    }
                }
            }
        }
    }

    data
}

#[cfg(test)]
mod tests {
    use super::*;

    fn incoming_with(sessions: Value) -> Value {
        json!({
            "schemaVersion": 2,
            "settings": {},
            "eventConfigs": {},
            "sessions": sessions,
            "countdowns": [],
            "syncMeta": { "settingsUpdatedAt": 0, "eventConfigUpdatedAt": {} }
        })
    }

    fn local_with_sessions(sessions: Value) -> Value {
        let mut data = default_data();
        data["sessions"] = sessions;
        data
    }

    #[test]
    fn migrate_v1_adds_updated_at_and_sync_meta() {
        let migrated = migrate(json!({
            "schemaVersion": 1,
            "settings": {},
            "categories": [{ "id": "study", "name": "学习", "events": [{ "id": "e1", "name": "旧事件" }] }],
            "sessions": [{ "id": "s1", "startedAt": 100, "endedAt": 200, "kind": "study" }],
            "countdowns": [{ "id": "c1", "title": "考试" }],
            "eventConfigs": {},
            "ui": {}
        }));
        assert_eq!(migrated["schemaVersion"].as_i64(), Some(2));
        assert_eq!(migrated["sessions"][0]["updatedAt"].as_i64(), Some(200));
        assert_eq!(migrated["countdowns"][0]["updatedAt"].as_i64(), Some(0));
        assert_eq!(migrated["categories"][0]["events"][0]["updatedAt"].as_i64(), Some(0));
        assert!(migrated["syncMeta"]["eventConfigUpdatedAt"].is_object());
    }

    #[test]
    fn additive_merge_keeps_local_only_and_adds_new_records() {
        let mut local = local_with_sessions(json!([
            { "id": "a", "updatedAt": 100, "kind": "study", "focusedSeconds": 60 },
            { "id": "b", "updatedAt": 50, "kind": "study", "focusedSeconds": 30 }
        ]));
        let stats = merge_additive_data(
            &mut local,
            &incoming_with(json!([
                { "id": "a", "updatedAt": 200, "kind": "study", "focusedSeconds": 120 },
                { "id": "c", "updatedAt": 10, "kind": "study", "focusedSeconds": 10 }
            ])),
        );
        let sessions = local["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 3);
        assert_eq!(
            sessions.iter().find(|s| s["id"] == "a").unwrap()["focusedSeconds"],
            json!(120)
        );
        assert!(sessions.iter().any(|s| s["id"] == "b"));
        assert!(sessions.iter().any(|s| s["id"] == "c"));
        assert_eq!(stats.added, 1);
        assert_eq!(stats.updated, 1);
    }

    #[test]
    fn older_incoming_record_does_not_overwrite_local() {
        let mut local = local_with_sessions(json!([
            { "id": "a", "updatedAt": 300, "kind": "study", "focusedSeconds": 99 }
        ]));
        merge_additive_data(
            &mut local,
            &incoming_with(json!([
                { "id": "a", "updatedAt": 100, "kind": "study", "focusedSeconds": 1 }
            ])),
        );
        assert_eq!(local["sessions"][0]["focusedSeconds"], json!(99));
    }

    #[test]
    fn settings_use_newest_timestamp_without_deleting_keys() {
        let mut local = default_data();
        local["syncMeta"]["settingsUpdatedAt"] = json!(100);
        local["settings"]["studyMinutes"] = json!(25);
        local["settings"]["localOnlyKey"] = json!("keep");
        let mut incoming = incoming_with(json!([]));
        incoming["syncMeta"]["settingsUpdatedAt"] = json!(200);
        incoming["settings"] = json!({ "studyMinutes": 40 });
        merge_additive_data(&mut local, &incoming);
        assert_eq!(local["settings"]["studyMinutes"], json!(40));
        assert_eq!(local["settings"]["localOnlyKey"], json!("keep"));
        assert_eq!(local["syncMeta"]["settingsUpdatedAt"], json!(200));
    }

    #[test]
    fn event_configs_merge_per_key_and_keep_local_only_keys() {
        let mut local = default_data();
        local["eventConfigs"] = json!({ "study|e1": { "studyMinutes": 30 } });
        local["syncMeta"]["eventConfigUpdatedAt"] = json!({ "study|e1": 100 });
        let mut incoming = incoming_with(json!([]));
        incoming["eventConfigs"] = json!({ "study|e1": { "studyMinutes": 45 }, "fun|e2": { "studyMinutes": 10 } });
        incoming["syncMeta"]["eventConfigUpdatedAt"] = json!({ "study|e1": 200, "fun|e2": 50 });
        merge_additive_data(&mut local, &incoming);
        assert_eq!(local["eventConfigs"]["study|e1"]["studyMinutes"], json!(45));
        assert_eq!(local["eventConfigs"]["fun|e2"]["studyMinutes"], json!(10));
    }

    #[test]
    fn events_merge_by_id_and_never_delete_local_events() {
        let mut local = default_data();
        local["categories"] = json!([
            { "id": "study", "name": "学习", "events": [
                { "id": "e1", "name": "本地名字", "updatedAt": 100 },
                { "id": "local", "name": "仅本地", "updatedAt": 50 }
            ] }
        ]);
        let mut incoming = incoming_with(json!([]));
        incoming["categories"] = json!([
            { "id": "study", "name": "学习", "events": [
                { "id": "e1", "name": "远端新名字", "updatedAt": 200 },
                { "id": "remote", "name": "仅远端", "updatedAt": 10 }
            ] }
        ]);
        merge_additive_data(&mut local, &incoming);
        let events = local["categories"][0]["events"].as_array().unwrap();
        assert_eq!(events.len(), 3);
        assert!(events.iter().any(|e| e["name"] == "远端新名字"));
        assert!(events.iter().any(|e| e["name"] == "仅本地"));
        assert!(events.iter().any(|e| e["name"] == "仅远端"));
    }

    #[test]
    fn merge_ignores_incoming_ui_and_is_idempotent() {
        let mut local = default_data();
        local["ui"]["pomodoro"] = json!({ "categoryId": "study" });
        let incoming = json!({
            "schemaVersion": 2,
            "ui": { "pomodoro": { "categoryId": "fun" } },
            "sessions": [{ "id": "a", "updatedAt": 100, "kind": "study" }],
            "syncMeta": { "settingsUpdatedAt": 0, "eventConfigUpdatedAt": {} }
        });
        merge_additive_data(&mut local, &incoming);
        assert_eq!(local["ui"]["pomodoro"]["categoryId"], json!("study"));
        merge_additive_data(&mut local, &incoming);
        assert_eq!(local["sessions"].as_array().unwrap().len(), 1);
    }
}
