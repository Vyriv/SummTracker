#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod focus;
mod lcu;
mod live_game;

use std::sync::{Arc, Mutex};
use std::time::Duration;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State};
use tauri::tray::TrayIconBuilder;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tokio::time::interval;
use std::sync::atomic::{AtomicIsize, Ordering};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, EnumChildWindows,
    GetWindowLongPtrW, SetWindowLongPtrW,
    GWL_EXSTYLE, GWLP_WNDPROC, MA_NOACTIVATE, WM_MOUSEACTIVATE, WS_EX_NOACTIVATE,
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
const SETTINGS_FILE: &str = "settings.json";
const BOUNDS_FILE: &str = "bounds.json";

// ── Shared state ──

fn debug_log(_message: &str) {
    #[cfg(debug_assertions)]
    eprintln!("[summtracker] {_message}");
}

#[derive(Debug, Clone, PartialEq)]
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
    current_shortcut: Mutex<Option<String>>,
    latest_game_data: Mutex<Value>,
}

fn data_path(app: &AppHandle, file: &str) -> std::path::PathBuf {
    let dir = app.path().app_data_dir().unwrap();
    let _ = std::fs::create_dir_all(&dir);
    dir.join(file)
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

// ── Tauri commands ──

#[tauri::command]
fn load_settings(app: AppHandle) -> Value {
    let path = data_path(&app, SETTINGS_FILE);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Object(Default::default()))
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Value) {
    let path = data_path(&app, SETTINGS_FILE);
    if let Ok(json) = serde_json::to_string(&settings) {
        let _ = std::fs::write(path, json);
    }
}

#[tauri::command]
fn get_latest_game_data(state: State<Arc<AppState>>) -> Value {
    let snapshot = state.latest_game_data.lock().unwrap().clone();
    debug_log(&format!("get_latest_game_data -> {}", snapshot["state"].as_str().unwrap_or("unknown")));
    snapshot
}

#[tauri::command]
fn toggle_collapse(app: AppHandle, state: State<Arc<AppState>>) {
    let win = app.get_webview_window("main").unwrap();

    let (is_collapsed, bounds) = {
        let mut collapsed = state.is_collapsed.lock().unwrap();
        *collapsed = !*collapsed;
        let is_collapsed = *collapsed;
        let bounds = state.expanded_bounds.lock().unwrap().clone();
        (is_collapsed, bounds)
    }; // locks released here before any window calls

    if is_collapsed {
        let w = bounds.width;
        let _ = win.set_size(PhysicalSize::new(w, COLLAPSED_HEIGHT));
    } else {
        let _ = win.set_size(PhysicalSize::new(bounds.width, bounds.height));
    }

    let _ = app.emit("sync-collapse", is_collapsed);
}

