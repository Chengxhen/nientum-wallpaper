param(
  [string]$Action = 'set',
  [int]$Width = 1920,
  [int]$Height = 1080,
  [int]$X = 20,
  [int]$Y = 20
)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class NientumWeWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static IntPtr FindCaptureWindow(uint[] pids) {
    HashSet<uint> set = new HashSet<uint>(pids);
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint pid = 0;
      GetWindowThreadProcessId(hWnd, out pid);
      if (!set.Contains(pid)) return true;
      StringBuilder sb = new StringBuilder(256);
      GetWindowText(hWnd, sb, 256);
      string title = sb.ToString();
      if (!string.IsNullOrEmpty(title) && title.IndexOf("NientumCapture", StringComparison.OrdinalIgnoreCase) >= 0) {
        found = hWnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[NientumWeWin]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
$wePids = @(Get-Process -Name wallpaper64,wallpaper32 -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
$h = [IntPtr]::Zero
if ($wePids.Count -gt 0) {
  $h = [NientumWeWin]::FindCaptureWindow([uint32[]]$wePids)
}
if ($h -eq [IntPtr]::Zero) {
  Write-Output 'NO_WINDOW'
  exit 2
}
if ($Action -eq 'close') {
  [NientumWeWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Write-Output 'CLOSED'
  exit 0
}
if ($Action -eq 'hide') {
  [NientumWeWin]::ShowWindow($h, 0) | Out-Null
  Write-Output 'HIDDEN'
  exit 0
}
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
if ($Width -ge $scr.Width -or $Height -ge $scr.Height) {
  $X = 0
  $Y = 0
}
$Width = [Math]::Min($Width, [Math]::Max(640, $scr.Width - $X * 2))
$Height = [Math]::Min($Height, [Math]::Max(360, $scr.Height - $Y * 2))
[NientumWeWin]::ShowWindow($h, 5) | Out-Null
[NientumWeWin]::SetWindowPos($h, [IntPtr](-1), $X, $Y, $Width, $Height, 0x0040) | Out-Null
[NientumWeWin]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
$cr = New-Object NientumWeWin+RECT
[NientumWeWin]::GetClientRect($h, [ref]$cr) | Out-Null
$pt = New-Object NientumWeWin+POINT
$pt.X = 0
$pt.Y = 0
[NientumWeWin]::ClientToScreen($h, [ref]$pt) | Out-Null
Write-Output ("CLIENT_ORIGIN=" + $pt.X + "," + $pt.Y)
Write-Output ("CLIENT_SIZE=" + ($cr.R - $cr.L) + "x" + ($cr.B - $cr.T))
exit 0