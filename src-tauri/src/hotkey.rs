use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VkKeyScanW, VK_BACK, VK_CAPITAL, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END,
    VK_ESCAPE, VK_F1, VK_HOME, VK_INSERT, VK_LEFT, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT,
    VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, SetWindowsHookExW, KBDLLHOOKSTRUCT, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
    WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use crate::focus;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CollapseBind {
    vk: u32,
    ctrl: bool,
    alt: bool,
    shift: bool,
}

static CURRENT_BIND: Mutex<Option<CollapseBind>> = Mutex::new(None);
static SETTINGS_OPEN: AtomicBool = AtomicBool::new(false);
static HELD_VK: AtomicU32 = AtomicU32::new(0);
static PENDING_TOGGLE: AtomicBool = AtomicBool::new(false);
static WORKER_STARTED: AtomicBool = AtomicBool::new(false);
static ON_TOGGLE: Mutex<Option<Arc<dyn Fn() + Send + Sync>>> = Mutex::new(None);
static HOOK: Mutex<Option<isize>> = Mutex::new(None);

pub fn set_bind(bind: Option<CollapseBind>) {
    if let Ok(mut current) = CURRENT_BIND.lock() {
        *current = bind;
    }
}

pub fn bind_from_json(bind: &Value) -> Option<CollapseBind> {
    let key = bind["key"].as_str()?;
    Some(CollapseBind {
        vk: js_key_to_vk(key)?,
        ctrl: bind["ctrl"].as_bool().unwrap_or(false),
        alt: bind["alt"].as_bool().unwrap_or(false),
        shift: bind["shift"].as_bool().unwrap_or(false),
    })
}

pub fn set_settings_open(open: bool) {
    SETTINGS_OPEN.store(open, Ordering::Relaxed);
}

pub fn set_on_toggle(callback: impl Fn() + Send + Sync + 'static) {
    if let Ok(mut current) = ON_TOGGLE.lock() {
        *current = Some(Arc::new(callback));
    }
}

pub fn install() {
    if let Ok(hook) = HOOK.lock() {
        if hook.is_some() {
            return;
        }
    }

    start_worker();

    unsafe {
        let module = GetModuleHandleW(None).ok();
        let hinstance = module.map(|handle| handle.into());
        if let Ok(hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(low_level_keyboard_proc), hinstance, 0)
        {
            if let Ok(mut stored) = HOOK.lock() {
                *stored = Some(hook.0 as isize);
            }
        }
    }
}

fn start_worker() {
    if WORKER_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }

    let _ = std::thread::Builder::new()
        .name("collapse-bind".into())
        .spawn(|| {
            loop {
                std::thread::sleep(Duration::from_millis(15));
                if !PENDING_TOGGLE.swap(false, Ordering::AcqRel) {
                    continue;
                }
                if SETTINGS_OPEN.load(Ordering::Relaxed) {
                    continue;
                }
                if !should_handle_in_foreground() {
                    continue;
                }
                let callback = ON_TOGGLE.lock().ok().and_then(|guard| guard.clone());
                if let Some(callback) = callback {
                    callback();
                }
            }
        });
}

fn js_key_to_vk(key: &str) -> Option<u32> {
    let k = key.to_lowercase();
    match k.as_str() {
        "tab" => Some(VK_TAB.0 as u32),
        " " | "space" => Some(VK_SPACE.0 as u32),
        "escape" | "esc" => Some(VK_ESCAPE.0 as u32),
        "backspace" => Some(VK_BACK.0 as u32),
        "delete" => Some(VK_DELETE.0 as u32),
        "insert" => Some(VK_INSERT.0 as u32),
        "home" => Some(VK_HOME.0 as u32),
        "end" => Some(VK_END.0 as u32),
        "pageup" => Some(VK_PRIOR.0 as u32),
        "pagedown" => Some(VK_NEXT.0 as u32),
        "capslock" => Some(VK_CAPITAL.0 as u32),
        "arrowleft" | "left" => Some(VK_LEFT.0 as u32),
        "arrowup" | "up" => Some(VK_UP.0 as u32),
        "arrowright" | "right" => Some(VK_RIGHT.0 as u32),
        "arrowdown" | "down" => Some(VK_DOWN.0 as u32),
        "enter" | "return" => Some(VK_RETURN.0 as u32),
        other => {
            if let Some(rest) = other.strip_prefix('f') {
                if let Ok(n) = rest.parse::<u32>() {
                    if (1..=24).contains(&n) {
                        return Some(VK_F1.0 as u32 + n - 1);
                    }
                }
            }
            if other.chars().count() == 1 {
                let ch = other.chars().next()?;
                let scan = unsafe { VkKeyScanW(ch as u16) };
                if scan != -1 {
                    return Some((scan as u16 & 0xFF) as u32);
                }
            }
            None
        }
    }
}

fn modifier_down(vk: u16) -> bool {
    unsafe { GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0 }
}

fn bind_matches(vk: u32) -> bool {
    let Ok(guard) = CURRENT_BIND.try_lock() else {
        return false;
    };
    let Some(bind) = *guard else {
        return false;
    };
    vk == bind.vk
        && modifier_down(VK_CONTROL.0) == bind.ctrl
        && modifier_down(VK_MENU.0) == bind.alt
        && modifier_down(VK_SHIFT.0) == bind.shift
}

fn should_handle_in_foreground() -> bool {
    match focus::get_foreground_window_info() {
        Some(info) => {
            focus::is_league_game_window(&info)
                || info.process_name.to_lowercase().contains("summtracker")
        }
        None => false,
    }
}

unsafe extern "system" fn low_level_keyboard_proc(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code >= 0 {
        let msg = wparam.0 as u32;
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };

        if msg == WM_KEYUP || msg == WM_SYSKEYUP {
            let _ = HELD_VK.compare_exchange(info.vkCode, 0, Ordering::Relaxed, Ordering::Relaxed);
        } else if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            // Keep this path tiny. Caps/Num/Scroll Lock fail to toggle if the
            // LL hook stalls (OpenProcess, thread spawn, etc.) before returning.
            if HELD_VK.load(Ordering::Relaxed) != info.vkCode && bind_matches(info.vkCode) {
                HELD_VK.store(info.vkCode, Ordering::Relaxed);
                if !SETTINGS_OPEN.load(Ordering::Relaxed) {
                    PENDING_TOGGLE.store(true, Ordering::Release);
                }
            }
        }
    }

    // Always pass the key through so Caps Lock / Tab / games still receive it.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
