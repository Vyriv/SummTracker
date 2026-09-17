#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod champ_select;
mod focus;
mod hotkey;
mod lcu;
mod live_game;

use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State};
use tauri::tray::TrayIconBuilder;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri_plugin_autostart::ManagerExt;
use tokio::time::interval;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, Ordering};
use windows::core::{w, BOOL};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, WPARAM,
};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, EnumChildWindows,
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    GWL_EXSTYLE, GWLP_WNDPROC, HWND_TOPMOST, MA_NOACTIVATE, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE, WM_MOUSEACTIVATE,
    WS_EX_NOACTIVATE,
};

static ORIG_WND_PROC: AtomicIsize = AtomicIsize::new(0);

unsafe extern "system" fn no_activate_wnd_proc(
    hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM,
) -> LRESULT {
    if msg == WM_MOUSEACTIVATE {
        return LRESULT(MA_NOACTIVATE as isize);
    }
    let orig = ORIG_WND_PROC.load(Ordering::Relaxed);
    if orig != 0 {
        CallWindowProcW(Some(std::mem::transmute(orig)), hwnd, msg, wparam, lparam)
    } else {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

const COLLAPSED_HEIGHT: u32 = 32;
const NATURAL_WIDTH: u32 = 320;
// Layout height at 320px width before scaling (titlebar + allies + bench).
const CHAMP_SELECT_NATURAL_HEIGHT: f64 = 400.0;
const CHAMP_SELECT_WIDTH: u32 = 400;
/// UI / session refresh for champ select overlay.
const CHAMP_SELECT_UI_POLL_MS: u64 = 16;
/// Steal / queued swap / trusted trade hammer rate.
const PENDING_SWAP_POLL_MS: u64 = 8;
const TRUSTED_TRADE_POLL_MS: u64 = 8;
const SETTINGS_FILE: &str = "settings.json";
const BOUNDS_FILE: &str = "bounds.json";

// ── Shared state ──

fn debug_log(_message: &str) {
    #[cfg(debug_assertions)]
    eprintln!("[summtracker] {_message}");
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum GameState {
    Idle,
    ChampSelect,
    InGame,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Default for Bounds {
    fn default() -> Self {
        Bounds { x: -1, y: -1, width: 320, height: 600 }
    }
}

struct AppState {
    game_state: Mutex<GameState>,
    is_collapsed: Mutex<bool>,
    expanded_bounds: Mutex<Bounds>,
    natural_height: Mutex<f64>,
    settings_open: Mutex<bool>,
    latest_game_data: Mutex<Value>,
    in_champ_select: Mutex<bool>,
    auto_accept_queue: AtomicBool,
    /// Champion id to steal as soon as it unlocks. `0` means none.
    pending_bench_swap: AtomicI64,
    /// True when pending swap came from a manual bench click.
    manual_bench_swap: AtomicBool,
    /// After a manual pick/swap, stop prefer-list from swapping the player away.
    prefer_suppressed: AtomicBool,
    /// Last observed local champion id during champ select (for external swap detection).
    last_my_champion: AtomicI64,
    /// Prefer-list steal currently in flight (so we do not treat it as a manual override).
    last_prefer_steal_target: AtomicI64,
    /// Prefer-list champion ids, highest priority first.
    prefer_list: Mutex<Vec<i64>>,
    /// Last trade id auto-accepted from a trusted requester.
    last_auto_accepted_trade: AtomicI64,
    /// Fingerprint of last emitted champ-select payload (skip identical UI emits).
    last_cs_emit_key: Mutex<String>,
}

fn data_path(app: &AppHandle, file: &str) -> std::path::PathBuf {
    let dir = app.path().app_data_dir().unwrap();
    let _ = std::fs::create_dir_all(&dir);
    dir.join(file)
}

fn legacy_data_paths(app: &AppHandle, file: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Ok(current_dir) = app.path().app_data_dir() else {
        return paths;
    };
    let Some(parent) = current_dir.parent() else {
        return paths;
    };

    for legacy_dir in ["summtracker", "com.summtracker.app"] {
        let candidate = parent.join(legacy_dir).join(file);
        if candidate != current_dir.join(file) {
            paths.push(candidate);
        }
    }

    paths
}

fn read_json_file(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn migrate_file(from: &Path, to: &Path) {
    if let Some(parent) = to.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    if let Err(err) = std::fs::copy(from, to) {
        debug_log(&format!("failed to migrate {:?} -> {:?}: {}", from, to, err));
    } else {
        debug_log(&format!("migrated {:?} -> {:?}", from, to));
    }
}

fn load_bounds(app: &AppHandle) -> Bounds {
    let path = data_path(app, BOUNDS_FILE);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_bounds_to_disk(app: &AppHandle, bounds: &Bounds) {
    let path = data_path(app, BOUNDS_FILE);
    if let Ok(json) = serde_json::to_string(bounds) {
        let _ = std::fs::write(path, json);
    }
}

fn scaled_height_for(width: u32, natural_height: f64) -> u32 {
    ((natural_height * width as f64) / NATURAL_WIDTH as f64)
        .round()
        .max(COLLAPSED_HEIGHT as f64) as u32
}

fn champ_select_width(saved_width: u32) -> u32 {
    let base = saved_width.max(NATURAL_WIDTH);
    CHAMP_SELECT_WIDTH.max(base.saturating_add(80))
}

fn overlay_size(state: &AppState) -> (u32, u32) {
    let saved = state.expanded_bounds.lock().unwrap().clone();
    let natural = *state.natural_height.lock().unwrap();
    if *state.in_champ_select.lock().unwrap() {
        let width = champ_select_width(saved.width);
        (width, scaled_height_for(width, natural))
    } else {
        (saved.width, saved.height)
    }
}

fn show_without_activate(win: &tauri::WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            // Re-assert topmost + visible without activating League away from the client.
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
        return;
    }
    let _ = win.show();
}

fn place_champ_select_window(win: &tauri::WebviewWindow, mut width: u32, mut height: u32) {
    let (x, y) = if let Some(monitor) = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())
    {
        let area = monitor.work_area();
        width = width.min(area.size.width.max(1));
        height = height.min(area.size.height.max(1));
        (
            area.position.x + (area.size.width as i32 - width as i32) / 2,
            area.position.y + (area.size.height as i32 - height as i32) / 2,
        )
    } else {
        (0, 0)
    };

    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                x,
                y,
                width as i32,
                height as i32,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
        return;
    }

    let _ = win.set_size(PhysicalSize::new(width, height));
    if x != 0 || y != 0 {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    let _ = win.show();
}

/// Resize the champ-select overlay without moving it. Used for content height updates.
fn resize_champ_select_window(win: &tauri::WebviewWindow, width: u32, height: u32) {
    let (width, height) = if let Some(monitor) = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())
    {
        let area = monitor.work_area();
        (
            width.min(area.size.width.max(1)),
            height.min(area.size.height.max(1)),
        )
    } else {
        (width, height)
    };

    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                width as i32,
                height as i32,
                SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
        return;
    }

    let _ = win.set_size(PhysicalSize::new(width, height));
}

fn height_needs_update(current: u32, target: u32) -> bool {
    (current as i32 - target as i32).unsigned_abs() > 1
}

fn enter_champ_select_layout(app: &AppHandle, state: &AppState) {
    let entering = {
        let mut in_champ_select = state.in_champ_select.lock().unwrap();
        if *in_champ_select {
            false
        } else {
            *in_champ_select = true;
            true
        }
    };
    if !entering {
        return;
    }

    // Seed a conservative height until the frontend measures real content.
    {
        let mut natural = state.natural_height.lock().unwrap();
        if *natural < 100.0 || *natural > CHAMP_SELECT_NATURAL_HEIGHT * 1.5 {
            *natural = CHAMP_SELECT_NATURAL_HEIGHT;
        }
    }
    if *state.is_collapsed.lock().unwrap() {
        return;
    }
    let (width, height) = overlay_size(state);
    if let Some(win) = app.get_webview_window("main") {
        place_champ_select_window(&win, width, height);
    }
}

fn restore_saved_layout(app: &AppHandle, state: &AppState) {
    if !*state.in_champ_select.lock().unwrap() {
        return;
    }
    *state.in_champ_select.lock().unwrap() = false;
    if *state.is_collapsed.lock().unwrap() {
        return;
    }
    let saved = state.expanded_bounds.lock().unwrap().clone();
    if let Some(win) = app.get_webview_window("main") {
        if saved.x >= 0 {
            let _ = win.set_position(PhysicalPosition::new(saved.x, saved.y));
        }
        let _ = win.set_size(PhysicalSize::new(saved.width, saved.height));
    }
}

// ── Tauri commands ──

#[tauri::command]
fn load_settings(app: AppHandle) -> Value {
    let path = data_path(&app, SETTINGS_FILE);
    let result = if let Some(settings) = read_json_file(&path) {
        settings
    } else {
        let mut migrated = None;
        for legacy_path in legacy_data_paths(&app, SETTINGS_FILE) {
            if let Some(settings) = read_json_file(&legacy_path) {
                migrated = Some((legacy_path, settings));
                break;
            }
        }

        if let Some((legacy_path, settings)) = migrated {
            migrate_file(&legacy_path, &path);
            settings
        } else {
            Value::Object(Default::default())
        }
    };
    eprintln!("[settings] load from {:?} => {}", path, result);
    result
}

fn save_settings_to_disk(app: &AppHandle, settings: &Value) {
    let path = data_path(app, SETTINGS_FILE);
    eprintln!("[settings] save to {:?} => {}", path, settings);
    if let Ok(json) = serde_json::to_string(settings) {
        let _ = std::fs::write(path, json);
    }
}

fn parse_prefer_list(settings: &Value) -> Vec<i64> {
    let Some(arr) = settings.get("preferList").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for entry in arr {
        let id = entry
            .get("id")
            .and_then(json_id)
            .or_else(|| json_id(entry))
            .unwrap_or(0);
        if id > 0 && seen.insert(id) {
            out.push(id);
        }
    }
    out
}

fn json_id(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().map(|n| n as i64))
        .or_else(|| value.as_f64().map(|n| n as i64))
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .filter(|n| *n > 0)
}

fn apply_settings_state(state: &AppState, settings: &Value) {
    state.auto_accept_queue.store(
        settings
            .get("autoAcceptQueue")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        Ordering::Relaxed,
    );
    *state.prefer_list.lock().unwrap() = parse_prefer_list(settings);
}

/// Highest-priority prefer champ that is either already owned or on the bench.
fn prefer_target_id(prefer_list: &[i64], my_champion_id: i64, bench: &[i64]) -> i64 {
    for &id in prefer_list {
        if id == my_champion_id || bench.contains(&id) {
            return id;
        }
    }
    0
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<Arc<AppState>>, settings: Value) {
    apply_settings_state(state.as_ref(), &settings);
    save_settings_to_disk(&app, &settings);
}

#[tauri::command]
fn close_prefer_list_window(app: AppHandle) {
    if let Some(existing) = app.get_webview_window("prefer-list") {
        let _ = existing.close();
    }
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    if enabled {
        al.enable().map_err(|e| e.to_string())?;
    } else {
        al.disable().map_err(|e| e.to_string())?;
    }
    Ok(al.is_enabled().unwrap_or(enabled))
}

#[tauri::command]
fn get_latest_game_data(state: State<Arc<AppState>>) -> Value {
    let snapshot = state.latest_game_data.lock().unwrap().clone();
    debug_log(&format!("get_latest_game_data -> {}", snapshot["state"].as_str().unwrap_or("unknown")));
    snapshot
}

fn perform_toggle_collapse(app: &AppHandle, state: &AppState) {
    let Some(win) = app.get_webview_window("main") else { return };

    let is_collapsed = {
        let mut collapsed = state.is_collapsed.lock().unwrap();
        *collapsed = !*collapsed;
        *collapsed
    };

    if is_collapsed {
        if let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) {
            if !*state.in_champ_select.lock().unwrap() {
                let bounds = Bounds { x: pos.x, y: pos.y, width: size.width, height: size.height };
                *state.expanded_bounds.lock().unwrap() = bounds.clone();
                save_bounds_to_disk(app, &bounds);
            } else {
                let mut saved = state.expanded_bounds.lock().unwrap();
                saved.x = pos.x;
                saved.y = pos.y;
                save_bounds_to_disk(app, &saved);
            }
            let _ = win.set_size(PhysicalSize::new(size.width, COLLAPSED_HEIGHT));
        } else {
            let (width, _) = overlay_size(state);
            let _ = win.set_size(PhysicalSize::new(width, COLLAPSED_HEIGHT));
        }
    } else {
        let (width, height) = overlay_size(state);
        let _ = win.set_size(PhysicalSize::new(width, height));
    }

    let _ = app.emit("sync-collapse", is_collapsed);
}

