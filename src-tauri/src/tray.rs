use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

pub fn key_for(label: &str) -> &'static str {
    if label == "pomodoro-float" {
        "pomodoroFloat"
    } else {
        "countdownFloat"
    }
}

pub fn set_float_visible(app: &AppHandle, label: &str, visible: bool) {
    let key = key_for(label);

    if let Some(win) = app.get_webview_window(label) {
        if visible {
            restore_position(app, &win, key);
            let _ = win.show();
        } else {
            save_position(app, &win, key);
            let _ = win.hide();
        }
    }

    {
        let state = app.state::<AppState>();
        let mut store = state.store.lock().unwrap();
        if let Some(ui) = store.data.get_mut("ui").and_then(|v| v.as_object_mut()) {
            if let Some(entry) = ui.get_mut(key).and_then(|v| v.as_object_mut()) {
                entry.insert("visible".into(), Value::Bool(visible));
            }
        }
        let _ = store.persist();
    }

    emit_float(app, label);
}

pub fn emit_float(app: &AppHandle, label: &str) {
    let key = key_for(label);
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    let entry = store
        .data
        .get("ui")
        .and_then(|u| u.get(key))
        .cloned()
        .unwrap_or(Value::Null);
    let visible = entry.get("visible").and_then(|v| v.as_bool()).unwrap_or(false);
    let collapsed = entry
        .get("collapsed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let panel = entry.get("panel").and_then(|v| v.as_bool()).unwrap_or(false);
    let x = entry.get("x").cloned().unwrap_or(Value::Null);
    let y = entry.get("y").cloned().unwrap_or(Value::Null);
    let cx = entry.get("cx").cloned().unwrap_or(Value::Null);
    let cy = entry.get("cy").cloned().unwrap_or(Value::Null);
    let w = entry.get("w").cloned().unwrap_or(Value::Null);
    let h = entry.get("h").cloned().unwrap_or(Value::Null);
    drop(store);
    let _ = app.emit(
        "float:changed",
        json!({
            "label": label,
            "visible": visible,
            "collapsed": collapsed,
            "panel": panel,
            "x": x,
            "y": y,
            "cx": cx,
            "cy": cy,
            "w": w,
            "h": h,
        }),
    );
}

pub fn toggle_float(app: &AppHandle, label: &str) {
    let visible = app
        .get_webview_window(label)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    set_float_visible(app, label, !visible);
}

fn restore_position(app: &AppHandle, win: &tauri::WebviewWindow, key: &str) {
    let target = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        let entry = store.data.get("ui").and_then(|u| u.get(key));
        match entry {
            Some(e) => {
                let x = e.get("x").and_then(|v| v.as_i64());
                let y = e.get("y").and_then(|v| v.as_i64());
                match (x, y) {
                    (Some(x), Some(y)) => Some((x as i32, y as i32)),
                    _ => None,
                }
            }
            None => None,
        }
    };
    if let Some((x, y)) = target {
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

pub fn save_position(app: &AppHandle, win: &tauri::WebviewWindow, key: &str) {
    if let Ok(pos) = win.outer_position() {
        save_position_value(app, pos.x, pos.y, key);
    }
}

pub fn save_position_value(app: &AppHandle, x: i32, y: i32, key: &str) {
    let state = app.state::<AppState>();
    {
        let mut store = state.store.lock().unwrap();
        let collapsed = store
            .data
            .get("ui")
            .and_then(|u| u.get(key))
            .and_then(|e| e.get("collapsed"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if let Some(ui) = store.data.get_mut("ui").and_then(|v| v.as_object_mut()) {
            if let Some(entry) = ui.get_mut(key).and_then(|v| v.as_object_mut()) {
                if collapsed {
                    entry.insert("cx".into(), json!(x));
                    entry.insert("cy".into(), json!(y));
                } else {
                    entry.insert("x".into(), json!(x));
                    entry.insert("y".into(), json!(y));
                }
            }
        }
        let _ = store.persist();
    }
    let label = if key == "pomodoroFloat" {
        "pomodoro-float"
    } else {
        "countdown-float"
    };
    emit_float(app, label);
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
    let toggle_pomodoro =
        MenuItem::with_id(app, "toggle_pomodoro", "番茄钟悬浮窗", true, None::<&str>)?;
    let toggle_countdown =
        MenuItem::with_id(app, "toggle_countdown", "倒计时悬浮窗", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &toggle_pomodoro, &toggle_countdown, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("时间管理")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "toggle_pomodoro" => toggle_float(app, "pomodoro-float"),
            "toggle_countdown" => toggle_float(app, "countdown-float"),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}