#[tauri::command]
fn set_focusable(app: AppHandle, state: State<Arc<AppState>>, focusable: bool) {
    *state.settings_open.lock().unwrap() = focusable;
    let win = app.get_webview_window("main").unwrap();
    if let Ok(hwnd) = win.hwnd() {
        if !focusable && ORIG_WND_PROC.load(Ordering::Relaxed) == 0 {
            install_no_activate_hook(hwnd);
        }
        apply_no_activate(hwnd, !focusable);
    }
    if focusable {
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

fn apply_no_activate(hwnd: HWND, no_activate: bool) {
    unsafe {
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let new_style = if no_activate {
            ex_style | WS_EX_NOACTIVATE.0 as isize
        } else {
            ex_style & !(WS_EX_NOACTIVATE.0 as isize)
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
        EnumChildWindows(Some(hwnd), Some(set_child_no_activate), LPARAM(0));
    }
}

#[tauri::command]
fn set_natural_height(app: AppHandle, state: State<Arc<AppState>>, height: f64) {
    if *state.is_collapsed.lock().unwrap() { return; }
    *state.natural_height.lock().unwrap() = height;

    let win = app.get_webview_window("main").unwrap();
    let Ok(size) = win.inner_size() else { return };
    let w = size.width;
    let h = scaled_height_for(w, height);
    if size.height != h {
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

fn apply_collapse_bind(app: &AppHandle, state: &Arc<AppState>, bind: Option<Value>) {
    let mut current = state.current_shortcut.lock().unwrap();

    if let Some(ref accel) = *current {
        let _ = app.global_shortcut().unregister(accel.as_str());
        debug_log(&format!("unregistered collapse bind: {}", accel));
        *current = None;
    }

    let Some(bind) = bind else { return };
    let Some(accel) = bind_to_accelerator(&bind) else { return };
    debug_log(&format!("registering collapse bind: {}", accel));

    let app_clone = app.clone();
    let state_clone = Arc::clone(state);
    let accel_clone = accel.clone();

    let result = app.global_shortcut().on_shortcut(accel.as_str(), move |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let win = app_clone.get_webview_window("main").unwrap();
            let is_collapsed = {
                let mut collapsed = state_clone.is_collapsed.lock().unwrap();
                *collapsed = !*collapsed;
                *collapsed
            };

            if is_collapsed {
                if let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) {
                    let bounds = Bounds { x: pos.x, y: pos.y, width: size.width, height: size.height };
                    *state_clone.expanded_bounds.lock().unwrap() = bounds.clone();
                    save_bounds_to_disk(&app_clone, &bounds);
                    let _ = win.set_size(PhysicalSize::new(size.width, COLLAPSED_HEIGHT));
                } else {
                    let width = state_clone.expanded_bounds.lock().unwrap().width;
                    let _ = win.set_size(PhysicalSize::new(width, COLLAPSED_HEIGHT));
                }
            } else {
                let bounds = state_clone.expanded_bounds.lock().unwrap().clone();
                let _ = win.set_size(PhysicalSize::new(bounds.width, bounds.height));
            }

            let _ = app_clone.emit("sync-collapse", is_collapsed);
        }
    });

    match result {
        Ok(()) => {
            debug_log(&format!("registered collapse bind: {}", accel_clone));
            *current = Some(accel_clone);
        }
        Err(err) => {
            debug_log(&format!("failed to register collapse bind {}: {}", accel, err));
        }
    }
}

#[tauri::command]
fn update_collapse_bind(app: AppHandle, state: State<Arc<AppState>>, bind: Option<Value>) {
    let state = state.inner().clone();
    apply_collapse_bind(&app, &state, bind);
}

fn bind_to_accelerator(bind: &Value) -> Option<String> {
    let key = bind["key"].as_str()?.to_lowercase();
    let mapped = match key.as_str() {
        " "           => "Space",
        "tab"         => "Tab",
        "escape"      => "Escape",
        "esc"         => "Escape",
        "backspace"   => "Backspace",
        "delete"      => "Delete",
        "insert"      => "Insert",
        "home"        => "Home",
        "end"         => "End",
        "pageup"      => "PageUp",
        "pagedown"    => "PageDown",
        "capslock"    => "CapsLock",
        "arrowleft"   => "Left",
        "arrowright"  => "Right",
        "arrowup"     => "Up",
        "arrowdown"   => "Down",
        "enter"       => "Return",
        other         => return Some(build_accelerator(bind, other.to_uppercase().as_str())),
    };
    Some(build_accelerator(bind, mapped))
}

fn build_accelerator(bind: &Value, key: &str) -> String {
    let mut parts = Vec::new();
    if bind["ctrl"].as_bool().unwrap_or(false)  { parts.push("Control"); }
    if bind["alt"].as_bool().unwrap_or(false)   { parts.push("Alt"); }
    if bind["shift"].as_bool().unwrap_or(false) { parts.push("Shift"); }
    parts.push(key);
    parts.join("+")
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
        450 => Some("aram"),
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

fn compute_room_id(players: &[Value], own_team: &str) -> Option<String> {
    use sha2::{Digest, Sha256};

    let mut allies: Vec<String> = players.iter()
        .filter(|p| p["team"].as_str().unwrap_or("") == own_team)
        .map(|p| normalize_player_id(p))
        .filter(|s| !s.is_empty())
        .collect();

    if allies.len() != 5 { return None; }

    allies.sort();
    let input = allies.join("||");
    let hash = Sha256::digest(input.as_bytes());
    Some(hex::encode(&hash[..12])) // 24 hex chars
}

// ── Game polling loop ──

async fn game_loop(app: AppHandle, state: Arc<AppState>) {
    let mut poll = interval(Duration::from_secs(3));

    loop {
        poll.tick().await;

        let game_running = live_game::is_game_running().await;
        let current_state = state.game_state.lock().unwrap().clone();
        debug_log(&format!(
            "poll tick: current_state={:?} live_game_running={} lcu_running={}",
            current_state,
            game_running,
            lcu::is_client_running(),
        ));

        if game_running && current_state != GameState::InGame {
            let (players_res, gameflow_res, live_res) = tokio::join!(
                live_game::get_all_players(),
                lcu::get_gameflow_session(),
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

            // Determine own team
            let own_team = if let Ok(active) = live_game::get_active_player().await {
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

            // Compute room ID for sync
            let room_id = if !own_team.is_empty() {
                players.as_array()
                    .and_then(|arr| compute_room_id(arr, &own_team))
            } else {
                None
            };
            debug_log(&format!("own_team='{}' room_id={:?}", own_team, room_id));

            *state.game_state.lock().unwrap() = GameState::InGame;
            let game_data = serde_json::json!({
                "state": "in-game",
                "players": payload,
                "ownTeam": own_team,
                "mode": mode,
                "roomId": room_id,
            });
            *state.latest_game_data.lock().unwrap() = game_data.clone();

            let win = app.get_webview_window("main").unwrap();
            let _ = win.show();

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
            *state.game_state.lock().unwrap() = GameState::Idle;
            *state.latest_game_data.lock().unwrap() = serde_json::json!({ "state": "idle" });
            let win = app.get_webview_window("main").unwrap();
            let _ = win.hide();
            let _ = app.emit("game-data", serde_json::json!({ "state": "idle" }));
            continue;
        }

        if !game_running && current_state != GameState::InGame {
            if !lcu::is_client_running() {
                if current_state != GameState::Idle {
                    debug_log("league client not running -> idle");
                    *state.game_state.lock().unwrap() = GameState::Idle;
                    *state.latest_game_data.lock().unwrap() = serde_json::json!({ "state": "idle" });
                    let win = app.get_webview_window("main").unwrap();
                    let _ = win.hide();
                    let _ = app.emit("game-data", serde_json::json!({ "state": "idle" }));
                }
                continue;
            }

            let session = lcu::get_champ_select_session().await;
            debug_log(&format!(
                "champ-select probe: found_session={} current_state={:?}",
                session.is_some(),
                current_state,
            ));
            match (session, current_state) {
                (Some(s), GameState::Idle) | (Some(s), GameState::ChampSelect) => {
                    debug_log("entering/staying champ select");
                    *state.game_state.lock().unwrap() = GameState::ChampSelect;
                    *state.latest_game_data.lock().unwrap() = serde_json::json!({
                        "state": "champ-select",
                        "session": s.clone(),
                    });
                    let _ = app.emit("game-data", serde_json::json!({
                        "state": "champ-select",
                        "session": s,
                    }));
                }
                (None, GameState::ChampSelect) => {
                    debug_log("champ select ended -> idle");
                    *state.game_state.lock().unwrap() = GameState::Idle;
                    *state.latest_game_data.lock().unwrap() = serde_json::json!({ "state": "idle" });
                    let win = app.get_webview_window("main").unwrap();
                    let _ = win.hide();
                    let _ = app.emit("game-data", serde_json::json!({ "state": "idle" }));
                }
                _ => {}
            }
        }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
                current_shortcut: Mutex::new(None),
                latest_game_data: Mutex::new(serde_json::json!({ "state": "idle" })),
            });

            app.manage(state.clone());
            let saved_settings = load_settings(app.handle().clone());
            debug_log(&format!(
                "startup collapseBind={}",
                saved_settings.get("collapseBind").cloned().unwrap_or(Value::Null)
            ));
            apply_collapse_bind(&app.handle(), &state, saved_settings.get("collapseBind").cloned());

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
                    match event {
                        tauri::WindowEvent::Resized(size) => {
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
                            let current = state_clone.expanded_bounds.lock().unwrap().clone();
                            let b = Bounds {
                                x: pos.x,
                                y: pos.y,
                                width: current.width,
                                height: current.height,
                            };
                            *state_clone.expanded_bounds.lock().unwrap() = b.clone();
                            save_bounds_to_disk(&app_handle, &b);
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
            get_latest_game_data,
            toggle_collapse,
            set_focusable,
            set_natural_height,
            quit_app,
            update_collapse_bind,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