#[tauri::command]
fn toggle_collapse(app: AppHandle, state: State<Arc<AppState>>) {
    perform_toggle_collapse(&app, state.as_ref());
}

#[tauri::command]
fn set_focusable(
    app: AppHandle,
    state: State<Arc<AppState>>,
    focusable: bool,
    steal_focus: Option<bool>,
) {
    let was_focusable = *state.settings_open.lock().unwrap();
    *state.settings_open.lock().unwrap() = focusable;
    // Collapse bind stays enabled during champ select; only mute it while settings are open.
    hotkey::set_settings_open(steal_focus.unwrap_or(false));
    let win = app.get_webview_window("main").unwrap();
    if let Ok(hwnd) = win.hwnd() {
        if !focusable && ORIG_WND_PROC.load(Ordering::Relaxed) == 0 {
            install_no_activate_hook(hwnd);
        }
        apply_no_activate(hwnd, !focusable);
    }
    // Champ select polls every 250ms. Only steal focus when requested (settings) or first open.
    if focusable && steal_focus.unwrap_or(!was_focusable) {
        let _ = win.set_focus();
    }
}

fn install_no_activate_hook(hwnd: HWND) {
    unsafe {
        let orig = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        ORIG_WND_PROC.store(orig, Ordering::Relaxed);
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC, no_activate_wnd_proc as isize);
    }
}

