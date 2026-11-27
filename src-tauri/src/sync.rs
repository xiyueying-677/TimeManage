use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::storage::MergeStats;
use crate::AppState;

const DEFAULT_PORT: u16 = 18923;
const MAX_HEADER: usize = 64 * 1024;
const MAX_BODY: usize = 32 * 1024 * 1024;
const APP_TAG: &str = "TimeManage";

fn default_mode() -> String {
    "off".to_string()
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub auto_sync: bool,
    #[serde(default)]
    pub last_sync_at: i64,
    #[serde(default)]
    pub last_error: String,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            mode: default_mode(),
            port: DEFAULT_PORT,
            token: new_token(),
            host: String::new(),
            auto_sync: false,
            last_sync_at: 0,
            last_error: String::new(),
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_token() -> String {
    let value = uuid::Uuid::new_v4().as_u128();
    format!("{:06}", (value % 1_000_000) as u32)
}

fn valid_token(token: &str) -> bool {
    token.len() == 6 && token.bytes().all(|b| b.is_ascii_digit())
}

fn valid_mode(mode: &str) -> bool {
    matches!(mode, "off" | "host" | "guest")
}

fn normalize_config(mut config: SyncConfig) -> SyncConfig {
    config.mode = config.mode.trim().to_ascii_lowercase();
    if !valid_mode(&config.mode) {
        config.mode = "off".to_string();
    }
    if config.port < 1024 {
        config.port = DEFAULT_PORT;
    }
    config.host = config.host.trim().to_string();
    config.token = config.token.trim().to_string();
    if !valid_token(&config.token) {
        config.token = new_token();
    }
    config
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "localhost")
        .unwrap_or_else(|| APP_TAG.to_string())
}

/// 同步载荷不带 ui：窗口位置、设备偏好等是本机状态，不属于共享数据。
fn sync_view(data: &Value) -> Value {
    let mut value = data.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("ui");
    }
    value
}

fn push_local_ip(addresses: &mut BTreeSet<String>, raw: &str) {
    let candidate = raw.split('/').next().unwrap_or(raw).trim();
    if let Ok(ip) = Ipv4Addr::from_str(candidate) {
        if !ip.is_loopback()
            && !ip.is_unspecified()
            && !ip.is_link_local()
            && !candidate.starts_with("255.")
        {
            addresses.insert(ip.to_string());
        }
    }
}

pub fn local_addresses() -> Vec<String> {
    let mut addresses = BTreeSet::new();
    // UDP connect 只选路不发包，通常能直接拿到当前 Wi-Fi/热点的局域网地址。
    for target in [
        "8.8.8.8:80",
        "192.168.43.1:80",
        "192.168.0.1:80",
        "10.0.2.2:80",
    ] {
        if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
            if socket.connect(target).is_ok() {
                if let Ok(address) = socket.local_addr() {
                    push_local_ip(&mut addresses, &address.ip().to_string());
                }
            }
        }
    }
    if addresses.is_empty() {
        #[cfg(windows)]
        {
            if let Ok(output) = Command::new("ipconfig").output() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    if line.contains("IPv4") {
                        if let Some((_, value)) = line.rsplit_once(':') {
                            push_local_ip(&mut addresses, value);
                        }
                    }
                }
            }
        }
        #[cfg(not(windows))]
        {
            if let Ok(output) = Command::new("ip")
                .args(["-4", "addr", "show"])
                .output()
            {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    let line = line.trim();
                    if let Some(rest) = line.strip_prefix("inet ") {
                        if let Some(ip) = rest.split_whitespace().next() {
                            push_local_ip(&mut addresses, ip);
                        }
                    }
                }
            }
        }
    }
    addresses.into_iter().collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    pub config: SyncConfig,
    pub running: bool,
    pub addresses: Vec<String>,
    pub device: String,
}

struct HostServer {
    stop: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    port: u16,
}

pub struct SyncState {
    path: PathBuf,
    config: Mutex<SyncConfig>,
    host: Mutex<Option<HostServer>>,
}

