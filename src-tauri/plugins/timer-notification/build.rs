const COMMANDS: &[&str] = &[
    "start",
    "update",
    "stop",
    "finished",
    "requestPermission",
    "registerListener",
    "removeListener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .try_build()
        .expect("failed to build timer-notification plugin");
}
