#[cfg(windows)]
pub use windows_impl::*;

#[cfg(windows)]
mod windows_impl {
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::ProcessStatus::GetModuleBaseNameW;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    #[derive(Debug)]
    pub struct ForegroundInfo {
        pub process_name: String,
        pub title: String,
        pub class_name: String,
    }

    fn get_process_name(pid: u32) -> String {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
            else {
                return String::new();
            };
            let mut buf = [0u16; 256];
            GetModuleBaseNameW(handle, None, &mut buf);
            let _ = CloseHandle(handle);
            String::from_utf16_lossy(&buf)
                .trim_end_matches('\0')
                .to_string()
        }
    }

    pub fn get_foreground_window_info() -> Option<ForegroundInfo> {
        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }

            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));

            let mut title_buf = [0u16; 512];
            GetWindowTextW(hwnd, &mut title_buf);
            let title = String::from_utf16_lossy(&title_buf)
                .trim_end_matches('\0')
                .to_string();

            let mut class_buf = [0u16; 256];
            GetClassNameW(hwnd, &mut class_buf);
            let class_name = String::from_utf16_lossy(&class_buf)
                .trim_end_matches('\0')
                .to_string();

            let process_name = get_process_name(pid);

            Some(ForegroundInfo { process_name, title, class_name })
        }
    }

    pub fn is_league_game_window(info: &ForegroundInfo) -> bool {
        let pn = info.process_name.to_lowercase();
        let title = info.title.to_lowercase();
        let class = info.class_name.to_lowercase();
        pn.contains("league")
            || title.contains("league of legends")
            || class.contains("riotwindowclass")
    }
}