impl SyncState {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("sync-config.json");
        let mut config = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<SyncConfig>(&text).ok())
            .unwrap_or_default();
        config = normalize_config(config);
        let state = Self {
            path,
            config: Mutex::new(config),
            host: Mutex::new(None),
        };
        let _ = state.save(&state.config());
        state
    }

    fn save(&self, config: &SyncConfig) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建同步配置目录失败：{}", e))?;
        }
        let temp = self.path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
        fs::write(&temp, text).map_err(|e| format!("保存同步配置失败：{}", e))?;
        fs::rename(&temp, &self.path).map_err(|e| format!("保存同步配置失败：{}", e))?;
        Ok(())
    }

    pub fn config(&self) -> SyncConfig {
        self.config.lock().unwrap().clone()
    }

    pub fn set_config(&self, config: SyncConfig) -> Result<(), String> {
        self.save(&config)?;
        *self.config.lock().unwrap() = config;
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.host
            .lock()
            .unwrap()
            .as_ref()
            .map(|host| host.running.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    fn running_port(&self) -> Option<u16> {
        self.host.lock().unwrap().as_ref().map(|host| host.port)
    }

    fn stop_host(&self) {
        let host = self.host.lock().unwrap().take();
        if let Some(host) = host {
            host.stop.store(true, Ordering::Relaxed);
            for _ in 0..60 {
                if !host.running.load(Ordering::Relaxed) {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
            // 让 accept 线程真正退出并释放监听端口。
            thread::sleep(Duration::from_millis(80));
        }
    }

    fn start_host(&self, app: &AppHandle, config: &SyncConfig) -> Result<(), String> {
        self.stop_host();
        let listener = bind_listener(config.port)?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("设置同步服务失败：{}", e))?;
        let stop = Arc::new(AtomicBool::new(false));
        let running = Arc::new(AtomicBool::new(true));
        let stop_thread = stop.clone();
        let running_thread = running.clone();
        let app = app.clone();
        let token = config.token.clone();
        thread::spawn(move || {
            while !stop_thread.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let app = app.clone();
                        let token = token.clone();
                        thread::spawn(move || {
                            if let Err(error) = handle_host_connection(&app, &token, stream) {
                                eprintln!("sync: host request failed: {}", error);
                            }
                        });
                    }
                    Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(150));
                    }
                    Err(error) => {
                        eprintln!("sync: host accept failed: {}", error);
                        break;
                    }
                }
            }
            running_thread.store(false, Ordering::Relaxed);
        });
        *self.host.lock().unwrap() = Some(HostServer {
            stop,
            running,
            port: config.port,
        });
        Ok(())
    }
}