unsafe extern "system" fn set_child_no_activate(child: HWND, _: LPARAM) -> BOOL {
    let ex = GetWindowLongPtrW(child, GWL_EXSTYLE);
    SetWindowLongPtrW(child, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize);
    BOOL(1)
}

unsafe extern "system" fn clear_child_no_activate(child: HWND, _: LPARAM) -> BOOL {
    let ex = GetWindowLongPtrW(child, GWL_EXSTYLE);
    SetWindowLongPtrW(child, GWL_EXSTYLE, ex & !(WS_EX_NOACTIVATE.0 as isize));
    BOOL(1)
}

fn apply_no_activate(hwnd: HWND, no_activate: bool) {
    unsafe {
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let new_style = if no_activate {
            ex_style | WS_EX_NOACTIVATE.0 as isize
        } else {
            ex_style & !(WS_EX_NOACTIVATE.0 as isize)
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
        let child_proc: unsafe extern "system" fn(HWND, LPARAM) -> BOOL = if no_activate {
            set_child_no_activate
        } else {
            clear_child_no_activate
        };
        let _ = EnumChildWindows(Some(hwnd), Some(child_proc), LPARAM(0));
    }
}

#[tauri::command]
fn set_natural_height(app: AppHandle, state: State<Arc<AppState>>, height: f64) {
    if *state.is_collapsed.lock().unwrap() { return; }
    if height <= 0.0 { return; }

    let previous_natural = *state.natural_height.lock().unwrap();
    // Ignore tiny measurement jitter that would otherwise thrash the window size.
    if (previous_natural - height).abs() < 0.5 {
        return;
    }
    *state.natural_height.lock().unwrap() = height;

    let win = app.get_webview_window("main").unwrap();
    let Ok(size) = win.inner_size() else { return };
    let w = size.width;
    let h = scaled_height_for(w, height);

    if *state.in_champ_select.lock().unwrap() {
        if height_needs_update(size.height, h) {
            // Keep the user's position. Only the enter path recenters once.
            resize_champ_select_window(&win, w, h);
        }
        return;
    }

    if height_needs_update(size.height, h) {
        let _ = win.set_size(PhysicalSize::new(w, h));
    }

    let previous = state.expanded_bounds.lock().unwrap().clone();
    let pos = win.outer_position().ok();
    let bounds = Bounds {
        x: pos.map(|p| p.x).unwrap_or(previous.x),
        y: pos.map(|p| p.y).unwrap_or(previous.y),
        width: w,
        height: h,
    };
    *state.expanded_bounds.lock().unwrap() = bounds.clone();
    save_bounds_to_disk(&app, &bounds);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn apply_collapse_bind(bind: Option<Value>) {
    let parsed = bind.as_ref().and_then(hotkey::bind_from_json);
    debug_log(&format!("collapse bind {:?}", parsed));
    hotkey::set_bind(parsed);
}

#[tauri::command]
fn update_collapse_bind(bind: Option<Value>) {
    apply_collapse_bind(bind);
}

#[tauri::command]
fn set_pending_bench_swap(state: State<Arc<AppState>>, champion_id: Option<i64>) {
    let id = champion_id.filter(|id| *id > 0).unwrap_or(0);
    state.pending_bench_swap.store(id, Ordering::Relaxed);
    state.manual_bench_swap.store(id > 0, Ordering::Relaxed);
    if id > 0 {
        // Any manual bench click means the player took over; stop prefer-list for this CS.
        state.prefer_suppressed.store(true, Ordering::Relaxed);
        state.last_prefer_steal_target.store(0, Ordering::Relaxed);
    }
    debug_log(&format!("pending bench swap -> {id} (manual={})", id > 0));
}

#[tauri::command]
fn suppress_prefer_list(state: State<Arc<AppState>>, champion_id: Option<i64>) {
    let id = champion_id.filter(|id| *id > 0).unwrap_or(0);
    state.prefer_suppressed.store(true, Ordering::Relaxed);
    state.last_prefer_steal_target.store(0, Ordering::Relaxed);
    // Drop any prefer-driven pending swap so it cannot override a manual pick.
    if !state.manual_bench_swap.load(Ordering::Relaxed) {
        state.pending_bench_swap.store(0, Ordering::Relaxed);
    }
    debug_log(&format!(
        "prefer list suppressed for this champ select (manual champ={id})"
    ));
}

fn clear_pending_bench_swap(state: &AppState) {
    state.pending_bench_swap.store(0, Ordering::Relaxed);
    state.manual_bench_swap.store(false, Ordering::Relaxed);
}

fn clear_champ_select_swap_state(state: &AppState) {
    clear_pending_bench_swap(state);
    state.prefer_suppressed.store(false, Ordering::Relaxed);
    state.last_my_champion.store(0, Ordering::Relaxed);
    state.last_prefer_steal_target.store(0, Ordering::Relaxed);
    state.last_auto_accepted_trade.store(-1, Ordering::Relaxed);
    *state.last_cs_emit_key.lock().unwrap() = String::new();
}

fn champ_select_emit_key(payload: &Value) -> String {
    let my = payload.get("myChampionId").and_then(Value::as_i64).unwrap_or(0);
    let pick = payload.get("pickActionId").cloned().unwrap_or(Value::Null);
    let prefer = payload.get("preferTargetId").and_then(Value::as_i64).unwrap_or(0);
    let phase = payload.get("phase").and_then(Value::as_str).unwrap_or("");
    let mode = payload.get("mode").and_then(Value::as_str).unwrap_or("");
    let bench = payload
        .get("bench")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_i64)
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let cards = payload
        .get("cards")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_i64)
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let allies = payload
        .get("allies")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|a| {
                    format!(
                        "{}:{}:{}:{}:{}",
                        a.get("cellId").and_then(Value::as_i64).unwrap_or(-1),
                        a.get("championId").and_then(Value::as_i64).unwrap_or(0),
                        a.get("tradeState").and_then(Value::as_str).unwrap_or(""),
                        a.get("tradeId").and_then(Value::as_i64).unwrap_or(-1),
                        a.get("tradeKind").and_then(Value::as_str).unwrap_or(""),
                    )
                })
                .collect::<Vec<_>>()
                .join("|")
        })
        .unwrap_or_default();
    format!("{mode}|{phase}|{my}|{pick}|{prefer}|{bench}|{cards}|{allies}")
}

async fn pending_bench_swap_loop(state: Arc<AppState>) {
    loop {
        tokio::time::sleep(Duration::from_millis(PENDING_SWAP_POLL_MS)).await;
        let champion_id = state.pending_bench_swap.load(Ordering::Relaxed);
        if champion_id <= 0 {
            continue;
        }
        if *state.game_state.lock().unwrap() != GameState::ChampSelect {
            continue;
        }
        // Hammer the swap endpoint so a queued champ is taken the instant it unlocks.
        let _ = champ_select::swap_bench_inner(champion_id).await;
    }
}

