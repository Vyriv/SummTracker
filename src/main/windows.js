const { execFile } = require('child_process');

const FOREGROUND_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
}
"@
$hwnd = [Win32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
  [Console]::Out.Write('{"processName":"","title":"","className":""}')
  exit 0
}
$pid = 0
[void][Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
$title = New-Object System.Text.StringBuilder 512
[void][Win32]::GetWindowText($hwnd, $title, $title.Capacity)
$class = New-Object System.Text.StringBuilder 256
[void][Win32]::GetClassName($hwnd, $class, $class.Capacity)
[void][Win32]::GetWindowText($hwnd, $title, $title.Capacity)
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
$name = if ($proc) { $proc.ProcessName } else { '' }
[pscustomobject]@{
  processName = $name
  title = $title.ToString()
  className = $class.ToString()
} | ConvertTo-Json -Compress
`;

function getForegroundWindowInfo() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', FOREGROUND_SCRIPT],
      { windowsHide: true, timeout: 2000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }

        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

function isLeagueGameWindow(info) {
  if (!info) return false;
  const processName = String(info.processName || '').toLowerCase();
  const title = String(info.title || '').toLowerCase();
  const className = String(info.className || '').toLowerCase();

  return (
    processName.includes('league') ||
    title.includes('league of legends') ||
    className.includes('riotwindowclass')
  );
}

module.exports = { getForegroundWindowInfo, isLeagueGameWindow };