fn bind_listener(port: u16) -> Result<TcpListener, String> {
    let mut last_error = String::new();
    for _ in 0..20 {
        match TcpListener::bind(("0.0.0.0", port)) {
            Ok(listener) => return Ok(listener),
            Err(error) => {
                last_error = error.to_string();
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    Err(format!(
        "端口 {} 无法监听（可能被占用，或系统防火墙拦截）：{}",
        port, last_error
    ))
}

fn sync_info_from(sync: &SyncState) -> SyncInfo {
    SyncInfo {
        config: sync.config(),
        running: sync.is_running(),
        addresses: local_addresses(),
        device: device_name(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigPatch {
    pub mode: Option<String>,
    pub port: Option<u16>,
    pub host: Option<String>,
    pub token: Option<String>,
    pub auto_sync: Option<bool>,
}

#[tauri::command]
pub fn sync_info(sync: State<'_, SyncState>) -> SyncInfo {
    sync_info_from(&sync)
}

#[tauri::command]
pub fn sync_apply(
    app: AppHandle,
    sync: State<'_, SyncState>,
    config: SyncConfigPatch,
) -> Result<SyncInfo, String> {
    let old = sync.config();
    let mut next = SyncConfig {
        mode: config.mode.unwrap_or(old.mode.clone()),
        port: config.port.unwrap_or(old.port),
        token: config.token.unwrap_or(old.token.clone()),
        host: config.host.unwrap_or(old.host.clone()),
        auto_sync: config.auto_sync.unwrap_or(old.auto_sync),
        last_sync_at: old.last_sync_at,
        last_error: old.last_error.clone(),
    };
    next = normalize_config(next);

    if next.mode == "guest" {
        if next.host.trim().is_empty() {
            return Err("请填写主机地址，例如 192.168.1.10".into());
        }
        if !valid_token(&next.token) {
            return Err("配对码必须是 6 位数字".into());
        }
    }

    if next.mode == "host" {
        if !valid_token(&next.token) {
            return Err("配对码必须是 6 位数字".into());
        }
        if next.port < 1024 {
            return Err("端口必须在 1024 到 65535 之间".into());
        }
        let restart = old.mode != "host"
            || old.port != next.port
            || old.token != next.token
            || !sync.is_running()
            || sync.running_port() != Some(next.port);
        if restart {
            sync.stop_host();
            if let Err(error) = sync.start_host(&app, &next) {
                next.mode = "off".to_string();
                next.last_error = format!("启动同步主机失败：{}", error);
                let _ = sync.set_config(next);
                return Err(format!("启动同步主机失败：{}", error));
            }
        }
    } else {
        sync.stop_host();
    }

    next.last_error.clear();
    sync.set_config(next)?;
    Ok(sync_info_from(&sync))
}

#[tauri::command]
pub fn sync_stop(sync: State<'_, SyncState>) -> SyncInfo {
    sync.stop_host();
    let mut config = sync.config();
    config.mode = "off".to_string();
    config.last_error.clear();
    let _ = sync.set_config(config);
    sync_info_from(&sync)
}

#[tauri::command]
pub fn sync_regenerate_token(
    app: AppHandle,
    sync: State<'_, SyncState>,
) -> Result<SyncInfo, String> {
    let mut config = sync.config();
    config.token = new_token();
    config.last_error.clear();
    if config.mode == "host" {
        sync.stop_host();
        if let Err(error) = sync.start_host(&app, &config) {
            config.mode = "off".to_string();
            config.last_error = format!("重新生成配对码后启动失败：{}", error);
            let _ = sync.set_config(config);
            return Err(format!("重新生成配对码失败：{}", error));
        }
    }
    sync.set_config(config)?;
    Ok(sync_info_from(&sync))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub stats: MergeStats,
    pub remote_device: String,
    pub synced_at: i64,
}

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<SyncResult, String> {
    let app_for_task = app.clone();
    let joined =
        tauri::async_runtime::spawn_blocking(move || sync_once_blocking(&app_for_task)).await;
    joined.map_err(|error| format!("同步任务执行失败：{}", error))?
}

fn sync_once_blocking(app: &AppHandle) -> Result<SyncResult, String> {
    let result = sync_once_inner(app);
    if let Err(error) = &result {
        let sync = app.state::<SyncState>();
        let mut config = sync.config();
        config.last_error = error.clone();
        let _ = sync.set_config(config);
    }
    result
}

fn sync_once_inner(app: &AppHandle) -> Result<SyncResult, String> {
    let sync = app.state::<SyncState>();
    let config = sync.config();
    if config.host.trim().is_empty() {
        return Err("请先填写主机地址".into());
    }
    if !valid_token(&config.token) {
        return Err("配对码必须是 6 位数字".into());
    }
    let local_data = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store.data.clone()
    };
    let (remote_data, remote_device) =
        client_sync(&config.host, config.port, &config.token, &local_data)?;
    let stats = {
        let state = app.state::<AppState>();
        let mut store = state.store.lock().unwrap();
        store.merge_additive(remote_data)?
    };
    let _ = app.emit("data:changed", ());
    let synced_at = now_ms();
    let mut next = sync.config();
    next.last_sync_at = synced_at;
    next.last_error.clear();
    let _ = sync.set_config(next);
    Ok(SyncResult {
        stats,
        remote_device,
        synced_at,
    })
}

pub fn startup(app: &AppHandle) {
    let sync = app.state::<SyncState>();
    let config = sync.config();
    if config.mode == "host" {
        if let Err(error) = sync.start_host(app, &config) {
            let mut next = sync.config();
            next.last_error = format!("启动同步主机失败：{}", error);
            let _ = sync.set_config(next);
        }
    } else if config.mode == "guest" && config.auto_sync {
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(1500));
            let _ = sync_once_blocking(&app);
        });
    }
}

fn clean_host(host: &str) -> String {
    let host = host.trim();
    let host = host.strip_prefix("http://").unwrap_or(host);
    let host = host.strip_prefix("https://").unwrap_or(host);
    host.trim_end_matches('/').to_string()
}

fn split_host_port(host: &str, default_port: u16) -> (String, u16) {
    let cleaned = clean_host(host);
    if let Some((name, port)) = cleaned.rsplit_once(':') {
        if !name.is_empty() && !name.contains(':') {
            if let Ok(parsed) = port.parse::<u16>() {
                return (name.to_string(), parsed);
            }
        }
    }
    (cleaned, default_port)
}

fn client_sync(
    host: &str,
    default_port: u16,
    token: &str,
    local_data: &Value,
) -> Result<(Value, String), String> {
    let (host, port) = split_host_port(host, default_port);
    if host.is_empty() {
        return Err("主机地址为空".into());
    }
    let address = format!("{}:{}", host, port);
    let socket_address = address
        .to_socket_addrs()
        .map_err(|error| format!("无法解析主机地址 {}：{}", address, error))?
        .next()
        .ok_or_else(|| format!("无法解析主机地址 {}", address))?;
    let mut stream = TcpStream::connect_timeout(&socket_address, Duration::from_secs(5))
        .map_err(|error| format!("连接主机 {} 失败：{}", address, error))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;

    let payload = json!({
        "device": device_name(),
        "data": sync_view(local_data),
    });
    let body = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    let request = format!(
        "POST /v1/sync HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nX-Sync-Token: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        address,
        token,
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .and_then(|_| stream.flush())
        .map_err(|error| format!("发送同步请求失败：{}", error))?;

    let (status_line, _headers, response_body) = read_http_message(&mut stream)?;
    let status = parse_status(&status_line)?;
    let text = String::from_utf8_lossy(&response_body).to_string();
    let value: Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "{} 返回的不是 TimeManage 同步数据（HTTP {}）",
            address, status
        )
    })?;
    if status != 200 {
        let message = value
            .get("error")
            .and_then(|item| item.as_str())
            .unwrap_or("主机拒绝同步");
        return Err(format!("同步失败（HTTP {}）：{}", status, message));
    }
    let data = value
        .get("data")
        .cloned()
        .ok_or_else(|| "主机返回数据缺少 data 字段".to_string())?;
    if !data.is_object() {
        return Err("主机返回的数据格式不正确".into());
    }
    let remote_device = value
        .get("device")
        .and_then(|item| item.as_str())
        .unwrap_or("另一台设备")
        .to_string();
    Ok((data, remote_device))
}