/// Dedicated prefer-list steal loop so bench targets are not missed between UI polls.
async fn prefer_steal_loop(state: Arc<AppState>) {
    loop {
        tokio::time::sleep(Duration::from_millis(PENDING_SWAP_POLL_MS)).await;
        if *state.game_state.lock().unwrap() != GameState::ChampSelect {
            continue;
        }
        let Some(session) = lcu::get_champ_select_session().await else {
            continue;
        };
        let (my, bench) = champ_select::local_champion_and_bench(&session);

        // If the local champ changed to something we did not just prefer-steal,
        // the player (or League UI) overrode us. Stop prefer for this CS.
        let prev = state.last_my_champion.swap(my, Ordering::Relaxed);
        if prev > 0 && my > 0 && prev != my {
            let prefer_target = state.last_prefer_steal_target.load(Ordering::Relaxed);
            let pending = state.pending_bench_swap.load(Ordering::Relaxed);
            let our_steal = my == prefer_target || my == pending;
            if our_steal {
                state.last_prefer_steal_target.store(0, Ordering::Relaxed);
            } else {
                state.prefer_suppressed.store(true, Ordering::Relaxed);
                state.last_prefer_steal_target.store(0, Ordering::Relaxed);
                if !state.manual_bench_swap.load(Ordering::Relaxed) {
                    state.pending_bench_swap.store(0, Ordering::Relaxed);
                }
                debug_log(&format!(
                    "prefer suppressed after local champ changed {prev} -> {my}"
                ));
            }
        }

        if state.prefer_suppressed.load(Ordering::Relaxed)
            || state.manual_bench_swap.load(Ordering::Relaxed)
        {
            continue;
        }
        let prefer = state.prefer_list.lock().unwrap().clone();
        if prefer.is_empty() {
            continue;
        }
        let target = prefer_target_id(&prefer, my, &bench);
        if target <= 0 || target == my {
            continue;
        }
        state.last_prefer_steal_target.store(target, Ordering::Relaxed);
        state.pending_bench_swap.store(target, Ordering::Relaxed);
        let _ = champ_select::swap_bench_inner(target).await;
    }
}

/// Dedicated fast path so trusted trade accepts are not stuck behind UI payload work.
async fn trusted_trade_accept_loop(state: Arc<AppState>) {
    loop {
        tokio::time::sleep(Duration::from_millis(TRUSTED_TRADE_POLL_MS)).await;
        // Keep polling whenever the client is in champ select, even if our state
        // flag briefly lags behind.
        let in_cs = *state.game_state.lock().unwrap() == GameState::ChampSelect;
        let session = if in_cs {
            lcu::get_champ_select_session().await
        } else if lcu::is_client_running() {
            // Catch the first moments of CS before game_loop flips state.
            lcu::get_champ_select_session().await.filter(|s| champ_select::is_swap_session(s))
        } else {
            None
        };
        let Some(session) = session else {
            continue;
        };
        champ_select::auto_accept_trusted_trades(&session, &state.last_auto_accepted_trade).await;
    }
}

// ── Game state helpers ──

fn dd_key_from_raw(raw: &str, fallback: &str) -> String {
    if let Some(suffix) = raw.strip_prefix("game_character_displayname_") {
        return suffix.to_string();
    }
    fallback.replace(['\'', ' ', '.'], "")
}

fn ult_level_from_champ_level(champ_level: u64) -> u64 {
    if champ_level >= 16 { 3 }
    else if champ_level >= 11 { 2 }
    else if champ_level >= 6 { 1 }
    else { 0 }
}

fn first_numeric(values: &[Option<&Value>]) -> Option<i64> {
    for v in values {
        if let Some(v) = v {
            if let Some(n) = v.as_i64() {
                if n > 0 { return Some(n); }
            }
            if let Some(s) = v.as_str() {
                if let Ok(n) = s.parse::<i64>() {
                    if n > 0 { return Some(n); }
                }
            }
        }
    }
    None
}

fn classify_queue_id(id: i64) -> Option<&'static str> {
    match id {
        450 | 930 | 1010 | 2400..=2409 => Some("aram"),
        1700..=1799 => Some("arena"),
        400 | 420 | 430 | 440 => Some("draft"),
        _ => None,
    }
}

fn classify_text(text: &str) -> Option<&'static str> {
    let t = text.to_lowercase();
    if t.contains("aram") || t.contains("howling abyss") { return Some("aram"); }
    if t.contains("arena") || t.contains("cherry") { return Some("arena"); }
    if t.contains("swiftplay") || t.contains("swift play") { return Some("swift"); }
    if t.contains("draft") || t.contains("ranked") || t.contains("summoner") { return Some("draft"); }
    None
}

fn detect_game_mode(gameflow: Option<&Value>, live: Option<&Value>) -> &'static str {
    let session = gameflow;

    // Try queue ID from gameflow
    if let Some(s) = session {
        let qid = first_numeric(&[
            s.get("queueId"),
            s.pointer("/gameData/queue/id"),
            s.pointer("/gameData/queue/queueId"),
        ]);
        if let Some(id) = qid {
            if let Some(m) = classify_queue_id(id) { return m; }
        }

        // Try text from gameflow
        let texts = [
            s.pointer("/gameData/queue/name").and_then(|v| v.as_str()).unwrap_or(""),
            s.pointer("/gameData/queue/type").and_then(|v| v.as_str()).unwrap_or(""),
            s.pointer("/gameData/queue/description").and_then(|v| v.as_str()).unwrap_or(""),
            s.pointer("/map/name").and_then(|v| v.as_str()).unwrap_or(""),
        ];
        let combined = texts.join(" ");
        if let Some(m) = classify_text(&combined) { return m; }
    }

    // Try live game data
    if let Some(l) = live {
        let qid = first_numeric(&[
            l.pointer("/gameData/queueId"),
            l.pointer("/gameData/gameQueueConfigId"),
            l.get("queueId"),
        ]);
        if let Some(id) = qid {
            if let Some(m) = classify_queue_id(id) { return m; }
        }

        let texts = [
            l.pointer("/gameData/gameMode").and_then(|v| v.as_str()).unwrap_or(""),
            l.pointer("/gameData/mapName").and_then(|v| v.as_str()).unwrap_or(""),
        ];
        let combined = texts.join(" ");
        if let Some(m) = classify_text(&combined) { return m; }

        let map_id = first_numeric(&[
            l.pointer("/gameData/mapNumber"),
            l.pointer("/gameData/mapId"),
        ]);
        if map_id == Some(12) { return "aram"; }
    }

    "unknown"
}

