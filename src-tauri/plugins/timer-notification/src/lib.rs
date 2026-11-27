//! Android ongoing timer notification plugin.
//!
//! On desktop every public function is a no-op, so the host app does not need
//! platform branches. On Android the notification is owned by a foreground
//! service and uses the system chronometer; actions are delivered back to JS.

use std::sync::OnceLock;

use serde::Serialize;
use serde_json::Value;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::Wry;

const PLUGIN_NAME: &str = "timer-notification";

static HANDLE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerPayload {
    pub title: String,
    pub text: String,
    /// `countdown` or `countup`
    pub mode: String,
    /// Epoch millis for countdown; 0 for countup.
    pub end_at: i64,
    /// Elapsed seconds for countup.
    pub elapsed_seconds: i64,
    pub paused: bool,
    pub remaining_seconds: i64,
    pub sound_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishedPayload {
    pub title: String,
    pub text: String,
    pub sound_enabled: bool,
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new(PLUGIN_NAME)
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api
                    .register_android_plugin("com.timemanage.notification", "TimerNotificationPlugin")?;
                let _ = HANDLE.set(handle);
            }
            #[cfg(not(target_os = "android"))]
            let _ = &api;
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
fn send<T: Serialize>(command: &str, payload: &T) {
    if let Some(handle) = HANDLE.get() {
        let _ = handle.run_mobile_plugin::<Value>(command, payload);
    }
}

#[cfg(not(target_os = "android"))]
fn send<T: Serialize>(_command: &str, _payload: &T) {}

pub fn start(payload: TimerPayload) {
    send("start", &payload);
}

pub fn update(payload: TimerPayload) {
    send("update", &payload);
}

pub fn stop() {
    send("stop", &serde_json::json!({}));
}

pub fn finished(payload: FinishedPayload) {
    send("finished", &payload);
}

pub fn request_permission() {
    send("requestPermission", &serde_json::json!({}));
}