fn handle_host_connection(
    app: &AppHandle,
    token: &str,
    mut stream: TcpStream,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| error.to_string())?;
    let (start_line, headers, body) = read_http_message(&mut stream)?;
    let mut parts = start_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");

    let provided = headers
        .get("x-sync-token")
        .map(String::as_str)
        .unwrap_or("");
    if provided != token {
        return write_json_response(
            &mut stream,
            401,
            &json!({ "ok": false, "error": "配对码不正确" }),
        );
    }

    match (method, path) {
        ("GET", "/v1/ping") => write_json_response(
            &mut stream,
            200,
            &json!({
                "ok": true,
                "app": APP_TAG,
                "device": device_name(),
            }),
        ),
        ("POST", "/v1/sync") => {
            let value: Value = match serde_json::from_slice(&body) {
                Ok(value) => value,
                Err(error) => {
                    return write_json_response(
                        &mut stream,
                        400,
                        &json!({ "ok": false, "error": format!("同步数据不是有效 JSON：{}", error) }),
                    )
                }
            };
            let Some(incoming) = value.get("data").cloned() else {
                return write_json_response(
                    &mut stream,
                    400,
                    &json!({ "ok": false, "error": "同步数据缺少 data 字段" }),
                );
            };
            if !incoming.is_object() {
                return write_json_response(
                    &mut stream,
                    400,
                    &json!({ "ok": false, "error": "同步数据格式不正确" }),
                );
            }
            let (stats, merged) = {
                let state = app.state::<AppState>();
                let mut store = state.store.lock().unwrap();
                match store.merge_additive(incoming) {
                    Ok(stats) => (stats, store.data.clone()),
                    Err(error) => {
                        return write_json_response(
                            &mut stream,
                            500,
                            &json!({ "ok": false, "error": format!("保存同步数据失败：{}", error) }),
                        )
                    }
                }
            };
            let _ = app.emit("data:changed", ());
            write_json_response(
                &mut stream,
                200,
                &json!({
                    "ok": true,
                    "device": device_name(),
                    "data": sync_view(&merged),
                    "stats": stats,
                }),
            )
        }
        _ => write_json_response(
            &mut stream,
            404,
            &json!({ "ok": false, "error": "未知的同步接口" }),
        ),
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn read_http_message(
    stream: &mut TcpStream,
) -> Result<(String, HashMap<String, String>, Vec<u8>), String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(position) = find_header_end(&buffer) {
            break position;
        }
        if buffer.len() > MAX_HEADER {
            return Err("HTTP 请求头过大".into());
        }
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("读取同步数据失败：{}", error))?;
        if read == 0 {
            return Err("连接在收到完整数据前关闭".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let start_line = lines.next().unwrap_or("").to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY {
        return Err("同步数据过大".into());
    }
    let mut body = buffer[header_end + 4..].to_vec();
    while body.len() < content_length {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("读取同步数据失败：{}", error))?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
        if body.len() > MAX_BODY {
            return Err("同步数据过大".into());
        }
    }
    body.truncate(content_length);
    Ok((start_line, headers, body))
}