fn build_player_payload(players: &Value, gameflow: Option<&Value>, live: Option<&Value>) -> Value {
    let mode = detect_game_mode(gameflow, live);
    let arr = players.as_array().cloned().unwrap_or_default();

    let mapped: Vec<Value> = arr.iter().map(|p| {
        let champ = p["championName"].as_str().unwrap_or("").to_string();
        let raw_champ = p["rawChampionName"].as_str().unwrap_or("");
        let dd_key = dd_key_from_raw(raw_champ, &champ);


        // Extract spell IDs from raw display name
        let spell1_id = extract_spell_id(
            p["summonerSpells"]["summonerSpellOne"]["rawDisplayName"].as_str().unwrap_or("")
        );
        let spell2_id = extract_spell_id(
            p["summonerSpells"]["summonerSpellTwo"]["rawDisplayName"].as_str().unwrap_or("")
        );

        let level = p["level"].as_u64().unwrap_or(1);
        let ult_level = ult_level_from_champ_level(level);
        let items = p["items"].clone();

        serde_json::json!({
            "summonerName": p["summonerName"].as_str().unwrap_or(""),
            "riotIdGameName": p["riotIdGameName"].as_str().unwrap_or(""),
            "playerId": normalize_player_id(p),
            "championName": champ,
            "ddKey": dd_key,
            "team": p["team"].as_str().unwrap_or(""),
            "spell1Id": spell1_id,
            "spell2Id": spell2_id,
            "champLevel": level,
            "ultLevel": ult_level,
            "items": items,
            "mode": mode,
        })
    }).collect();

    serde_json::json!(mapped)
}

fn extract_spell_id(raw: &str) -> String {
    // Raw format: "GeneratedTip_SummonerSpell_SummonerFlash_DisplayName"
    raw.split("SummonerSpell_")
        .nth(1)
        .and_then(|s| s.strip_suffix("_DisplayName"))
        .unwrap_or("SummonerFlash")
        .to_string()
}

fn normalize_player_id(p: &Value) -> String {
    format!(
        "{}|{}",
        p["riotIdGameName"].as_str().unwrap_or(""),
        p["summonerName"].as_str().unwrap_or("")
    ).to_lowercase()
}

fn hash_player_ids(ids: &[String]) -> Option<String> {
    use sha2::{Digest, Sha256};

    if ids.is_empty() {
        return None;
    }
    let mut sorted = ids.to_vec();
    sorted.sort();
    let input = sorted.join("||");
    let hash = Sha256::digest(input.as_bytes());
    Some(hex::encode(&hash[..12])) // 24 hex chars
}

fn compute_room_id(players: &[Value], own_team: &str) -> Option<String> {
    let allies: Vec<String> = players.iter()
        .filter(|p| p["team"].as_str().unwrap_or("") == own_team)
        .map(|p| normalize_player_id(p))
        .filter(|s| !s.is_empty())
        .collect();

    if allies.len() != 5 { return None; }
    hash_player_ids(&allies)
}

fn compute_match_id(players: &[Value]) -> Option<String> {
    let ids: Vec<String> = players.iter()
        .map(|p| normalize_player_id(p))
        .filter(|s| !s.is_empty())
        .collect();

    // Need a full lobby so both teams derive the same match room.
    if ids.len() < 10 { return None; }
    hash_player_ids(&ids)
}

fn resolve_local_player_id(players: &[Value], active: Option<&Value>) -> Option<String> {
    let active = active?;
    let active_name = active["summonerName"].as_str()
        .or_else(|| active["riotId"].as_str())
        .unwrap_or("")
        .trim();
    if active_name.is_empty() {
        return None;
    }

    players.iter().find_map(|p| {
        let sn = p["summonerName"].as_str().unwrap_or("");
        let rn = p["riotIdGameName"].as_str().unwrap_or("");
        let matched = sn == active_name
            || rn == active_name
            || sn.split('#').next() == active_name.split('#').next()
            || rn == active_name.split('#').next().unwrap_or("");
        if matched {
            let id = normalize_player_id(p);
            if id.is_empty() || id == "|" { None } else { Some(id) }
        } else {
            None
        }
    })
}

fn gameflow_phase(gameflow: Option<&Value>) -> &str {
    gameflow
        .and_then(|g| g.get("phase").and_then(Value::as_str))
        .unwrap_or("")
}

fn ready_check_in_progress(ready: Option<&Value>) -> bool {
    ready
        .and_then(|r| r.get("state").and_then(Value::as_str))
        .map(|s| s.eq_ignore_ascii_case("InProgress"))
        .unwrap_or(false)
}

fn ready_check_already_accepted(ready: Option<&Value>) -> bool {
    ready
        .and_then(|r| r.get("playerResponse").and_then(Value::as_str))
        .map(|s| s.eq_ignore_ascii_case("Accepted"))
        .unwrap_or(false)
}

async fn try_auto_accept_ready_check(state: &AppState, phase: &str) -> bool {
    if !state.auto_accept_queue.load(Ordering::Relaxed) {
        return false;
    }

    let ready = lcu::get_ready_check().await;
    let in_progress = ready_check_in_progress(ready.as_ref())
        || phase.eq_ignore_ascii_case("ReadyCheck");
    if !in_progress {
        return false;
    }
    if ready_check_already_accepted(ready.as_ref()) {
        return true;
    }

    match lcu::accept_ready_check().await {
        Ok(()) => {
            debug_log("automatically accepted ready check");
            true
        }
        Err(err) => {
            // Always log accept failures so release builds are diagnosable.
            eprintln!("[summtracker] auto accept ready check failed: {err}");
            false
        }
    }
}

// ── Game polling loop ──

async fn game_loop(app: AppHandle, state: Arc<AppState>) {
    let mut delay = Duration::from_millis(400);

    loop {
        tokio::time::sleep(delay).await;

        // Champ-select hot path: session only. Prefer/trade/swap loops run separately at 8ms.
        if *state.game_state.lock().unwrap() == GameState::ChampSelect {
            if !lcu::is_client_running() {
                clear_champ_select_swap_state(&state);
                restore_saved_layout(&app, &state);
                *state.game_state.lock().unwrap() = GameState::Idle;
                *state.latest_game_data.lock().unwrap() = serde_json::json!({ "state": "idle" });
                let win = app.get_webview_window("main").unwrap();
                let _ = win.hide();
                let _ = app.emit("game-data", serde_json::json!({ "state": "idle" }));
                delay = Duration::from_secs(3);
                continue;
            }

            match lcu::get_champ_select_session().await {
                Some(s) if champ_select::is_swap_session(&s) => {
                    let my_now = champ_select::local_champion_and_bench(&s).0;
                    let (pickable, subset) = if my_now <= 0 {
                        tokio::join!(
                            lcu::get_pickable_champions(),
                            lcu::get_subset_champion_list(),
                        )
                    } else {
                        (None, None)
                    };
                    let mut payload = champ_select::build_payload(&s, None, pickable.as_ref(), subset.as_ref());
                    let prefer = state.prefer_list.lock().unwrap().clone();
                    let my = payload
                        .get("myChampionId")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    let bench: Vec<i64> = payload
                        .get("bench")
                        .and_then(Value::as_array)
                        .map(|arr| {
                            arr.iter()
                                .filter_map(Value::as_i64)
                                .filter(|id| *id > 0)
                                .collect()
                        })
                        .unwrap_or_default();
                    let prefer_target = if state.prefer_suppressed.load(Ordering::Relaxed)
                        || state.manual_bench_swap.load(Ordering::Relaxed)
                    {
                        0
                    } else {
                        prefer_target_id(&prefer, my, &bench)
                    };
                    if let Some(obj) = payload.as_object_mut() {
                        obj.insert("preferTargetId".into(), serde_json::json!(prefer_target));
                    }
                    let pending = state.pending_bench_swap.load(Ordering::Relaxed);
                    if pending > 0 && my == pending {
                        clear_pending_bench_swap(&state);
                    }

                    let key = champ_select_emit_key(&payload);
                    let should_emit = {
                        let mut last = state.last_cs_emit_key.lock().unwrap();
                        if *last != key {
                            *last = key;
                            true
                        } else {
                            false
                        }
                    };
                    *state.latest_game_data.lock().unwrap() = payload.clone();
                    if should_emit {
                        let _ = app.emit("game-data", payload);
                    }
                    delay = Duration::from_millis(CHAMP_SELECT_UI_POLL_MS);
                    continue;
                }
                Some(_) => {
                    debug_log("non-bench champ select -> idle overlay");
                    restore_saved_layout(&app, &state);
                    clear_champ_select_swap_state(&state);
                    *state.game_state.lock().unwrap() = GameState::Idle;
                    *state.latest_game_data.lock().unwrap() = serde_json::json!({ "state": "idle" });
                    let win = app.get_webview_window("main").unwrap();
                    let _ = win.hide();
                    let _ = app.emit("game-data", serde_json::json!({ "state": "idle" }));
                    delay = Duration::from_millis(400);
                    continue;
                }
                None => {
                    debug_log("champ select ended -> idle");
                    clear_champ_select_swap_state(&state);
                    restore_saved_layout(&app, &state);
                    *state.game_state.lock().unwrap() = GameState::Idle;
                    *state.latest_game_data.lock().unwrap() = serde_json::json!({ "state": "idle" });
                    let win = app.get_webview_window("main").unwrap();
                    let _ = win.hide();
                    let _ = app.emit("game-data", serde_json::json!({ "state": "idle" }));
                    delay = Duration::from_millis(400);
                    continue;
                }
            }
        }

        let lcu_running = lcu::is_client_running();
        let (live_up, gameflow_quick) = tokio::join!(
            live_game::is_game_running(),
            async {
                if lcu_running {
                    lcu::get_gameflow_session().await
                } else {
                    None
                }
            },
        );
        // Live client can still answer briefly while the client is in champ select.
        // Prefer LCU phase so ARAM select is never skipped.
        let phase = gameflow_phase(gameflow_quick.as_ref()).to_string();
        let queue_hot = lcu_running
            && (phase.eq_ignore_ascii_case("ReadyCheck")
                || phase.eq_ignore_ascii_case("Matchmaking"));
        if lcu_running {
            let _ = try_auto_accept_ready_check(&state, &phase).await;
        }
        let in_client_champ_select = phase.eq_ignore_ascii_case("ChampSelect");
        let game_running = live_up && !in_client_champ_select;
        let current_state = state.game_state.lock().unwrap().clone();
        debug_log(&format!(
            "poll tick: current_state={:?} live_game_running={} phase={} lcu_running={} auto_accept={}",
            current_state,
            game_running,
            phase,
            lcu_running,
            state.auto_accept_queue.load(Ordering::Relaxed),
        ));

        if game_running && current_state != GameState::InGame {
            let (players_res, gameflow_res, live_res) = tokio::join!(
                live_game::get_all_players(),
                async { gameflow_quick.clone() },
                live_game::get_all_game_data(),
            );

            if let Err(err) = &players_res {
                debug_log(&format!("failed to load live players: {}", err));
            }
            if gameflow_res.is_none() {
                debug_log("gameflow session unavailable while entering in-game");
            }
            if let Err(err) = &live_res {
                debug_log(&format!("failed to load allgamedata: {}", err));
            }

            let Ok(players) = players_res else { continue };
            let gameflow = gameflow_res;
            let live = live_res.ok();

            let mode = detect_game_mode(gameflow.as_ref(), live.as_ref());
            let payload = build_player_payload(&players, gameflow.as_ref(), live.as_ref());
            debug_log(&format!(
                "entering in-game: players={} mode={}",
                players.as_array().map(|arr| arr.len()).unwrap_or(0),
                mode,
            ));

            // Determine own team and local player identity
            let active_player = live_game::get_active_player().await.ok();
            let own_team = if let Some(active) = active_player.as_ref() {
                let active_name = active["summonerName"].as_str()
                    .or_else(|| active["riotId"].as_str())
                    .unwrap_or("")
                    .to_string();

                players.as_array()
                    .and_then(|arr| arr.iter().find(|p| {
                        let sn = p["summonerName"].as_str().unwrap_or("");
                        let rn = p["riotIdGameName"].as_str().unwrap_or("");
                        sn == active_name
                            || rn == active_name
                            || sn.split('#').next() == active_name.split('#').next()
                            || rn == active_name.split('#').next().unwrap_or("")
                    }))
                    .and_then(|p| p["team"].as_str())
                    .unwrap_or("")
                    .to_string()
            } else {
                String::new()
            };

            let players_arr = players.as_array().cloned().unwrap_or_default();
            let local_player_id = resolve_local_player_id(players_arr.as_slice(), active_player.as_ref());

            // Compute room IDs for cooldown sync (allies) and presence (full match)
            let room_id = if !own_team.is_empty() {
                compute_room_id(&players_arr, &own_team)
            } else {
                None
            };
            let match_id = compute_match_id(&players_arr)
                .or_else(|| room_id.clone());
            debug_log(&format!(
                "own_team='{}' room_id={:?} match_id={:?} local_player_id={:?}",
                own_team, room_id, match_id, local_player_id
            ));

            restore_saved_layout(&app, &state);
            clear_champ_select_swap_state(&state);
            *state.game_state.lock().unwrap() = GameState::InGame;
            let game_data = serde_json::json!({
                "state": "in-game",
                "players": payload,
                "ownTeam": own_team,
                "mode": mode,
                "roomId": room_id,
                "matchId": match_id,
                "localPlayerId": local_player_id,
            });
            *state.latest_game_data.lock().unwrap() = game_data.clone();

            let win = app.get_webview_window("main").unwrap();
            let _ = win.show();
            if let Some(prefer) = app.get_webview_window("prefer-list") {
                let _ = prefer.close();
            }

            let _ = app.emit("game-data", game_data);

            // Start level polling as a separate task
            let app2 = app.clone();
            let state2 = Arc::clone(&state);
            let initial_players = players.clone();
            tauri::async_runtime::spawn(async move {
                level_poll_loop(app2, state2, initial_players).await;
            });

            // Start window focus lock
            let app3 = app.clone();
            let state3 = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                window_lock_loop(app3, state3).await;
            });

            continue;
        }

        if !game_running && current_state == GameState::InGame {
            debug_log("leaving in-game -> idle");
            restore_saved_layout(&app, &state);
            *state.game_state.lock().unwrap() = GameState::Idle;
            *state.latest_game_data.lock().unwrap() = serde_json::json!({ "state": "idle" });
            let win = app.get_webview_window("main").unwrap();
            let _ = win.hide();
            let _ = app.emit("game-data", serde_json::json!({ "state": "idle" }));
            continue;
        }

        if !game_running && current_state != GameState::InGame {
            if !lcu_running {
                if current_state != GameState::Idle {
                    debug_log("league client not running -> idle");
                    restore_saved_layout(&app, &state);
                    *state.game_state.lock().unwrap() = GameState::Idle;
                    *state.latest_game_data.lock().unwrap() = serde_json::json!({ "state": "idle" });
                    let win = app.get_webview_window("main").unwrap();
                    let _ = win.hide();
                    let _ = app.emit("game-data", serde_json::json!({ "state": "idle" }));
                }
                delay = Duration::from_secs(3);
                continue;
            }

            let session = lcu::get_champ_select_session().await;
            debug_log(&format!(
                "champ-select probe: found_session={} current_state={:?} phase={}",
                session.is_some(),
                current_state,
                phase,
            ));
            if let (Some(s), GameState::Idle) = (session, current_state) {
                if !champ_select::is_swap_session(&s) {
                    delay = Duration::from_millis(400);
                    continue;
                }

                let my_now = champ_select::local_champion_and_bench(&s).0;
                let (pickable, subset) = if my_now <= 0 {
                    tokio::join!(
                        lcu::get_pickable_champions(),
                        lcu::get_subset_champion_list(),
                    )
                } else {
                    (None, None)
                };
                let mut payload = champ_select::build_payload(
                    &s,
                    gameflow_quick.as_ref(),
                    pickable.as_ref(),
                    subset.as_ref(),
                );
                let prefer = state.prefer_list.lock().unwrap().clone();
                let my = payload
                    .get("myChampionId")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let bench: Vec<i64> = payload
                    .get("bench")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_i64)
                            .filter(|id| *id > 0)
                            .collect()
                    })
                    .unwrap_or_default();
                let prefer_target = if state.prefer_suppressed.load(Ordering::Relaxed)
                    || state.manual_bench_swap.load(Ordering::Relaxed)
                {
                    0
                } else {
                    prefer_target_id(&prefer, my, &bench)
                };
                if let Some(obj) = payload.as_object_mut() {
                    obj.insert("preferTargetId".into(), serde_json::json!(prefer_target));
                }
                let key = champ_select_emit_key(&payload);
                *state.last_cs_emit_key.lock().unwrap() = key;
                debug_log("entering ARAM champ select");
                enter_champ_select_layout(&app, &state);
                *state.game_state.lock().unwrap() = GameState::ChampSelect;
                *state.latest_game_data.lock().unwrap() = payload.clone();
                let win = app.get_webview_window("main").unwrap();
                show_without_activate(&win);
                let _ = app.emit("game-data", payload);
                delay = Duration::from_millis(CHAMP_SELECT_UI_POLL_MS);
                continue;
            }
        }

        delay = match *state.game_state.lock().unwrap() {
            GameState::ChampSelect => Duration::from_millis(CHAMP_SELECT_UI_POLL_MS),
            GameState::InGame => Duration::from_secs(3),
            GameState::Idle => {
                if queue_hot && state.auto_accept_queue.load(Ordering::Relaxed) {
                    Duration::from_millis(100)
                } else if lcu_running {
                    Duration::from_millis(400)
                } else {
                    Duration::from_secs(3)
                }
            }
        };
    }
}