fn parse_status(start_line: &str) -> Result<u16, String> {
    let mut parts = start_line.split_whitespace();
    let protocol = parts.next().unwrap_or("");
    if !protocol.starts_with("HTTP/") {
        return Err("主机返回了无法识别的响应".into());
    }
    parts
        .next()
        .unwrap_or("")
        .parse::<u16>()
        .map_err(|_| "主机返回了无法识别的状态码".into())
}

fn write_json_response(stream: &mut TcpStream, status: u16, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason,
        body.len()
    );
    stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .and_then(|_| stream.flush())
        .map_err(|error| format!("发送同步响应失败：{}", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_is_six_digits() {
        for _ in 0..20 {
            let token = new_token();
            assert_eq!(token.len(), 6);
            assert!(token.bytes().all(|byte| byte.is_ascii_digit()));
        }
    }

    #[test]
    fn sync_payload_excludes_ui() {
        let data = json!({
            "ui": { "pomodoroFloat": { "visible": true } },
            "sessions": [],
            "settings": { "studyMinutes": 25 }
        });
        let payload = sync_view(&data);
        assert!(payload.get("ui").is_none());
        assert_eq!(payload["settings"]["studyMinutes"], json!(25));
    }

    #[test]
    fn host_port_can_be_in_host_field() {
        assert_eq!(
            split_host_port("http://192.168.1.10:19000/", 18923),
            ("192.168.1.10".to_string(), 19000)
        );
        assert_eq!(
            split_host_port("192.168.1.10", 18923),
            ("192.168.1.10".to_string(), 18923)
        );
    }

    #[test]
    fn config_normalization_keeps_valid_token() {
        let config = normalize_config(SyncConfig {
            mode: "HOST".into(),
            port: 80,
            token: "123456".into(),
            ..Default::default()
        });
        assert_eq!(config.mode, "host");
        assert_eq!(config.port, DEFAULT_PORT);
        assert_eq!(config.token, "123456");
    }
}