async fn level_poll_loop(app: AppHandle, state: Arc<AppState>, initial: Value) {
    let mut ticker = interval(Duration::from_secs(5));
    let arr = initial.as_array().cloned().unwrap_or_default();
    let mut last_ult_levels: Vec<u64> = arr.iter()
        .map(|p| p["ultLevel"].as_u64().unwrap_or(0))
        .collect();
    let mut last_sigs: Vec<String> = arr.iter()
        .map(|p| format!("{:?}{:?}", p["spell1Id"], p["spell2Id"]))
        .collect();

    loop {
        ticker.tick().await;

        if *state.game_state.lock().unwrap() != GameState::InGame {
            break;
        }

        let (players_res, gameflow, live) = tokio::join!(
            live_game::get_all_players(),
            lcu::get_gameflow_session(),
            live_game::get_all_game_data(),
        );

        let Ok(players) = players_res else { continue };
        let arr = players.as_array().cloned().unwrap_or_default();
        let mode = detect_game_mode(gameflow.as_ref(), live.ok().as_ref());

        let mut level_updates: Vec<Value> = Vec::new();
        let mut cooldown_updates: Vec<Value> = Vec::new();

        for (i, p) in arr.iter().enumerate() {
            let level = p["level"].as_u64().unwrap_or(1);
            let ult_level = ult_level_from_champ_level(level);
            let spell1_id = extract_spell_id(
                p["summonerSpells"]["summonerSpellOne"]["rawDisplayName"].as_str().unwrap_or("")
            );
            let spell2_id = extract_spell_id(
                p["summonerSpells"]["summonerSpellTwo"]["rawDisplayName"].as_str().unwrap_or("")
            );
            let sig = format!("{}{}{}", spell1_id, spell2_id, mode);
            let items = &p["items"];

            if i >= last_ult_levels.len() {
                last_ult_levels.push(0);
            }
            if i >= last_sigs.len() {
                last_sigs.push(String::new());
            }

            if ult_level != last_ult_levels[i] {
                last_ult_levels[i] = ult_level;
                level_updates.push(serde_json::json!({
                    "playerIndex": i,
                    "champLevel": level,
                    "ultLevel": ult_level,
                }));
            }

            if sig != last_sigs[i] {
                last_sigs[i] = sig;
                cooldown_updates.push(serde_json::json!({
                    "playerIndex": i,
                    "spell1Id": spell1_id,
                    "spell2Id": spell2_id,
                    "championName": p["championName"].as_str().unwrap_or(""),
                    "items": items,
                    "mode": mode,
                }));
            }
        }

        if !level_updates.is_empty() {
            let _ = app.emit("player-levels", &level_updates);
        }
        if !cooldown_updates.is_empty() {
            let _ = app.emit("player-cooldowns", &cooldown_updates);
        }
    }
}

async fn window_lock_loop(app: AppHandle, state: Arc<AppState>) {
    let mut ticker = interval(Duration::from_secs(1));

    loop {
        ticker.tick().await;

        if *state.game_state.lock().unwrap() != GameState::InGame {
            break;
        }
        if *state.settings_open.lock().unwrap() {
            continue;
        }

        let win = match app.get_webview_window("main") {
            Some(w) => w,
            None => break,
        };

        let info = focus::get_foreground_window_info();
        let is_league = info.as_ref().map(|i| focus::is_league_game_window(i)).unwrap_or(false);
        let is_ours = info.as_ref().map(|i| i.process_name.to_lowercase().contains("summtracker")).unwrap_or(false);

        if is_league || is_ours {
            if !win.is_visible().unwrap_or(true) {
                let _ = win.show();
            }
        } else if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        }
    }
}

// ── Entry point ──

fn acquire_single_instance() -> bool {
    unsafe {
        match CreateMutexW(None, true, w!("Local\\VyrivSummTrackerSingleton")) {
            Ok(handle) => {
                if GetLastError() == ERROR_ALREADY_EXISTS {
                    let _ = CloseHandle(handle);
                    false
                } else {
                    true
                }
            }
            Err(_) => true,
        }
    }
}

fn ensure_default_autostart(app: &AppHandle) {
    #[cfg(not(debug_assertions))]
    {
        let marker = data_path(app, "autostart-initialized");
        if marker.exists() {
            return;
        }
        if app.autolaunch().enable().is_ok() {
            let _ = std::fs::write(marker, "1");
        }
    }
    #[cfg(debug_assertions)]
    {
        let _ = app;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !acquire_single_instance() {
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            let bounds = load_bounds(&app.handle());
            let initial_natural_height = if bounds.width > 0 {
                (bounds.height as f64 * NATURAL_WIDTH as f64 / bounds.width as f64)
                    .max(COLLAPSED_HEIGHT as f64)
            } else {
                bounds.height.max(COLLAPSED_HEIGHT) as f64
            };

            let state = Arc::new(AppState {
                game_state: Mutex::new(GameState::Idle),
                is_collapsed: Mutex::new(false),
                expanded_bounds: Mutex::new(bounds.clone()),
                natural_height: Mutex::new(initial_natural_height),
                settings_open: Mutex::new(false),
                latest_game_data: Mutex::new(serde_json::json!({ "state": "idle" })),
                in_champ_select: Mutex::new(false),
                auto_accept_queue: AtomicBool::new(false),
                pending_bench_swap: AtomicI64::new(0),
                manual_bench_swap: AtomicBool::new(false),
                prefer_suppressed: AtomicBool::new(false),
                last_my_champion: AtomicI64::new(0),
                last_prefer_steal_target: AtomicI64::new(0),
                prefer_list: Mutex::new(Vec::new()),
                last_auto_accepted_trade: AtomicI64::new(-1),
                last_cs_emit_key: Mutex::new(String::new()),
            });

            app.manage(state.clone());
            let saved_settings = load_settings(app.handle().clone());
            apply_settings_state(state.as_ref(), &saved_settings);
            debug_log(&format!(
                "startup collapseBind={}",
                saved_settings.get("collapseBind").cloned().unwrap_or(Value::Null)
            ));
            apply_collapse_bind(saved_settings.get("collapseBind").cloned());
            ensure_default_autostart(&app.handle());
            // Kill any leftover blank prefer-list window from older builds.
            if let Some(existing) = app.handle().get_webview_window("prefer-list") {
                let _ = existing.close();
            }

            {
                let app = app.handle().clone();
                hotkey::set_on_toggle(move || {
                    let state = app.state::<Arc<AppState>>();
                    perform_toggle_collapse(&app, state.as_ref());
                });
            }
            hotkey::install();

            // Position window from saved bounds and apply no-activate so overlay never steals focus
            if let Some(win) = app.get_webview_window("main") {
                if bounds.x >= 0 {
                    let _ = win.set_position(PhysicalPosition::new(bounds.x, bounds.y));
                }
                let _ = win.set_size(PhysicalSize::new(bounds.width, bounds.height));
            }

            // System tray
            let autostart = app.autolaunch().is_enabled().unwrap_or(false);
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let launch_item = CheckMenuItemBuilder::with_id("autolaunch", "Launch on startup")
                .checked(autostart)
                .build(app)?;
            let menu = MenuBuilder::new(app).items(&[&launch_item, &quit_item]).build()?;

            let icon = tauri::image::Image::from_bytes(
                include_bytes!("../icons/tray-icon.png")
            )?;

            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("SummTracker")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "autolaunch" => {
                        let al = app.autolaunch();
                        let enabled = al.is_enabled().unwrap_or(false);
                        if enabled { let _ = al.disable(); } else { let _ = al.enable(); }
                    }
                    _ => {}
                })
                .build(app)?;

            // Window resize/move saves bounds
            let app_handle = app.handle().clone();
            let state_clone = Arc::clone(&state);
            if let Some(win) = app.get_webview_window("main") {
                win.on_window_event(move |event| {
                    if *state_clone.is_collapsed.lock().unwrap() {
                        return;
                    }

                    let win = app_handle.get_webview_window("main").unwrap();
                    let in_champ_select = *state_clone.in_champ_select.lock().unwrap();
                    match event {
                        tauri::WindowEvent::Resized(size) => {
                            if in_champ_select {
                                return;
                            }

                            let natural_height = *state_clone.natural_height.lock().unwrap();
                            let target_height = scaled_height_for(size.width, natural_height);
                            if size.height != target_height {
                                let _ = win.set_size(PhysicalSize::new(size.width, target_height));
                                return;
                            }

                            if let Ok(pos) = win.outer_position() {
                                let b = Bounds {
                                    x: pos.x,
                                    y: pos.y,
                                    width: size.width,
                                    height: target_height,
                                };
                                *state_clone.expanded_bounds.lock().unwrap() = b.clone();
                                save_bounds_to_disk(&app_handle, &b);
                            }
                        }
                        tauri::WindowEvent::Moved(pos) => {
                            if in_champ_select {
                                return;
                            }
                            let mut current = state_clone.expanded_bounds.lock().unwrap();
                            current.x = pos.x;
                            current.y = pos.y;
                            let saved = current.clone();
                            drop(current);
                            save_bounds_to_disk(&app_handle, &saved);
                        }
                        _ => {}
                    }
                });
            }

            // Start game loop
            let app_handle2 = app.handle().clone();
            let game_loop_state = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                game_loop(app_handle2, game_loop_state).await;
            });

            let pending_swap_state = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                pending_bench_swap_loop(pending_swap_state).await;
            });

            let prefer_steal_state = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                prefer_steal_loop(prefer_steal_state).await;
            });

            let trusted_trade_state = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                trusted_trade_accept_loop(trusted_trade_state).await;
            });

            let app_handle3 = app.handle().clone();
            let state_clone2 = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let snapshot = state_clone2.latest_game_data.lock().unwrap().clone();
                debug_log(&format!(
                    "startup replay emit -> {}",
                    snapshot["state"].as_str().unwrap_or("unknown")
                ));
                let _ = app_handle3.emit("game-data", snapshot);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            get_autostart,
            set_autostart,
            get_latest_game_data,
            toggle_collapse,
            set_focusable,
            set_natural_height,
            quit_app,
            update_collapse_bind,
            set_pending_bench_swap,
            suppress_prefer_list,
            close_prefer_list_window,
            champ_select::swap_bench,
            champ_select::complete_pick,
            champ_select::request_trade,
            champ_select::accept_trade,
            champ_select::decline_trade,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
