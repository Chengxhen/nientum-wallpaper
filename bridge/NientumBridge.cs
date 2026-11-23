// NientumBridge — 滚轮桥接器 + 网易云代理，单一 exe
// Wallpaper Engine 的网页壁纸收不到鼠标滚轮（桌面层不转发 wheel），
// 本程序用全局低级鼠标钩子捕获滚轮，再以“带右键状态的合成 mousemove”把
// 滚动信号送进网页壁纸页面（WE 会转发 mousemove/点击，不转发滚轮）。
//
// 同时内嵌 node.exe 与打包后的代理脚本，负责拉起/守护 127.0.0.1:17988 网易云代理。
// - 首次安装/启动把内核解压到 runtime\proxy-<版本>（约 1 秒），之后只校验 .ready；
// - 代理启动后必须 /api/ping 通才算成功，断线会自动重启并写 proxy.log；
// - 用户数据（cookie / 导入壁纸 / 缓存）留在 exe 同目录，升级不丢。
//
// 运行方式：后台运行、无窗口、无托盘、无任务栏图标。
// - 双击即启动：Wallpaper Engine 没在运行时先通过 steam:// 拉起 WE，再接管滚轮；
// - 与 WE 进程级绑定：WE 退出后桥接器自动退出，不需要开机自启；
// - 只在当前桌面壁纸是 Nientum 系工程、并且桌面可见时转发滚轮。
//
// 页面端约定（Nientum_Wallpaper/js/player.js）：
//   e.buttons === 2 且 clientY 0..14、clientX 25..240 的 mousemove 视为滚轮信号
//   clientX = 30 + 30 * n（n=1..6 滚动行数），clientY = 3 向上 / 9 向下
//   e.buttons === 2 且 clientX 250..290、clientY 3/9 的 mousemove 视为失焦/恢复信号
//   （桌面图标属于 Explorer 的 SysListView32，需单独识别，不能当成空白桌面）
//
// 编译（.NET Framework 4.x 自带）：
//   csc.exe -platform:x64 -target:winexe -out:NientumBridge.exe
//     -resource:payload/node.exe.gz,payload.node.gz
//     -resource:payload/proxy/server.js.gz,payload.server.js.gz
//     -resource:payload/proxy/we_record_window.ps1,payload.we_record_window.ps1
//     -resource:payload/data/china_ip_ranges.txt,payload.china_ip_ranges.txt
//     NientumBridge.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Native
{
    public const int WH_MOUSE_LL = 14;
    public const int WM_MOUSEMOVE = 0x0200;
    public const int WM_LBUTTONDOWN = 0x0201;
    public const int WM_LBUTTONUP = 0x0202;
    public const int WM_RBUTTONDOWN = 0x0204;
    public const int WM_RBUTTONUP = 0x0205;
    public const int WM_MOUSEWHEEL = 0x020A;
    public const int WM_CANCELMODE = 0x001F;
    public const int WM_KEYDOWN = 0x0100;
    public const int VK_ESCAPE = 0x1B;
    public const uint MK_LBUTTON = 0x0001;
    public const uint MK_RBUTTON = 0x0002;
    public const uint MK_MBUTTON = 0x0010;
    public const uint GA_ROOT = 2;

    public const uint PROCESS_VM_OPERATION = 0x0008;
    public const uint PROCESS_VM_READ = 0x0010;
    public const uint PROCESS_VM_WRITE = 0x0020;
    public const uint PROCESS_QUERY_INFORMATION = 0x0400;
    public const uint MEM_COMMIT = 0x1000;
    public const uint MEM_RESERVE = 0x2000;
    public const uint MEM_RELEASE = 0x8000;
    public const uint PAGE_READWRITE = 0x04;
    public const uint LVM_GETITEMCOUNT = 0x1004;
    public const uint LVM_GETITEMRECT = 0x100E;
    public const uint LVIR_BOUNDS = 0;
    public const uint SMTO_BLOCK = 0x0001;
    public const uint SMTO_ABORTIFHUNG = 0x0002;

    public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT pt);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT pt);
    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam,
        uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr VirtualAllocEx(IntPtr hProcess, IntPtr lpAddress, UIntPtr dwSize,
        uint flAllocationType, uint flProtect);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool VirtualFreeEx(IntPtr hProcess, IntPtr lpAddress, UIntPtr dwSize, uint dwFreeType);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, ref RECT lpBuffer,
        UIntPtr nSize, out IntPtr lpNumberOfBytesWritten);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, out RECT lpBuffer,
        UIntPtr nSize, out IntPtr lpNumberOfBytesRead);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetFocus();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    public static IntPtr MakeLParam(int x, int y)
    {
        return (IntPtr)((y << 16) | (x & 0xFFFF));
    }

    public static string ClassOf(IntPtr h)
    {
        var sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }
}

static class ShellNative
{
    public const int CSIDL_BITBUCKET = 0x000a;
    public const int CSIDL_DRIVES = 0x0011;

    public const uint CMF_NORMAL = 0x00000000;
    public const uint CMF_EXPLORE = 0x00000004;
    public const uint CMF_EXTENDEDVERBS = 0x00000100;

    public const uint TPM_LEFTALIGN = 0x0000;
    public const uint TPM_RIGHTBUTTON = 0x0002;
    public const uint TPM_RETURNCMD = 0x0100;

    public const uint CMIC_MASK_UNICODE = 0x00004000;
    public const uint CMIC_MASK_PTINVOKE = 0x20000000;

    public const int SW_SHOWNORMAL = 1;
    public const uint GCS_VERBW = 0x00000004;

    public const int WM_NULL = 0x0000;
    public const int WM_DRAWITEM = 0x002B;
    public const int WM_MEASUREITEM = 0x002C;
    public const int WM_INITMENUPOPUP = 0x0117;
    public const int WM_MENUCHAR = 0x0120;
    public const int VK_SHIFT = 0x10;

    public static readonly Guid IID_IShellFolder = new Guid("000214E6-0000-0000-C000-000000000046");
    public static readonly Guid IID_IContextMenu = new Guid("000214E4-0000-0000-C000-000000000046");
    public static readonly Guid IID_IContextMenu2 = new Guid("000214F4-0000-0000-C000-000000000046");
    public static readonly Guid IID_IContextMenu3 = new Guid("BCFCE0A0-EC17-11D0-8D10-00A0C90F2719");

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CMINVOKECOMMANDINFOEX
    {
        public int cbSize;
        public uint fMask;
        public IntPtr hwnd;
        public IntPtr lpVerb;
        public IntPtr lpParameters;
        public IntPtr lpDirectory;
        public int nShow;
        public uint dwHotKey;
        public IntPtr hIcon;
        public IntPtr lpTitle;
        public IntPtr lpVerbW;
        public IntPtr lpParametersW;
        public IntPtr lpDirectoryW;
        public IntPtr lpTitleW;
        public POINT ptInvoke;
    }

    [ComImport]
    [Guid("000214E6-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellFolder
    {
        [PreserveSig] int ParseDisplayName(IntPtr hwnd, IntPtr pbc, [MarshalAs(UnmanagedType.LPWStr)] string pszDisplayName, out uint pchEaten, out IntPtr ppidl, ref uint pdwAttributes);
        [PreserveSig] int EnumObjects(IntPtr hwnd, uint grfFlags, out IntPtr ppenumIDList);
        [PreserveSig] int BindToObject(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int BindToStorage(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr pidl1, IntPtr pidl2);
        [PreserveSig] int CreateViewObject(IntPtr hwndOwner, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetAttributesOf(uint cidl, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, ref uint rgfInOut);
        [PreserveSig] int GetUIObjectOf(IntPtr hwndOwner, uint cidl, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, ref Guid riid, IntPtr rgfReserved, out IntPtr ppv);
        [PreserveSig] int GetDisplayNameOf(IntPtr pidl, uint uFlags, out IntPtr pName);
        [PreserveSig] int SetNameOf(IntPtr hwnd, IntPtr pidl, [MarshalAs(UnmanagedType.LPWStr)] string pszName, uint uFlags, out IntPtr ppidlOut);
    }

    [ComImport]
    [Guid("000214E4-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IContextMenu
    {
        [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
        [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX pici);
        [PreserveSig] int GetCommandString(UIntPtr idCmd, uint uType, IntPtr pReserved, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, uint cchMax);
    }

    [ComImport]
    [Guid("000214F4-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IContextMenu2
    {
        [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
        [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX pici);
        [PreserveSig] int GetCommandString(UIntPtr idCmd, uint uType, IntPtr pReserved, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, uint cchMax);
        [PreserveSig] int HandleMenuMsg(uint uMsg, IntPtr wParam, IntPtr lParam);
    }

    [ComImport]
    [Guid("BCFCE0A0-EC17-11D0-8D10-00A0C90F2719")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IContextMenu3
    {
        [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
        [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX pici);
        [PreserveSig] int GetCommandString(UIntPtr idCmd, uint uType, IntPtr pReserved, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, uint cchMax);
        [PreserveSig] int HandleMenuMsg(uint uMsg, IntPtr wParam, IntPtr lParam);
        [PreserveSig] int HandleMenuMsg2(uint uMsg, IntPtr wParam, IntPtr lParam, out IntPtr plResult);
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SHParseDisplayName(string pszName, IntPtr pbc, out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);
    [DllImport("shell32.dll")]
    public static extern int SHGetSpecialFolderLocation(IntPtr hwndOwner, int nFolder, out IntPtr ppidl);
    [DllImport("shell32.dll")]
    public static extern int SHBindToParent(IntPtr pidl, ref Guid riid, out IntPtr ppv, out IntPtr ppidlLast);
    [DllImport("shell32.dll")]
    public static extern void ILFree(IntPtr pidl);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    public static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")]
    public static extern bool DestroyMenu(IntPtr hMenu);
    [DllImport("user32.dll")]
    public static extern int TrackPopupMenuEx(IntPtr hmenu, uint fuFlags, int x, int y, IntPtr hwnd, IntPtr lptpm);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool AllowSetForegroundWindow(int dwProcessId);
}

sealed class MenuHostForm : Form
{
    public ShellNative.IContextMenu2 ContextMenu2;
    public ShellNative.IContextMenu3 ContextMenu3;

    public MenuHostForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(0, 0);
        Size = new Size(1, 1);
        Opacity = 0.01;
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
            return cp;
        }
    }

    protected override void WndProc(ref Message m)
    {
        int msg = m.Msg;
        if (msg == ShellNative.WM_INITMENUPOPUP || msg == ShellNative.WM_DRAWITEM || msg == ShellNative.WM_MEASUREITEM || msg == ShellNative.WM_MENUCHAR)
        {
            if (ContextMenu3 != null)
            {
                IntPtr res;
                if (ContextMenu3.HandleMenuMsg2((uint)msg, m.WParam, m.LParam, out res) == 0)
                {
                    if (msg == ShellNative.WM_MENUCHAR) m.Result = res;
                    return;
                }
            }
            if (ContextMenu2 != null)
            {
                if (ContextMenu2.HandleMenuMsg((uint)msg, m.WParam, m.LParam) == 0)
                    return;
            }
        }
        base.WndProc(ref m);
    }
}

static class ShellMenuRunner
{
    const uint CMD_FIRST = 1;
    const uint CMD_LAST = 0x7FFF;

    static void ForceForeground(IntPtr hwnd)
    {
        try
        {
            ShellNative.AllowSetForegroundWindow(-1);
            IntPtr fg = ShellNative.GetForegroundWindow();
            uint curTid = ShellNative.GetCurrentThreadId();
            uint fgPid;
            uint fgTid = fg != IntPtr.Zero ? ShellNative.GetWindowThreadProcessId(fg, out fgPid) : 0;
            bool attached = false;
            try
            {
                if (fgTid != 0 && fgTid != curTid)
                    attached = ShellNative.AttachThreadInput(curTid, fgTid, true);
                ShellNative.SetForegroundWindow(hwnd);
            }
            finally
            {
                if (attached) ShellNative.AttachThreadInput(curTid, fgTid, false);
            }
        }
        catch { }
    }

    static bool HasOwnedVisibleWindows(IntPtr hiddenHandle)
    {
        uint selfPid = (uint)Process.GetCurrentProcess().Id;
        bool found = false;
        ShellNative.EnumWindows((hWnd, lParam) =>
        {
            if (hWnd == hiddenHandle) return true;
            if (!ShellNative.IsWindowVisible(hWnd)) return true;
            uint pid;
            ShellNative.GetWindowThreadProcessId(hWnd, out pid);
            if (pid == selfPid)
            {
                found = true;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static string JsonEscape(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            if (c == '\\') sb.Append("\\\\");
            else if (c == '"') sb.Append("\\\"");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 0x20) sb.Append("\\u" + ((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static int ResolveTargetPidl(string targetPath, out IntPtr pidlFull, out string parentDir)
    {
        pidlFull = IntPtr.Zero;
        parentDir = null;
        if (string.Equals(targetPath, "@thispc", StringComparison.OrdinalIgnoreCase))
            return ShellNative.SHGetSpecialFolderLocation(IntPtr.Zero, ShellNative.CSIDL_DRIVES, out pidlFull);
        if (string.Equals(targetPath, "@recyclebin", StringComparison.OrdinalIgnoreCase))
            return ShellNative.SHGetSpecialFolderLocation(IntPtr.Zero, ShellNative.CSIDL_BITBUCKET, out pidlFull);
        string clean = targetPath.Trim();
        try { parentDir = Path.GetDirectoryName(clean.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)); }
        catch { parentDir = null; }
        uint sfgao;
        return ShellNative.SHParseDisplayName(clean, IntPtr.Zero, out pidlFull, 0, out sfgao);
    }

    public static int Run(string[] args)
    {
        try { ShellNative.SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string targetPath = null;
        int argX = int.MinValue;
        int argY = int.MinValue;
        bool useCursor = true;

        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i] ?? "";
            if (a.Equals("--shell-menu", StringComparison.OrdinalIgnoreCase)) continue;
            if (a == "--path-b64" && i + 1 < args.Length)
            {
                try { targetPath = Encoding.UTF8.GetString(Convert.FromBase64String(args[++i])); }
                catch { targetPath = null; }
            }
            else if (a == "--path" && i + 1 < args.Length)
            {
                targetPath = args[++i];
            }
            else if (a == "--x" && i + 1 < args.Length)
            {
                int v;
                if (int.TryParse(args[++i], out v)) { argX = v; useCursor = false; }
            }
            else if (a == "--y" && i + 1 < args.Length)
            {
                int v;
                if (int.TryParse(args[++i], out v)) { argY = v; useCursor = false; }
            }
            else if (a == "--cursor")
            {
                useCursor = true;
            }
            else if (targetPath == null)
            {
                targetPath = a;
            }
        }

        if (string.IsNullOrEmpty(targetPath))
        {
            Console.WriteLine("{\"ok\":false,\"error\":\"missing_path\"}");
            return 1;
        }

        ShellNative.POINT pt;
        ShellNative.GetCursorPos(out pt);
        if (!useCursor && argX != int.MinValue && argY != int.MinValue)
        {
            pt.X = argX;
            pt.Y = argY;
        }

        IntPtr pidlFull = IntPtr.Zero;
        IntPtr parentPtr = IntPtr.Zero;
        IntPtr icmPtr = IntPtr.Zero;
        IntPtr icm2Ptr = IntPtr.Zero;
        IntPtr icm3Ptr = IntPtr.Zero;
        IntPtr hMenu = IntPtr.Zero;

        try
        {
            string parentDir;
            int hr = ResolveTargetPidl(targetPath, out pidlFull, out parentDir);
            if (hr != 0 || pidlFull == IntPtr.Zero)
            {
                Console.WriteLine("{\"ok\":false,\"error\":\"resolve_failed\",\"hr\":" + hr + "}");
                return 2;
            }

            Guid iidFolder = ShellNative.IID_IShellFolder;
            IntPtr pidlChild;
            hr = ShellNative.SHBindToParent(pidlFull, ref iidFolder, out parentPtr, out pidlChild);
            if (hr != 0 || parentPtr == IntPtr.Zero || pidlChild == IntPtr.Zero)
            {
                Console.WriteLine("{\"ok\":false,\"error\":\"bind_parent_failed\",\"hr\":" + hr + "}");
                return 3;
            }

            var parentFolder = (ShellNative.IShellFolder)Marshal.GetObjectForIUnknown(parentPtr);
            Guid iidMenu = ShellNative.IID_IContextMenu;
            using (var host = new MenuHostForm())
            {
                hr = parentFolder.GetUIObjectOf(host.Handle, 1, new IntPtr[] { pidlChild }, ref iidMenu, IntPtr.Zero, out icmPtr);
                if (hr != 0 || icmPtr == IntPtr.Zero)
                {
                    Console.WriteLine("{\"ok\":false,\"error\":\"context_menu_failed\",\"hr\":" + hr + "}");
                    return 4;
                }

                var icm = (ShellNative.IContextMenu)Marshal.GetObjectForIUnknown(icmPtr);
                Guid iid2 = ShellNative.IID_IContextMenu2;
                Guid iid3 = ShellNative.IID_IContextMenu3;
                if (Marshal.QueryInterface(icmPtr, ref iid2, out icm2Ptr) == 0 && icm2Ptr != IntPtr.Zero)
                    host.ContextMenu2 = (ShellNative.IContextMenu2)Marshal.GetObjectForIUnknown(icm2Ptr);
                if (Marshal.QueryInterface(icmPtr, ref iid3, out icm3Ptr) == 0 && icm3Ptr != IntPtr.Zero)
                    host.ContextMenu3 = (ShellNative.IContextMenu3)Marshal.GetObjectForIUnknown(icm3Ptr);

                hMenu = ShellNative.CreatePopupMenu();
                uint flags = ShellNative.CMF_NORMAL | ShellNative.CMF_EXPLORE;
                if ((ShellNative.GetAsyncKeyState(ShellNative.VK_SHIFT) & 0x8000) != 0)
                    flags |= ShellNative.CMF_EXTENDEDVERBS;

                hr = icm.QueryContextMenu(hMenu, 0, CMD_FIRST, CMD_LAST, flags);
                if (hr < 0)
                {
                    Console.WriteLine("{\"ok\":false,\"error\":\"query_menu_failed\",\"hr\":" + hr + "}");
                    return 5;
                }

                host.Location = new Point(pt.X, pt.Y);
                host.Show();
                Application.DoEvents();
                ForceForeground(host.Handle);
                int cmd = ShellNative.TrackPopupMenuEx(
                    hMenu,
                    ShellNative.TPM_RETURNCMD | ShellNative.TPM_LEFTALIGN | ShellNative.TPM_RIGHTBUTTON,
                    pt.X,
                    pt.Y,
                    host.Handle,
                    IntPtr.Zero);
                ShellNative.PostMessage(host.Handle, ShellNative.WM_NULL, IntPtr.Zero, IntPtr.Zero);
                host.Hide();

                if (cmd < (int)CMD_FIRST)
                {
                    Console.WriteLine("{\"ok\":true,\"invoked\":false}");
                    Console.Out.Flush();
                    return 0;
                }

                string verb = "";
                try
                {
                    var sbVerb = new StringBuilder(128);
                    if (icm.GetCommandString((UIntPtr)(uint)(cmd - CMD_FIRST), ShellNative.GCS_VERBW, IntPtr.Zero, sbVerb, (uint)sbVerb.Capacity) == 0)
                        verb = sbVerb.ToString();
                }
                catch { }

                IntPtr dirPtr = IntPtr.Zero;
                try
                {
                    if (!string.IsNullOrEmpty(parentDir) && Directory.Exists(parentDir))
                        dirPtr = Marshal.StringToHGlobalUni(parentDir);

                    var ici = new ShellNative.CMINVOKECOMMANDINFOEX();
                    ici.cbSize = Marshal.SizeOf(typeof(ShellNative.CMINVOKECOMMANDINFOEX));
                    ici.fMask = ShellNative.CMIC_MASK_UNICODE | ShellNative.CMIC_MASK_PTINVOKE;
                    if ((ShellNative.GetAsyncKeyState(ShellNative.VK_SHIFT) & 0x8000) != 0)
                        ici.fMask |= 0x04000000;
                    ici.hwnd = host.Handle;
                    ici.lpVerb = (IntPtr)(cmd - CMD_FIRST);
                    ici.lpVerbW = (IntPtr)(cmd - CMD_FIRST);
                    ici.lpDirectoryW = dirPtr;
                    ici.nShow = ShellNative.SW_SHOWNORMAL;
                    ici.ptInvoke = pt;

                    hr = icm.InvokeCommand(ref ici);
                    Console.WriteLine("{\"ok\":" + (hr == 0 ? "true" : "false") + ",\"invoked\":true,\"verb\":\"" + JsonEscape(verb) + "\",\"hr\":" + hr + "}");
                    Console.Out.Flush();
                }
                finally
                {
                    if (dirPtr != IntPtr.Zero) Marshal.FreeHGlobal(dirPtr);
                }

                Thread.Sleep(180);
                Application.DoEvents();
                int idleTicks = 0;
                while (HasOwnedVisibleWindows(host.Handle) && idleTicks < 36000)
                {
                    Application.DoEvents();
                    Thread.Sleep(50);
                    idleTicks++;
                }
            }
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine("{\"ok\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}");
            Console.Out.Flush();
            return 9;
        }
        finally
        {
            if (hMenu != IntPtr.Zero) ShellNative.DestroyMenu(hMenu);
            if (icm3Ptr != IntPtr.Zero) Marshal.Release(icm3Ptr);
            if (icm2Ptr != IntPtr.Zero) Marshal.Release(icm2Ptr);
            if (icmPtr != IntPtr.Zero) Marshal.Release(icmPtr);
            if (parentPtr != IntPtr.Zero) Marshal.Release(parentPtr);
            if (pidlFull != IntPtr.Zero) ShellNative.ILFree(pidlFull);
        }
    }
}

sealed class ProxyRuntimePaths
{
    public string Root;
    public string ProxyDir;
    public string NodeExe;
    public string ServerJs;
    public bool Fallback;
}

// 单 exe 内核：node.exe + 打包后的 server.js 以 gzip 资源内嵌。
// 首次安装/启动解压到 <exe目录>\runtime\proxy-<版本>，之后只校验 .ready，不再解压。
static class PayloadRuntime
{
    public const string Version = "20261123.6";
    const string ResNode = "payload.node.gz";
    const string ResServer = "payload.server.js.gz";
    const string ResRecord = "payload.we_record_window.ps1";
    const string ResData = "payload.china_ip_ranges.txt";

    public static ProxyRuntimePaths Ensure(string exeDir, Action<string> log)
    {
        if (log == null) log = delegate(string m) { };
        ProxyRuntimePaths paths = TryEnsureIn(Path.Combine(exeDir, "runtime"), log);
        if (paths != null) return paths;
        try
        {
            string local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NientumWallpaper", "runtime");
            log("proxy runtime first location failed; trying " + local);
            paths = TryEnsureIn(local, log);
            if (paths != null) return paths;
        }
        catch (Exception ex) { log("proxy runtime local fallback error: " + ex.Message); }

        string legacyNode = Path.Combine(exeDir, "node.exe");
        string legacyServer = Path.Combine(exeDir, "server.js");
        if (File.Exists(legacyNode) && File.Exists(legacyServer))
        {
            log("proxy runtime using legacy external node.exe/server.js");
            return new ProxyRuntimePaths { Root = exeDir, ProxyDir = exeDir, NodeExe = legacyNode, ServerJs = legacyServer, Fallback = true };
        }
        log("proxy runtime unavailable");
        return null;
    }

    static ProxyRuntimePaths TryEnsureIn(string runtimeRoot, Action<string> log)
    {
        try
        {
            string dir = Path.Combine(runtimeRoot, "proxy-" + Version);
            string proxyDir = Path.Combine(dir, "proxy");
            string dataDir = Path.Combine(dir, "data");
            string nodeExe = Path.Combine(proxyDir, "node.exe");
            string serverJs = Path.Combine(proxyDir, "server.js");
            string ready = Path.Combine(dir, ".ready");

            if (File.Exists(ready) && File.Exists(nodeExe) && File.Exists(serverJs))
            {
                return new ProxyRuntimePaths { Root = dir, ProxyDir = proxyDir, NodeExe = nodeExe, ServerJs = serverJs };
            }

            Stopwatch sw = Stopwatch.StartNew();
            log("proxy runtime extracting to " + dir);
            if (Directory.Exists(dir))
            {
                try { Directory.Delete(dir, true); }
                catch (Exception ex) { log("proxy runtime old dir locked: " + ex.Message); return null; }
            }
            Directory.CreateDirectory(proxyDir);
            Directory.CreateDirectory(dataDir);

            using (Stream s = OpenResource(ResNode)) WriteGzip(s, nodeExe);
            using (Stream s = OpenResource(ResServer)) WriteGzip(s, Path.Combine(proxyDir, "server.js"));
            using (Stream s = OpenResource(ResRecord)) WritePlain(s, Path.Combine(proxyDir, "we_record_window.ps1"));
            using (Stream s = OpenResource(ResData)) WritePlain(s, Path.Combine(dataDir, "china_ip_ranges.txt"));
            File.WriteAllText(ready, Version + "\r\n" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), Encoding.UTF8);
            log("proxy runtime ready in " + sw.ElapsedMilliseconds + " ms");
            CleanupOld(runtimeRoot, dir, log);
            return new ProxyRuntimePaths { Root = dir, ProxyDir = proxyDir, NodeExe = nodeExe, ServerJs = serverJs };
        }
        catch (Exception ex)
        {
            log("proxy runtime extract error: " + ex.Message);
            return null;
        }
    }

    static Stream OpenResource(string name)
    {
        Stream s = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (s == null) throw new InvalidOperationException("内嵌资源缺失: " + name);
        return s;
    }

    static void WriteGzip(Stream src, string dest)
    {
        using (GZipStream gz = new GZipStream(src, CompressionMode.Decompress))
        using (FileStream fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None, 1048576))
        {
            byte[] buffer = new byte[1048576];
            int n;
            while ((n = gz.Read(buffer, 0, buffer.Length)) > 0) fs.Write(buffer, 0, n);
        }
    }

    static void WritePlain(Stream src, string dest)
    {
        using (FileStream fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None, 65536))
        {
            byte[] buffer = new byte[65536];
            int n;
            while ((n = src.Read(buffer, 0, buffer.Length)) > 0) fs.Write(buffer, 0, n);
        }
    }

    static void CleanupOld(string runtimeRoot, string current, Action<string> log)
    {
        try
        {
            foreach (string d in Directory.GetDirectories(runtimeRoot, "proxy-*"))
            {
                if (string.Equals(d.TrimEnd('\\'), current.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) continue;
                if (!File.Exists(Path.Combine(d, ".ready"))) continue;
                try { Directory.Delete(d, true); }
                catch { log("proxy runtime old version kept (in use): " + d); }
            }
        }
        catch { }
    }
}

// 离线自检：解压内核、在测试端口启动代理、验证 /api/ping，不启动 WE、不装钩子。
static class ProxySelfTest
{
    public static int Run(string exeDir, int port, Action<string> log)
    {
        if (log == null) log = delegate(string m) { };
        List<string> lines = new List<string>();
        object lineLock = new object();
        Action<string> add = delegate(string m) { lock (lineLock) { lines.Add(m); } };
        Stopwatch total = Stopwatch.StartNew();
        string dataDir = Path.Combine(exeDir, "_selftest-data");
        Process proc = null;
        int exit = 1;
        try
        {
            try { if (Directory.Exists(dataDir)) Directory.Delete(dataDir, true); } catch { }
            Directory.CreateDirectory(dataDir);
            ProxyRuntimePaths rt = PayloadRuntime.Ensure(exeDir, add);
            if (rt == null) { add("FAIL runtime unavailable"); return WriteResult(exeDir, lines, lineLock, 1); }
            add("runtime=" + rt.Root);
            add("node=" + rt.NodeExe);

            try { HttpCall("POST", "http://127.0.0.1:" + port + "/api/shutdown", 400); } catch { }
            Thread.Sleep(250);

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = rt.NodeExe;
            psi.Arguments = "\"" + rt.ServerJs + "\"";
            psi.WorkingDirectory = rt.ProxyDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.EnvironmentVariables["NIENTUM_DATA_DIR"] = dataDir;
            psi.EnvironmentVariables["NIENTUM_PROXY_PORT"] = port.ToString(CultureInfo.InvariantCulture);
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            proc = Process.Start(psi);
            if (proc == null) { add("FAIL process start"); return WriteResult(exeDir, lines, lineLock, 1); }
            proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) add("out " + e.Data); };
            proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) add("err " + e.Data); };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            string ping = null;
            Stopwatch wait = Stopwatch.StartNew();
            while (wait.ElapsedMilliseconds < 20000)
            {
                if (proc.HasExited)
                {
                    add("FAIL process exited code=" + proc.ExitCode);
                    return WriteResult(exeDir, lines, lineLock, 1);
                }
                ping = HttpCall("GET", "http://127.0.0.1:" + port + "/api/ping", 500);
                if (!string.IsNullOrEmpty(ping)) break;
                Thread.Sleep(200);
            }
            if (string.IsNullOrEmpty(ping)) { add("FAIL ping timeout"); return WriteResult(exeDir, lines, lineLock, 1); }
            add("ping=" + ping);
            Match mv = Regex.Match(ping, "\"bridgeVer\"\\s*:\\s*(\\d+)");
            int ver = 0;
            if (mv.Success) int.TryParse(mv.Groups[1].Value, out ver);
            if (ver < 4) { add("FAIL bridgeVer=" + ver); return WriteResult(exeDir, lines, lineLock, 1); }
            add("OK elapsed=" + total.ElapsedMilliseconds + "ms");
            exit = 0;
            return WriteResult(exeDir, lines, lineLock, exit);
        }
        catch (Exception ex)
        {
            add("FAIL " + ex.Message);
            return WriteResult(exeDir, lines, lineLock, 1);
        }
        finally
        {
            if (proc != null)
            {
                try { if (!proc.HasExited) proc.Kill(); proc.WaitForExit(2000); } catch { }
            }
            try { Thread.Sleep(300); Directory.Delete(dataDir, true); } catch { }
            log(exit == 0 ? "selftest OK" : "selftest FAIL");
        }
    }

    static int WriteResult(string exeDir, List<string> lines, object lineLock, int exit)
    {
        try
        {
            string text;
            lock (lineLock) { text = string.Join("\r\n", lines.ToArray()); }
            File.WriteAllText(Path.Combine(exeDir, "_selftest_result.txt"), text + "\r\n", Encoding.UTF8);
        }
        catch { }
        return exit;
    }

    static string HttpCall(string method, string url, int timeoutMs)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.ContentLength = 0;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return sr.ReadToEnd();
        }
        catch { return null; }
    }
}

sealed class HiddenContext : ApplicationContext
{
}

sealed class Bridge
{
    Native.HookProc hookProc;
    IntPtr hookHandle = IntPtr.Zero;
    readonly string logPath;
    readonly string iniPath;
    readonly string exePath;
    readonly string dataDir;
    readonly string proxyLogPath;
    readonly object proxyLogLock = new object();
    ProxyRuntimePaths proxyRuntime;
    readonly System.Windows.Forms.Timer syncTimer;
    readonly System.Windows.Forms.Timer stateTimer;
    readonly Control uiInvokeCtrl;
    TcpListener ctrlListener;
    volatile bool ctrlStopping = false;
    Form nativeForm;
    TextBox nativeBox;
    string nativeField = "";
    long nativeSeq = 0;
    bool nativeHiding = false;
    DateTime lastNativeShow = DateTime.MinValue;

    // 设置
    string weConfigPath = "";
    string wallpaperKeyword = "nientum";
    bool daemonMode = false;
    bool fromWeMode = false;

    bool weRunning = false;
    int weMissingCount = 0;
    bool noNetease = false;
    int nientumMissing = 0;
    bool lastFocused = true;
    volatile string uiMode = "capsule";
    bool leftForwarded = false;
    bool rightForwarded = false;
    volatile bool hasDrawerRect = false;
    double drawerLeft = 0, drawerTop = 0, drawerRight = 0, drawerBottom = 0;
    DateTime lastDrawerMemUtc = DateTime.MinValue;
    DateTime lastUiMemUtc = DateTime.MinValue;
    DateTime lastDrawerRectRead = DateTime.MinValue;
    DateTime lastDragMoveSent = DateTime.MinValue;
    DateTime lastUiModeRead = DateTime.MinValue;
    volatile string hoverItemPath = "";
    DateTime hoverItemUtc = DateTime.MinValue;
    readonly object shellMenuLock = new object();
    volatile bool shellMenuBusy = false;
    DateTime lastShellMenuUtc = DateTime.MinValue;
    Process neteaseProc = null;
    bool neteaseReady = false;
    bool neteaseWasRunning = false;
    bool neteaseAdoptLogged = false;
    bool proxyRuntimeMissingLogged = false;
    int neteaseHealthFailures = 0;
    DateTime neteaseLastStartUtc = DateTime.MinValue;
    DateTime nextNeteaseHealthCheck = DateTime.MinValue;
    volatile bool neteaseHealthChecking = false;
    readonly object neteaseHealthLock = new object();
    readonly object neteaseLock = new object();
    const int NET_PORT = 17988;
    const int CTRL_PORT = 17989;
    const int EXPECTED_NETEASE_VER = 4;
    bool currentIsNientum = false;
    DateTime lastConfigCheck = DateTime.MinValue;

    IntPtr cachedWallpaperHwnd = IntPtr.Zero;
    DateTime lastHwndScan = DateTime.MinValue;
    IntPtr scanFoundHwnd = IntPtr.Zero;

    // 桌面图标命中检测：桌面图标不是独立窗口，而是铺满屏幕的 SysListView32 里的 item。
    // 只靠 WindowFromPoint 会把“图标”和“空白桌面”都当成桌面，导致图标上没有失焦模糊。
    IntPtr desktopListView = IntPtr.Zero;
    DateTime lastDesktopLvScan = DateTime.MinValue;
    readonly List<Native.RECT> desktopIconRects = new List<Native.RECT>();
    double desktopIconScale = 1.5;
    DateTime lastDesktopIconScan = DateTime.MinValue;
    bool loggedIconRects = false;
    bool loggedIconFail = false;


    readonly object logLock = new object();

    public Bridge(bool daemon, bool fromWe, bool noNetease)
    {
        daemonMode = daemon;
        fromWeMode = fromWe;
        this.noNetease = noNetease;
        exePath = Application.ExecutablePath;
        var dir = Path.GetDirectoryName(exePath);
        dataDir = dir;
        logPath = Path.Combine(dir, "bridge.log");
        iniPath = Path.Combine(dir, "bridge.ini");
        proxyLogPath = Path.Combine(dir, "proxy.log");
        LoadIni();
        EnsureWeConfigPath();
        uiInvokeCtrl = new Control();
        uiInvokeCtrl.CreateControl();
        Log("start; daemon=" + daemonMode + "; fromWe=" + fromWeMode + "; build=2026-11-22-single-exe; data=" + dataDir + "; config=" + weConfigPath + "; keyword=" + wallpaperKeyword);
        try
        {
            proxyRuntime = PayloadRuntime.Ensure(dataDir, Log);
            if (proxyRuntime != null) Log("proxy runtime=" + proxyRuntime.Root + (proxyRuntime.Fallback ? " (legacy)" : ""));
        }
        catch (Exception ex)
        {
            proxyRuntime = null;
            Log("proxy runtime prepare error: " + ex.Message);
        }
        hookProc = HookCallback;
        AppDomain.CurrentDomain.ProcessExit += (s2, e2) => { StopControlServer(); StopNeteaseServer(); };
        StartControlServer();

        // 先拉代理，再等 WE。开机时 WE 会先加载页面，若代理晚 1 秒起来，
        // 左侧快捷抽屉会拿到“未连接”并且不重试；提前启动可从根上消除这个竞态。
        if (!this.noNetease) EnsureNeteaseServer();

        if (!daemonMode)
        {
            // 非守护模式：从 Steam 启动参数(--from-we)调用时不重复拉起 steam://，否则由本桥接器顺手拉起 WE；最多等待 45 秒
            if (!IsWallpaperEngineRunning())
            {
                if (!fromWeMode)
                {
                    Log("launching wallpaper engine");
                    try { Process.Start("steam://rungameid/431960"); }
                    catch (Exception ex) { Log("launch error: " + ex.Message); }
                }
                else
                {
                    Log("waiting for wallpaper engine startup");
                }
                var sw = Stopwatch.StartNew();
                while (sw.Elapsed.TotalSeconds < 45 && !IsWallpaperEngineRunning())
                    Thread.Sleep(350);
                if (!IsWallpaperEngineRunning())
                {
                    Log("wallpaper engine did not start within 45s; exiting");
                    Environment.Exit(0);
                    return;
                }
            }
            weRunning = true;
            Log("wallpaper engine running; binding");
        }
        else
        {
            weRunning = IsWallpaperEngineRunning();
            Log(weRunning ? "daemon bound to running wallpaper engine" : "daemon waiting for wallpaper engine");
        }

        // 70ms 检测一次桌面/图标/其他窗口焦点状态，保证失焦模糊秒级响应（仅在挂载钩子时运行）
        stateTimer = new System.Windows.Forms.Timer { Interval = 70 };
        stateTimer.Tick += (s, e) => StateTick();

        syncTimer = new System.Windows.Forms.Timer { Interval = 1000 };
        syncTimer.Tick += (s, e) => SyncWithWallpaperEngine();
        syncTimer.Start();

        SyncWithWallpaperEngine();
    }

    void LoadIni()
    {
        try
        {
            if (!File.Exists(iniPath)) return;
            foreach (var raw in File.ReadAllLines(iniPath))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#") || line.StartsWith(";")) continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                var key = line.Substring(0, eq).Trim();
                var val = line.Substring(eq + 1).Trim();
                if (key.Equals("we_config", StringComparison.OrdinalIgnoreCase)) weConfigPath = val;
                else if (key.Equals("wallpaper_keyword", StringComparison.OrdinalIgnoreCase)) wallpaperKeyword = val;
                else if (key.Equals("daemon", StringComparison.OrdinalIgnoreCase)) daemonMode = (val == "1" || val.Equals("true", StringComparison.OrdinalIgnoreCase));
            }
        }
        catch (Exception ex) { Log("ini load error: " + ex.Message); }
    }

    void SyncWithWallpaperEngine()
    {
        try { SyncCore(); }
        catch (Exception ex) { Log("sync error: " + ex.Message); }
    }

    DateTime lastConfigDetect = DateTime.MinValue;

    void SyncCore()
    {
        if ((string.IsNullOrEmpty(weConfigPath) || !File.Exists(weConfigPath)) &&
            (DateTime.Now - lastConfigDetect).TotalSeconds > 60)
        {
            lastConfigDetect = DateTime.Now;
            EnsureWeConfigPath();
        }
        bool running = IsWallpaperEngineRunning();
        if (running)
        {
            string pc = DetectWeConfigFromProcess();
            if (!string.IsNullOrEmpty(pc) && !string.Equals(pc, weConfigPath, StringComparison.OrdinalIgnoreCase))
            {
                weConfigPath = pc;
                Log("we config from process: " + pc);
            }
        }
        RefreshNientum();
        if (running)
        {
            if (!weRunning) { weRunning = true; Log("wallpaper engine started"); }
            weMissingCount = 0;
            if (currentIsNientum)
            {
                nientumMissing = 0;
                if (!noNetease) EnsureNeteaseServer();
            }
            else
            {
                nientumMissing++;
                if (nientumMissing >= 3) StopNeteaseServer();
            }
        }
        else
        {
            if (weRunning)
            {
                weRunning = false;
                cachedWallpaperHwnd = IntPtr.Zero;
                StopNeteaseServer();
                Log("wallpaper engine stopped");
            }
            weMissingCount++;
            if (!daemonMode && weMissingCount >= 2)
            {
                Log("wallpaper engine closed; bridge exiting");
                UninstallHook();
                StopNeteaseServer();
                Application.Exit();
                return;
            }
        }
        // 只为 Nientum 壁纸安装全局钩子；切到其他壁纸立即卸载，减少对系统的输入干预
        bool needHook = weRunning && currentIsNientum;
        if (needHook && hookHandle == IntPtr.Zero) InstallHook();
        else if (!needHook && hookHandle != IntPtr.Zero) UninstallHook();
    }

    bool IsWallpaperEngineRunning()
    {
        try
        {
            if (Process.GetProcessesByName("wallpaper64").Length > 0) return true;
            if (Process.GetProcessesByName("wallpaper32").Length > 0) return true;
            if (Process.GetProcessesByName("webwallpaper64").Length > 0) return true;
            if (Process.GetProcessesByName("webwallpaper32").Length > 0) return true;
        }
        catch { }
        return false;
    }

    // ===== 网易云内置代理（随 WE 起停，无窗口） =====
    bool IsPortOpen(int port)
    {
        try
        {
            using (var client = new TcpClient())
            {
                var ar = client.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(250)) return false;
                client.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    void EnsureWeConfigPath()
    {
        if (!string.IsNullOrEmpty(weConfigPath) && File.Exists(weConfigPath)) return;
        string found = DetectWeConfig();
        if (!string.IsNullOrEmpty(found))
        {
            weConfigPath = found;
            Log("we config detected: " + found);
        }
        else Log("we config not found; set we_config in bridge.ini");
    }

    string ReadReg(string sub, string name, bool currentUser)
    {
        try
        {
            var baseKey = currentUser ? Registry.CurrentUser : Registry.LocalMachine;
            using (var k = baseKey.OpenSubKey(sub))
            {
                if (k != null)
                {
                    var v = k.GetValue(name) as string;
                    if (!string.IsNullOrEmpty(v)) return v;
                }
            }
        }
        catch { }
        return null;
    }

    void AddRoot(List<string> roots, string path)
    {
        if (string.IsNullOrEmpty(path)) return;
        try { path = Path.GetFullPath(path.Trim()); } catch { return; }
        foreach (var r in roots) if (string.Equals(r, path, StringComparison.OrdinalIgnoreCase)) return;
        roots.Add(path);
    }

    void AddLibsFromVdf(List<string> roots, string root)
    {
        try
        {
            string vdf = Path.Combine(root, "steamapps", "libraryfolders.vdf");
            if (!File.Exists(vdf)) return;
            foreach (var line in File.ReadAllLines(vdf))
            {
                int k = line.IndexOf("path");
                if (k < 0) continue;
                int a = line.IndexOf('"', k);
                if (a < 0) continue;
                int b = line.IndexOf('"', a + 1);
                if (b < 0) continue;
                AddRoot(roots, line.Substring(a + 1, b - a - 1));
            }
        }
        catch { }
    }

    string DetectWeConfigFromProcess()
    {
        foreach (var name in new[] { "wallpaper64", "wallpaper32" })
        {
            try
            {
                foreach (var proc in Process.GetProcessesByName(name))
                {
                    try
                    {
                        string exe = proc.MainModule.FileName;
                        string cfg = Path.Combine(Path.GetDirectoryName(exe), "config.json");
                        if (File.Exists(cfg)) return cfg;
                    }
                    catch { }
                }
            }
            catch { }
        }
        return null;
    }

    string DetectWeConfig()
    {
        string fromProc = DetectWeConfigFromProcess();
        if (!string.IsNullOrEmpty(fromProc)) return fromProc;
        var roots = new List<string>();
        AddRoot(roots, ReadReg(@"Software\Valve\Steam", "SteamPath", true));
        AddRoot(roots, ReadReg(@"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath", false));
        AddRoot(roots, ReadReg(@"SOFTWARE\Valve\Steam", "InstallPath", false));
        foreach (var root in roots.ToArray()) AddLibsFromVdf(roots, root);
        try
        {
            foreach (var d in DriveInfo.GetDrives())
            {
                if (d.DriveType != DriveType.Fixed) continue;
                string dr = d.Name.TrimEnd(Path.DirectorySeparatorChar);
                AddRoot(roots, Path.Combine(dr, "SteamLibrary"));
                AddRoot(roots, Path.Combine(dr, "Steam"));
                AddRoot(roots, Path.Combine(dr, "Games", "Steam"));
                AddRoot(roots, Path.Combine(dr, "Program Files (x86)", "Steam"));
                AddRoot(roots, Path.Combine(dr, "Program Files", "Steam"));
            }
        }
        catch { }
        foreach (var root in roots)
        {
            try
            {
                string p = Path.Combine(root, "steamapps", "common", "wallpaper_engine", "config.json");
                if (File.Exists(p)) return p;
            }
            catch { }
        }
        return null;
    }

    string GetDataDir()
    {
        return dataDir;
    }

    // 页面通过内置代理把当前界面模式写进 ui-state.txt，桥接器用它决定是否接管桌面点击
    void RefreshUiMode()
    {
        RefreshUiMode(false);
    }

    void RefreshUiMode(bool force)
    {
        if ((DateTime.UtcNow - lastUiMemUtc).TotalSeconds <= 20) return;
        if (!force && (DateTime.Now - lastUiModeRead).TotalMilliseconds < 250) return;
        lastUiModeRead = DateTime.Now;
        try
        {
            string f = Path.Combine(GetDataDir(), "ui-state.txt");
            if (!File.Exists(f))
            {
                if (lastUiMemUtc != DateTime.MinValue) uiMode = "capsule";
                return;
            }
            if ((DateTime.Now - File.GetLastWriteTime(f)).TotalSeconds > 20)
            {
                uiMode = "capsule";
                return;
            }
            string t = File.ReadAllText(f).Trim().ToLowerInvariant();
            if (t == "theater" || t == "card" || t == "capsule" || t == "pure") uiMode = t;
        }
        catch { }
    }

    void ApplyDrawerRectString(string t)
    {
        if (string.IsNullOrEmpty(t))
        {
            hasDrawerRect = false;
            lastDrawerMemUtc = DateTime.UtcNow;
            return;
        }
        string[] parts = t.Split(',');
        double l, tp, r, b;
        if (parts.Length == 4 &&
            double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out l) &&
            double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out tp) &&
            double.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out r) &&
            double.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out b) &&
            r > l && b > tp)
        {
            drawerLeft = l;
            drawerTop = tp;
            drawerRight = r;
            drawerBottom = b;
            hasDrawerRect = true;
            lastDrawerMemUtc = DateTime.UtcNow;
            return;
        }
        hasDrawerRect = false;
        lastDrawerMemUtc = DateTime.UtcNow;
    }

    void RefreshDrawerRect(bool force)
    {
        if ((DateTime.UtcNow - lastDrawerMemUtc).TotalSeconds <= 20) return;
        if (!force && (DateTime.Now - lastDrawerRectRead).TotalMilliseconds < 250) return;
        lastDrawerRectRead = DateTime.Now;
        hasDrawerRect = false;
    }

    bool IsCursorInDrawer(Native.POINT pt, IntPtr hwnd, bool forceRefresh, out int cx, out int cy)
    {
        cx = 0;
        cy = 0;
        RefreshDrawerRect(forceRefresh);
        Native.RECT r;
        if (!Native.GetWindowRect(hwnd, out r)) return false;
        int w = r.Right - r.Left;
        int h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) return false;
        cx = pt.X - r.Left;
        cy = pt.Y - r.Top;
        if (!hasDrawerRect) return false;
        double rx = (double)cx / w;
        double ry = (double)cy / h;
        return rx >= drawerLeft && rx <= drawerRight && ry >= drawerTop && ry <= drawerBottom;
    }

    string HttpCallSimple(string method, string url, string body, int timeoutMs)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.Timeout = timeoutMs;
            if (body != null)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(body);
                req.ContentType = "application/x-www-form-urlencoded";
                req.ContentLength = bytes.Length;
                using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
            }
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return sr.ReadToEnd();
        }
        catch { return null; }
    }

    bool IsNeteaseServerCompatible(string expectedDataDir, int timeoutMs = 450)
    {
        string ping = HttpCallSimple("GET", "http://127.0.0.1:" + NET_PORT + "/api/ping", null, timeoutMs);
        if (string.IsNullOrEmpty(ping)) return false;
        var mVer = Regex.Match(ping, "\"bridgeVer\"\\s*:\\s*(\\d+)");
        if (!mVer.Success) return false;
        int ver = 0;
        int.TryParse(mVer.Groups[1].Value, out ver);
        if (ver < EXPECTED_NETEASE_VER) return false;
        var mData = Regex.Match(ping, "\"dataDir\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"");
        if (!mData.Success) return false;
        string runningDir = mData.Groups[1].Value.Replace("\\\\", "\\");
        try
        {
            if (!string.Equals(Path.GetFullPath(runningDir).TrimEnd('\\'), Path.GetFullPath(expectedDataDir).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                return false;
        }
        catch { return false; }
        return true;
    }

    void TerminateOldNeteaseServers(string expectedDataDir)
    {
        HttpCallSimple("POST", "http://127.0.0.1:" + NET_PORT + "/api/shutdown", "", 500);
        var waitSw = Stopwatch.StartNew();
        while (waitSw.ElapsedMilliseconds < 1100 && IsPortOpen(NET_PORT)) Thread.Sleep(80);
        if (!IsPortOpen(NET_PORT)) return;

        // 兜底：清理未提供 /api/shutdown 的旧版代理（旧 NeteaseBridge 或旧版 runtime）
        try
        {
            foreach (var p in Process.GetProcessesByName("node"))
            {
                try
                {
                    string mod = p.MainModule != null ? p.MainModule.FileName : "";
                    if (!string.IsNullOrEmpty(mod) &&
                        (mod.IndexOf("NeteaseBridge", StringComparison.OrdinalIgnoreCase) >= 0 ||
                         mod.IndexOf("Nientum", StringComparison.OrdinalIgnoreCase) >= 0 ||
                         mod.IndexOf("runtime\\proxy-", StringComparison.OrdinalIgnoreCase) >= 0 ||
                         mod.IndexOf("runtime/proxy-", StringComparison.OrdinalIgnoreCase) >= 0 ||
                         string.Equals(Path.GetDirectoryName(mod), expectedDataDir, StringComparison.OrdinalIgnoreCase)))
                    {
                        Log("terminating legacy proxy pid=" + p.Id + " path=" + mod);
                        p.Kill();
                        p.WaitForExit(1200);
                    }
                }
                catch { }
            }
        }
        catch { }
    }

    int SafeExitCode(Process p)
    {
        try { return p != null && p.HasExited ? p.ExitCode : -1; }
        catch { return -1; }
    }

    void OnProxyExited(Process proc)
    {
        int code = SafeExitCode(proc);
        Log("proxy process exited; code=" + code);
        lock (neteaseLock)
        {
            if (neteaseProc == proc)
            {
                neteaseProc = null;
                                neteaseReady = false;
                neteaseWasRunning = false;
            }
        }
        try { proc.Dispose(); } catch { }
    }

    void LogProxy(string line, bool err)
    {
        try
        {
            string clean = Regex.Replace(line, "\u001B\\[[0-9;]*m", "");
            lock (proxyLogLock)
            {
                var fi = new FileInfo(proxyLogPath);
                if (fi.Exists && fi.Length > 1024 * 1024) File.Delete(proxyLogPath);
                File.AppendAllText(proxyLogPath, DateTime.Now.ToString("HH:mm:ss.fff") + (err ? " [err] " : " ") + clean + "\r\n", Encoding.UTF8);
            }
        }
        catch { }
    }

    void WaitProxyReady(Process proc)
    {
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < 20000)
        {
            if (proc.HasExited)
            {
                Log("proxy exited before ready; code=" + SafeExitCode(proc));
                return;
            }
            if (IsNeteaseServerCompatible(GetDataDir()))
            {
                lock (neteaseLock)
                {
                    if (neteaseProc == proc)
                    {
                        neteaseReady = true;
                        nextNeteaseHealthCheck = DateTime.UtcNow.AddSeconds(10);
                        Log("proxy ready in " + sw.ElapsedMilliseconds + " ms");
                    }
                }
                return;
            }
            Thread.Sleep(250);
        }
        Log("proxy not ready after 20s; health check will retry");
    }

    void QueueNeteaseHealthCheck()
    {
        lock (neteaseHealthLock)
        {
            if (neteaseHealthChecking) return;
            neteaseHealthChecking = true;
        }
        ThreadPool.QueueUserWorkItem(delegate
        {
            bool ok = false;
            try { ok = IsNeteaseServerCompatible(GetDataDir(), 2500); } catch { }
            lock (neteaseHealthLock) { neteaseHealthChecking = false; }
            if (ok)
            {
                lock (neteaseLock) { neteaseHealthFailures = 0; }
                return;
            }
            if (noNetease || !weRunning || !currentIsNientum) return;
            int fails;
            lock (neteaseLock) { fails = ++neteaseHealthFailures; }
            if (fails < 2)
            {
                Log("proxy health ping failed (" + fails + "/2)");
                return;
            }
            Log("proxy health check failed twice; restarting");
            StopNeteaseServer();
            lock (neteaseLock) { neteaseLastStartUtc = DateTime.MinValue; }
            EnsureNeteaseServer();
        });
    }

    void EnsureNeteaseServer()
    {
        lock (neteaseLock)
        {
            if (noNetease) return;
            if (proxyRuntime == null)
            {
                if (!proxyRuntimeMissingLogged)
                {
                    proxyRuntimeMissingLogged = true;
                    Log("proxy runtime missing; cannot start netease proxy");
                }
                return;
            }
            DateTime nowUtc = DateTime.UtcNow;
            if (neteaseProc == null && neteaseReady && neteaseWasRunning)
            {
                // 接管的是外部已在运行的代理：没有 Process 句柄，靠后台健康检查确认存活，
                // 避免每秒都在 UI 线程上 ping 造成滚轮钩子卡顿。
                if (nowUtc >= nextNeteaseHealthCheck)
                {
                    nextNeteaseHealthCheck = nowUtc.AddSeconds(10);
                    QueueNeteaseHealthCheck();
                }
                return;
            }
            if (neteaseProc != null)
            {
                if (!neteaseProc.HasExited)
                {
                    if (!neteaseReady)
                    {
                        if (neteaseLastStartUtc != DateTime.MinValue && (nowUtc - neteaseLastStartUtc).TotalSeconds < 25)
                            return;
                        Log("proxy not ready after 25s; restarting");
                        try { neteaseProc.Kill(); neteaseProc.WaitForExit(1500); } catch { }
                        neteaseProc = null;
                        neteaseReady = false;
                        neteaseWasRunning = false;
                    }
                    else
                    {
                        if (nowUtc >= nextNeteaseHealthCheck)
                        {
                            nextNeteaseHealthCheck = nowUtc.AddSeconds(10);
                            QueueNeteaseHealthCheck();
                        }
                        return;
                    }
                }
                else
                {
                    Log("proxy process gone; code=" + SafeExitCode(neteaseProc));
                    try { neteaseProc.Dispose(); } catch { }
                    neteaseProc = null;
                    neteaseReady = false;
                    neteaseWasRunning = false;
                }
            }
            if (IsPortOpen(NET_PORT))
            {
                if (IsNeteaseServerCompatible(GetDataDir()))
                {
                    neteaseReady = true;
                    neteaseWasRunning = true;
                    neteaseHealthFailures = 0;
                    neteaseLastStartUtc = nowUtc;
                    nextNeteaseHealthCheck = nowUtc.AddSeconds(10);
                    if (!neteaseAdoptLogged)
                    {
                        neteaseAdoptLogged = true;
                        Log("proxy already running; adopted on port " + NET_PORT);
                    }
                    QueueNeteaseHealthCheck();
                    return;
                }
                Log("existing server on port " + NET_PORT + " is stale; replacing");
                TerminateOldNeteaseServers(GetDataDir());
            }
            if (neteaseLastStartUtc != DateTime.MinValue && (nowUtc - neteaseLastStartUtc).TotalSeconds < 5)
                return;
            try
            {
                var psi = new ProcessStartInfo();
                psi.FileName = proxyRuntime.NodeExe;
                psi.Arguments = "\"" + proxyRuntime.ServerJs + "\"";
                psi.WorkingDirectory = proxyRuntime.ProxyDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                psi.EnvironmentVariables["NIENTUM_DATA_DIR"] = GetDataDir();
                psi.EnvironmentVariables["NIENTUM_PROXY_PORT"] = NET_PORT.ToString(CultureInfo.InvariantCulture);
                psi.EnvironmentVariables["NIENTUM_IPV4"] = "1";
                Process proc = Process.Start(psi);
                if (proc == null) throw new Exception("Process.Start returned null");
                neteaseProc = proc;
                neteaseWasRunning = true;
                neteaseReady = false;
                neteaseHealthFailures = 0;
                neteaseAdoptLogged = false;
                neteaseLastStartUtc = nowUtc;
                proc.EnableRaisingEvents = true;
                proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) LogProxy(e.Data, false); };
                proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) LogProxy(e.Data, true); };
                proc.Exited += delegate { OnProxyExited(proc); };
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                Log("proxy process started; pid=" + proc.Id + "; node=" + proxyRuntime.NodeExe);
                ThreadPool.QueueUserWorkItem(delegate(object st) { WaitProxyReady(proc); });
            }
            catch (Exception ex)
            {
                Log("proxy start error: " + ex.Message);
                neteaseProc = null;
                                neteaseReady = false;
                neteaseWasRunning = false;
            }
        }
    }

    void StopNeteaseServer()
    {
        Process proc;
        lock (neteaseLock)
        {
            if (neteaseProc == null && !neteaseWasRunning) return;
            proc = neteaseProc;
            neteaseProc = null;
                        neteaseReady = false;
            neteaseWasRunning = false;
            neteaseHealthFailures = 0;
            neteaseAdoptLogged = false;
            nextNeteaseHealthCheck = DateTime.MinValue;
        }
        try { HttpCallSimple("POST", "http://127.0.0.1:" + NET_PORT + "/api/shutdown", "", 450); } catch { }
        if (proc != null)
        {
            try
            {
                if (!proc.HasExited) proc.Kill();
                proc.WaitForExit(1200);
                Log("proxy stopped");
            }
            catch (Exception ex) { Log("proxy stop error: " + ex.Message); }
            try { proc.Dispose(); } catch { }
        }
    }

    public void SetNoNetease()
    {
        noNetease = true;
        StopNeteaseServer();
    }

    // 桥接器启动时立即拉起网易云代理，安装器/重启器无需再单独启动 node；
    // 切到非 Nientum 壁纸时 SyncCore 仍会在 3 次检测后停止它。
    public void StartNeteaseNow()
    {
        if (noNetease) return;
        EnsureNeteaseServer();
    }

    void InstallHook()
    {
        if (hookHandle != IntPtr.Zero) return;
        hookHandle = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, hookProc, Native.GetModuleHandle(null), 0);
        if (hookHandle == IntPtr.Zero)
        {
            Log("SetWindowsHookEx failed: " + Marshal.GetLastWin32Error());
            return;
        }
        if (stateTimer != null && !stateTimer.Enabled) stateTimer.Start();
        Log("mouse hook installed");
    }

    void UninstallHook()
    {
        if (stateTimer != null && stateTimer.Enabled) stateTimer.Stop();
        desktopIconRects.Clear();
        leftForwarded = false;
        rightForwarded = false;
        if (hookHandle == IntPtr.Zero) return;
        Native.UnhookWindowsHookEx(hookHandle);
        hookHandle = IntPtr.Zero;
        cachedWallpaperHwnd = IntPtr.Zero;
        Log("mouse hook removed");
    }

    // 钩子/定时器只读字段，文件读取统一放到 SyncCore 里，避免在低级钩子回调中做 I/O
    bool IsNientumCurrent()
    {
        return currentIsNientum;
    }

    void RefreshNientum()
    {
        try
        {
            string text = File.ReadAllText(weConfigPath, Encoding.UTF8);
            currentIsNientum = text.IndexOf(wallpaperKeyword, StringComparison.OrdinalIgnoreCase) >= 0;
        }
        catch
        {
            currentIsNientum = false;
        }
    }

    // 低级钩子 pt 是物理像素，WindowFromPoint 需要逻辑坐标，直接 GetCursorPos
    bool IsDesktopUnderCursor(out string underCls, out string rootCls)
    {
        Native.POINT pt;
        if (!Native.GetCursorPos(out pt)) { underCls = ""; rootCls = ""; return false; }
        IntPtr h = Native.WindowFromPoint(pt);
        if (h == IntPtr.Zero) { underCls = ""; rootCls = ""; return false; }
        IntPtr root = Native.GetAncestor(h, Native.GA_ROOT);
        if (root == IntPtr.Zero) root = h;
        underCls = Native.ClassOf(h);
        rootCls = Native.ClassOf(root);
        if (rootCls == "Progman" || rootCls == "WorkerW"
            || underCls == "Progman" || underCls == "WorkerW" || underCls == "SysListView32")
            return true;
        IntPtr wpHwnd = FindWallpaperWindow();
        if (wpHwnd != IntPtr.Zero && (h == wpHwnd || root == wpHwnd))
            return true;
        return false;
    }

    int SendLvmCount(IntPtr lv)
    {
        IntPtr result;
        if (Native.SendMessageTimeout(lv, Native.LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero,
                Native.SMTO_ABORTIFHUNG | Native.SMTO_BLOCK, 300, out result) == IntPtr.Zero)
            return 0;
        return result.ToInt32();
    }

    bool IsDesktopListView(IntPtr h)
    {
        if (Native.ClassOf(h) != "SysListView32") return false;
        if (!Native.IsWindowVisible(h)) return false;
        uint pid;
        Native.GetWindowThreadProcessId(h, out pid);
        try
        {
            if (!Process.GetProcessById((int)pid).ProcessName.Equals("explorer", StringComparison.OrdinalIgnoreCase))
                return false;
        }
        catch { return false; }
        IntPtr root = Native.GetAncestor(h, Native.GA_ROOT);
        string rootCls = Native.ClassOf(root);
        if (rootCls != "Progman" && rootCls != "WorkerW") return false;
        return SendLvmCount(h) > 0;
    }

    IntPtr FindDesktopListView()
    {
        if (desktopListView != IntPtr.Zero &&
            (DateTime.Now - lastDesktopLvScan).TotalSeconds < 3 &&
            Native.IsWindow(desktopListView))
            return desktopListView;

        lastDesktopLvScan = DateTime.Now;
        IntPtr found = IntPtr.Zero;
        Native.EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (found != IntPtr.Zero) return false;
            if (IsDesktopListView(h)) { found = h; return false; }
            Native.EnumChildWindows(h, delegate(IntPtr ch, IntPtr l2)
            {
                if (found != IntPtr.Zero) return false;
                if (IsDesktopListView(ch)) { found = ch; return false; }
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);

        desktopListView = found;
        return desktopListView;
    }

    // 桌面图标是 SysListView32 的 item，不是独立 HWND。用 LVM_GETITEMRECT 读图标矩形：
    // LVM 消息 >= WM_USER，跨进程时指针不会被系统编组，必须在 Explorer 进程里分配缓冲区。
    void RefreshDesktopIconRects(IntPtr lv)
    {
        if ((DateTime.Now - lastDesktopIconScan).TotalSeconds < 1.5) return;
        lastDesktopIconScan = DateTime.Now;

        double scale = GetScale(lv);
        if (scale < 0.5 || scale > 4.0) scale = 1.0;
        desktopIconScale = scale;

        int count = SendLvmCount(lv);
        if (count <= 0)
        {
            desktopIconRects.Clear();
            return;
        }

        uint pid;
        Native.GetWindowThreadProcessId(lv, out pid);
        IntPtr hp = Native.OpenProcess(
            Native.PROCESS_VM_OPERATION | Native.PROCESS_VM_READ | Native.PROCESS_VM_WRITE | Native.PROCESS_QUERY_INFORMATION,
            false, pid);
        if (hp == IntPtr.Zero)
        {
            if (!loggedIconFail) { Log("desktop icon scan: OpenProcess failed"); loggedIconFail = true; }
            return;
        }

        IntPtr remote = Native.VirtualAllocEx(hp, IntPtr.Zero, new UIntPtr(64),
            Native.MEM_COMMIT | Native.MEM_RESERVE, Native.PAGE_READWRITE);
        if (remote == IntPtr.Zero)
        {
            Native.CloseHandle(hp);
            if (!loggedIconFail) { Log("desktop icon scan: VirtualAllocEx failed"); loggedIconFail = true; }
            return;
        }

        // 桥接器是 DPI-unaware 进程，GetCursorPos 给逻辑坐标；LVM 返回物理像素，
        // Explorer 是 per-monitor aware，所以这里统一换算到物理屏幕坐标再比较。
        int originX = 0, originY = 0;
        Native.RECT wr;
        if (Native.GetWindowRect(lv, out wr))
        {
            originX = (int)Math.Round(wr.Left * scale);
            originY = (int)Math.Round(wr.Top * scale);
        }

        var rects = new List<Native.RECT>();
        UIntPtr rectSize = new UIntPtr((uint)Marshal.SizeOf(typeof(Native.RECT)));
        try
        {
            for (int i = 0; i < count; i++)
            {
                Native.RECT r = new Native.RECT();
                r.Left = (int)Native.LVIR_BOUNDS;
                IntPtr written;
                if (!Native.WriteProcessMemory(hp, remote, ref r, rectSize, out written)) continue;

                IntPtr result;
                Native.SendMessageTimeout(lv, Native.LVM_GETITEMRECT, (IntPtr)i, remote,
                    Native.SMTO_ABORTIFHUNG | Native.SMTO_BLOCK, 300, out result);

                IntPtr read;
                if (!Native.ReadProcessMemory(hp, remote, out r, rectSize, out read)) continue;

                r.Left += originX;
                r.Right += originX;
                r.Top += originY;
                r.Bottom += originY;
                if (r.Right > r.Left && r.Bottom > r.Top) rects.Add(r);
            }
        }
        finally
        {
            Native.VirtualFreeEx(hp, remote, UIntPtr.Zero, Native.MEM_RELEASE);
            Native.CloseHandle(hp);
        }

        int oldCount = desktopIconRects.Count;
        desktopIconRects.Clear();
        desktopIconRects.AddRange(rects);
        if (!loggedIconRects || rects.Count != oldCount)
        {
            Log("desktop icon rects: " + rects.Count + " scale=" + scale.ToString("0.##"));
            loggedIconRects = true;
        }
    }

    bool IsCursorOverDesktopIconFast(Native.POINT pt)
    {
        if (desktopIconRects.Count == 0) return false;
        int px = (int)Math.Round(pt.X * desktopIconScale);
        int py = (int)Math.Round(pt.Y * desktopIconScale);
        for (int i = 0; i < desktopIconRects.Count; i++)
        {
            var r = desktopIconRects[i];
            if (px >= r.Left && px < r.Right && py >= r.Top && py < r.Bottom) return true;
        }
        return false;
    }

    bool IsCursorOverDesktopIcon()
    {
        IntPtr lv = FindDesktopListView();
        if (lv == IntPtr.Zero) return false;
        RefreshDesktopIconRects(lv);
        if (desktopIconRects.Count == 0) return false;

        Native.POINT pt;
        if (!Native.GetCursorPos(out pt)) return false;
        return IsCursorOverDesktopIconFast(pt);
    }

    bool CheckWallpaperCandidate(IntPtr h)
    {
        if (Native.ClassOf(h) != "Chrome_WidgetWin_1") return false;
        if (!Native.IsWindowVisible(h)) return false;
        uint pid;
        Native.GetWindowThreadProcessId(h, out pid);
        try
        {
            string pname = Process.GetProcessById((int)pid).ProcessName;
            if (!pname.Equals("webwallpaper64", StringComparison.OrdinalIgnoreCase) &&
                !pname.Equals("webwallpaper32", StringComparison.OrdinalIgnoreCase))
                return false;
        }
        catch { return false; }
        Native.RECT r;
        if (!Native.GetWindowRect(h, out r)) return false;
        int w = r.Right - r.Left;
        int hgt = r.Bottom - r.Top;
        int sw = Native.GetSystemMetrics(0);
        int sh = Native.GetSystemMetrics(1);
        if (sw <= 0 || sh <= 0) return false;
        return w >= sw * 0.9 && hgt >= sh * 0.9;
    }

    IntPtr FindWallpaperWindow()
    {
        if ((DateTime.Now - lastHwndScan).TotalSeconds < 2 &&
            cachedWallpaperHwnd != IntPtr.Zero && Native.IsWindowVisible(cachedWallpaperHwnd))
            return cachedWallpaperHwnd;

        lastHwndScan = DateTime.Now;
        scanFoundHwnd = IntPtr.Zero;

        Native.EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (scanFoundHwnd != IntPtr.Zero) return false;
            if (CheckWallpaperCandidate(h)) { scanFoundHwnd = h; return false; }
            Native.EnumChildWindows(h, delegate(IntPtr ch, IntPtr l2)
            {
                if (scanFoundHwnd != IntPtr.Zero) return false;
                if (CheckWallpaperCandidate(ch)) { scanFoundHwnd = ch; return false; }
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);

        cachedWallpaperHwnd = scanFoundHwnd;
        return cachedWallpaperHwnd;
    }

    static Dictionary<string, string> ParseFormBody(string body)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(body)) return map;
        foreach (string pair in body.Split('&'))
        {
            if (string.IsNullOrEmpty(pair)) continue;
            int eq = pair.IndexOf('=');
            if (eq < 0)
            {
                map[Uri.UnescapeDataString(pair.Replace('+', ' '))] = "";
            }
            else
            {
                string k = Uri.UnescapeDataString(pair.Substring(0, eq).Replace('+', ' '));
                string v = Uri.UnescapeDataString(pair.Substring(eq + 1).Replace('+', ' '));
                map[k] = v;
            }
        }
        return map;
    }

    void RunOnUi(Action act)
    {
        try
        {
            if (uiInvokeCtrl != null && uiInvokeCtrl.IsHandleCreated)
                uiInvokeCtrl.BeginInvoke(act);
        }
        catch { }
    }

    void StartControlServer()
    {
        try
        {
            ctrlStopping = false;
            ctrlListener = new TcpListener(IPAddress.Loopback, CTRL_PORT);
            ctrlListener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            ctrlListener.Start();
            var t = new Thread(ControlAcceptLoop);
            t.IsBackground = true;
            t.Start();
            Log("control ipc listening on 127.0.0.1:" + CTRL_PORT);
        }
        catch (Exception ex)
        {
            Log("control ipc start failed: " + ex.Message);
        }
    }

    void StopControlServer()
    {
        ctrlStopping = true;
        try { if (ctrlListener != null) ctrlListener.Stop(); } catch { }
    }

    void ControlAcceptLoop()
    {
        while (!ctrlStopping)
        {
            try
            {
                var client = ctrlListener.AcceptTcpClient();
                ThreadPool.QueueUserWorkItem(_ => HandleControlClient(client));
            }
            catch
            {
                if (ctrlStopping) break;
                Thread.Sleep(50);
            }
        }
    }

    void HandleControlClient(TcpClient client)
    {
        using (client)
        {
            try
            {
                client.ReceiveTimeout = 2000;
                client.SendTimeout = 2000;
                var stream = client.GetStream();
                byte[] buf = new byte[8192];
                int total = 0;
                int headerEnd = -1;
                while (total < buf.Length)
                {
                    int n = stream.Read(buf, total, buf.Length - total);
                    if (n <= 0) break;
                    total += n;
                    string probe = Encoding.ASCII.GetString(buf, 0, total);
                    headerEnd = probe.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                    if (headerEnd >= 0) break;
                }
                if (headerEnd < 0) return;

                string headerText = Encoding.ASCII.GetString(buf, 0, headerEnd);
                string[] lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
                string[] reqParts = lines[0].Split(' ');
                string method = reqParts.Length > 0 ? reqParts[0].ToUpperInvariant() : "GET";
                string rawUrl = reqParts.Length > 1 ? reqParts[1] : "/";
                int qIdx = rawUrl.IndexOf('?');
                string pathOnly = qIdx >= 0 ? rawUrl.Substring(0, qIdx) : rawUrl;
                string queryStr = qIdx >= 0 ? rawUrl.Substring(qIdx + 1) : "";

                int contentLen = 0;
                for (int i = 1; i < lines.Length; i++)
                {
                    if (lines[i].StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                    {
                        int.TryParse(lines[i].Substring(15).Trim(), out contentLen);
                        break;
                    }
                }
                int bodyOffset = headerEnd + 4;
                int haveBody = total - bodyOffset;
                byte[] bodyBytes = new byte[Math.Max(0, Math.Min(contentLen, 65536))];
                if (bodyBytes.Length > 0)
                {
                    int copyFirst = Math.Min(haveBody, bodyBytes.Length);
                    if (copyFirst > 0) Buffer.BlockCopy(buf, bodyOffset, bodyBytes, 0, copyFirst);
                    int pos = copyFirst;
                    while (pos < bodyBytes.Length)
                    {
                        int n = stream.Read(bodyBytes, pos, bodyBytes.Length - pos);
                        if (n <= 0) break;
                        pos += n;
                    }
                }
                string bodyStr = bodyBytes.Length > 0 ? Encoding.UTF8.GetString(bodyBytes) : queryStr;
                var form = ParseFormBody(bodyStr);

                string respJson = "{\"ok\":true}";
                if (pathOnly == "/bridge/status")
                {
                    respJson = "{\"ok\":true,\"ver\":" + EXPECTED_NETEASE_VER + ",\"nientum\":" + (currentIsNientum ? "true" : "false") +
                        ",\"uiMode\":\"" + EscapeJson(uiMode) + "\",\"hasDrawerRect\":" + (hasDrawerRect ? "true" : "false") +
                        ",\"shellMenuBusy\":" + (shellMenuBusy ? "true" : "false") + "}";
                }
                else if (pathOnly == "/bridge/state")
                {
                    string m;
                    if (form.TryGetValue("mode", out m))
                    {
                        string ml = (m ?? "").Trim().ToLowerInvariant();
                        if (ml == "theater" || ml == "card" || ml == "capsule" || ml == "pure")
                        {
                            uiMode = ml;
                            lastUiMemUtc = DateTime.UtcNow;
                        }
                    }
                    string drawerClosed;
                    if (form.TryGetValue("drawer", out drawerClosed) && drawerClosed.Equals("closed", StringComparison.OrdinalIgnoreCase))
                    {
                        ApplyDrawerRectString("");
                        hoverItemPath = "";
                    }
                    string dr;
                    if (form.TryGetValue("dr", out dr))
                    {
                        ApplyDrawerRectString(dr);
                    }
                    string hi;
                    if (form.TryGetValue("hoverItem", out hi))
                    {
                        hoverItemPath = hi ?? "";
                        hoverItemUtc = DateTime.UtcNow;
                    }
                }
                else if (pathOnly == "/bridge/input")
                {
                    string onStr;
                    form.TryGetValue("on", out onStr);
                    if (onStr == "1")
                    {
                        int x = 0, y = 0, w = 0, h = 0;
                        string tmp;
                        if (form.TryGetValue("x", out tmp)) int.TryParse(tmp, out x);
                        if (form.TryGetValue("y", out tmp)) int.TryParse(tmp, out y);
                        if (form.TryGetValue("w", out tmp)) int.TryParse(tmp, out w);
                        if (form.TryGetValue("h", out tmp)) int.TryParse(tmp, out h);
                        string field; form.TryGetValue("field", out field);
                        string valB64; form.TryGetValue("value", out valB64);
                        string value = "";
                        try { value = Encoding.UTF8.GetString(Convert.FromBase64String(valB64 ?? "")); } catch { value = ""; }
                        RunOnUi(() => ShowNativeInput(field ?? "", x, y, w, h, value));
                    }
                    else
                    {
                        RunOnUi(() => CommitNativeInput(false));
                    }
                }
                else if (pathOnly == "/bridge/shell-menu")
                {
                    string targetPath;
                    form.TryGetValue("path", out targetPath);
                    if (string.IsNullOrEmpty(targetPath))
                    {
                        respJson = "{\"ok\":false,\"error\":\"missing_path\"}";
                    }
                    else
                    {
                        respJson = LaunchShellMenu(targetPath, false);
                    }
                }
                else if (pathOnly == "/bridge/shutdown")
                {
                    respJson = "{\"ok\":true,\"stopping\":true}";
                    byte[] rb = Encoding.UTF8.GetBytes(respJson);
                    string hdr = "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: " + rb.Length + "\r\nConnection: close\r\n\r\n";
                    byte[] hb = Encoding.ASCII.GetBytes(hdr);
                    stream.Write(hb, 0, hb.Length);
                    stream.Write(rb, 0, rb.Length);
                    stream.Flush();
                    RunOnUi(() =>
                    {
                        UninstallHook();
                        StopNeteaseServer();
                        StopControlServer();
                        Application.Exit();
                    });
                    return;
                }

                byte[] bodyOut = Encoding.UTF8.GetBytes(respJson);
                string headerOut = "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: " + bodyOut.Length + "\r\nConnection: close\r\n\r\n";
                byte[] hdrBytes = Encoding.ASCII.GetBytes(headerOut);
                stream.Write(hdrBytes, 0, hdrBytes.Length);
                stream.Write(bodyOut, 0, bodyOut.Length);
                stream.Flush();
            }
            catch { }
        }
    }

    string LaunchShellMenu(string targetPath, bool fromHook)
    {
        if (string.IsNullOrEmpty(targetPath)) return "{\"ok\":false,\"error\":\"missing_path\"}";
        lock (shellMenuLock)
        {
            if (shellMenuBusy || (DateTime.UtcNow - lastShellMenuUtc).TotalMilliseconds < 350)
                return "{\"ok\":true,\"invoked\":false,\"deduped\":true}";
            shellMenuBusy = true;
            lastShellMenuUtc = DateTime.UtcNow;
        }

        try
        {
            if (fromHook)
                HttpCallSimple("POST", "http://127.0.0.1:" + NET_PORT + "/api/fs/context-menu/event", "state=open&path=" + Uri.EscapeDataString(targetPath), 250);

            string b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(targetPath));
            var psi = new ProcessStartInfo();
            psi.FileName = exePath;
            psi.Arguments = "--shell-menu --path-b64 " + b64 + " --cursor";
            psi.WorkingDirectory = Path.GetDirectoryName(exePath);
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.CreateNoWindow = true;

            var p = Process.Start(psi);
            string firstLine = "";
            if (p != null)
            {
                firstLine = p.StandardOutput.ReadLine() ?? "";
                Log("shell-menu path=" + targetPath + " hook=" + fromHook + " result=" + firstLine);
            }
            if (string.IsNullOrEmpty(firstLine)) firstLine = "{\"ok\":true,\"invoked\":false}";
            if (fromHook)
            {
                bool invoked = firstLine.IndexOf("\"invoked\":true", StringComparison.OrdinalIgnoreCase) >= 0;
                HttpCallSimple("POST", "http://127.0.0.1:" + NET_PORT + "/api/fs/context-menu/event", "state=done&invoked=" + (invoked ? "1" : "0"), 350);
            }
            return firstLine;
        }
        catch (Exception ex)
        {
            Log("shell-menu error: " + ex.Message);
            if (fromHook) HttpCallSimple("POST", "http://127.0.0.1:" + NET_PORT + "/api/fs/context-menu/event", "state=done&invoked=0", 250);
            return "{\"ok\":false,\"error\":\"" + EscapeJson(ex.Message) + "\"}";
        }
        finally
        {
            lastShellMenuUtc = DateTime.UtcNow;
            shellMenuBusy = false;
        }
    }

    void TriggerShellMenuFromHook(string targetPath)
    {
        if (string.IsNullOrEmpty(targetPath)) return;
        ThreadPool.QueueUserWorkItem(_ => LaunchShellMenu(targetPath, true));
    }

    // WE 的网页壁纸窗口拒绝被激活（日志里 fg=False/focus=0），所以改用原生输入框浮层：
    // 在页面输入框的位置盖一个真正的 WinForms 输入框，输入法和键盘都正常，确认后写回页面。
    void CreateNativeInput()
    {
        nativeForm = new Form();
        nativeForm.FormBorderStyle = FormBorderStyle.None;
        nativeForm.ShowInTaskbar = false;
        nativeForm.TopMost = true;
        nativeForm.StartPosition = FormStartPosition.Manual;
        nativeForm.ControlBox = false;
        nativeForm.MinimizeBox = false;
        nativeForm.MaximizeBox = false;
        nativeForm.BackColor = Color.FromArgb(30, 24, 18);
        nativeForm.Padding = new Padding(6, 4, 6, 4);
        nativeForm.AutoScaleMode = AutoScaleMode.None;

        nativeBox = new TextBox();
        nativeBox.BorderStyle = BorderStyle.None;
        nativeBox.BackColor = nativeForm.BackColor;
        nativeBox.ForeColor = Color.FromArgb(246, 222, 178);
        nativeBox.Font = new Font("Microsoft YaHei UI", 12f, FontStyle.Regular, GraphicsUnit.Point);
        nativeBox.Dock = DockStyle.Fill;
        nativeBox.KeyDown += (s, e) =>
        {
            if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; CommitNativeInput(true); }
            else if (e.KeyCode == Keys.Escape) { e.SuppressKeyPress = true; CommitNativeInput(false); }
        };
        nativeForm.Controls.Add(nativeBox);
        nativeForm.Paint += (s, e) =>
        {
            using (var pen = new Pen(Color.FromArgb(229, 198, 135), 1f))
                e.Graphics.DrawRectangle(pen, 0, 0, nativeForm.Width - 1, nativeForm.Height - 1);
        };
        nativeForm.Deactivate += (s, e) => CommitNativeInput(true);
    }

    void ShowNativeInput(string field, int x, int y, int w, int h, string value)
    {
        try
        {
            if (nativeForm == null) CreateNativeInput();
            if (nativeForm.Visible)
            {
                if (nativeField == field)
                {
                    nativeForm.Activate();
                    nativeBox.Focus();
                    return;
                }
                CommitNativeInput(true);
            }
            IntPtr hwnd = FindWallpaperWindow();
            Native.RECT wr;
            if (hwnd == IntPtr.Zero || !Native.GetWindowRect(hwnd, out wr))
            {
                Log("native input: no wallpaper window");
                return;
            }
            int left = wr.Left + Math.Max(0, x);
            int top = wr.Top + Math.Max(0, y);
            int width = Math.Max(120, w + 2);
            int height = Math.Max(28, h + 2);
            int sw = Native.GetSystemMetrics(0);
            int sh = Native.GetSystemMetrics(1);
            if (sw > 0 && left + width > sw) left = Math.Max(0, sw - width);
            if (sh > 0 && top + height > sh) top = Math.Max(0, sh - height);

            nativeField = field;
            nativeBox.Text = value;
            nativeForm.Bounds = new Rectangle(left, top, width, height);
            nativeForm.Show();

            // WE 窗口拒绝前台激活时，单纯 SetForegroundWindow 会返回 false，输入框拿不到键盘焦点。
            // 临时挂到当前前台线程再设置焦点，是 Win32 下绕开前台锁的标准做法。
            uint myTid = Native.GetCurrentThreadId();
            IntPtr fg = Native.GetForegroundWindow();
            uint fgPid = 0;
            uint fgTid = fg != IntPtr.Zero ? Native.GetWindowThreadProcessId(fg, out fgPid) : 0;
            bool attached = false;
            if (fgTid != 0 && fgTid != myTid) {
                attached = Native.AttachThreadInput(myTid, fgTid, true);
            }
            bool formFg = Native.SetForegroundWindow(nativeForm.Handle);
            Native.SetFocus(nativeBox.Handle);
            if (attached) Native.AttachThreadInput(myTid, fgTid, false);
            nativeForm.Activate();
            nativeBox.Focus();
            nativeBox.SelectAll();
            bool focusOk = Native.GetFocus() == nativeBox.Handle;
            lastNativeShow = DateTime.Now;
            Log("native input show field=" + field + " rect=" + left + "," + top + "," + width + "," + height +
                " len=" + value.Length + " fg=" + formFg + " attached=" + attached + " focus=" + focusOk);
            try {
                nativeForm.BeginInvoke(new Action(() =>
                {
                    try {
                        if (nativeForm == null || !nativeForm.Visible || nativeField != field) return;
                        uint t2 = Native.GetCurrentThreadId();
                        IntPtr fg2 = Native.GetForegroundWindow();
                        uint p2 = 0;
                        uint ft2 = fg2 != IntPtr.Zero ? Native.GetWindowThreadProcessId(fg2, out p2) : 0;
                        bool at2 = false;
                        if (ft2 != 0 && ft2 != t2) at2 = Native.AttachThreadInput(t2, ft2, true);
                        Native.SetForegroundWindow(nativeForm.Handle);
                        Native.SetFocus(nativeBox.Handle);
                        if (at2) Native.AttachThreadInput(t2, ft2, false);
                        nativeBox.Focus();
                        nativeBox.SelectAll();
                    } catch { }
                }));
            } catch { }
        }
        catch (Exception ex) { Log("native input show error: " + ex.Message); }
    }

    void CommitNativeInput(bool commit)
    {
        if (nativeForm == null || !nativeForm.Visible || nativeHiding) return;
        nativeHiding = true;
        string field = nativeField;
        string text = nativeBox.Text;
        try { nativeForm.Hide(); } catch { }
        nativeHiding = false;
        if (commit) WriteNativeInput(field, text);
    }

    void WriteNativeInput(string field, string text)
    {
        try
        {
            long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
            long seq = ++nativeSeq;
            string json = "{\"seq\":" + seq + ",\"field\":\"" + EscapeJson(field) +
                "\",\"text\":\"" + EscapeJson(text) + "\",\"commit\":true,\"ts\":" + now + "}";
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + NET_PORT + "/api/native-input");
                    req.Method = "POST";
                    req.Timeout = 600;
                    byte[] bytes = Encoding.UTF8.GetBytes(json);
                    req.ContentType = "application/json; charset=utf-8";
                    req.ContentLength = bytes.Length;
                    using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
                    using (var resp = req.GetResponse()) { }
                }
                catch { }
            });
            Log("native input commit field=" + field + " len=" + text.Length);
        }
        catch (Exception ex) { Log("native input write error: " + ex.Message); }
    }

    string EscapeJson(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\r': sb.Append("\\r"); break;
                case '\n': sb.Append("\\n"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    void StateTick()
    {
        try
        {
            if (hookHandle == IntPtr.Zero) return; // 没在接管 Nientum 时不读界面状态
            if (shellMenuBusy) return; // 原生右键菜单或属性对话窗打开期间保持当前焦点态，防止抽屉误收起
            RefreshUiMode();
            string underCls, rootCls;
            bool onDesktop = IsDesktopUnderCursor(out underCls, out rootCls);
            bool overIcon = onDesktop && IsCursorOverDesktopIcon();
            bool focused = onDesktop && !overIcon;
            if (focused == lastFocused) return;
            lastFocused = focused;
            SendFocusSignal(focused);
            Log("focus " + (focused ? "clear" : "blur") + (overIcon ? " (desktop icon)" : ""));
        }
        catch { }
    }

    void SendFocusSignal(bool focused)
    {
        if (!IsNientumCurrent()) return;
        IntPtr hwnd = FindWallpaperWindow();
        if (hwnd == IntPtr.Zero) return;
        double scale = GetScale(hwnd);
        int pageX = 320;
        // 页面按 CSS 像素判断：3 = 失焦模糊，13 = 清晰（见 player.js 的 e.clientY <= 3）。
        int pageY = focused ? 13 : 3;
        int winY = pageY; // y 不乘缩放，保证 1.0~3.0 的 DPI 下都落在 1..14 且分得开
        // WE 是 per-monitor DPI aware，WM_MOUSEMOVE 的 lParam 是物理像素；乘 scale 后
        // 页面收到的 CSS x 约为 300，避开滚轮信号带（25..240），不会被误当成滚轮。
        int winX = (int)Math.Round(pageX * scale);
        Log("focus signal " + (focused ? "clear" : "blur") + " x=" + winX + " y=" + winY + " scale=" + scale.ToString("0.##"));
        Native.PostMessage(hwnd, Native.WM_MOUSEMOVE, (IntPtr)Native.MK_RBUTTON, Native.MakeLParam(winX, winY));
        Native.PostMessage(hwnd, Native.WM_MOUSEMOVE, IntPtr.Zero, Native.MakeLParam(800, 500));

        // 同时经由本地 HTTP 网关同步焦点状态，彻底避免 WE 窗口非激活时丢弃 WM_MOUSEMOVE 信号
        int blurFlag = focused ? 0 : 1;
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try
            {
                var req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create("http://127.0.0.1:17988/api/focus?blur=" + blurFlag);
                req.Timeout = 400;
                using (var resp = req.GetResponse()) { }
            }
            catch { }
        });
    }

    double GetScale(IntPtr hwnd)
    {
        double scale = 1.5;
        try
        {
            uint dpi = Native.GetDpiForWindow(hwnd);
            if (dpi > 0) scale = dpi / 96.0;
        }
        catch { }
        if (scale < 0.5 || scale > 4.0) scale = 1.5;
        return scale;
    }

    // 拖动期间由桥接器补发 mousemove：WE 在按住左键时不会稳定把移动转发给页面，
    // 导致音量、分类条、歌曲列表拖不动。这里按实际光标位置补一条左键状态的移动。
    void ForwardDragMove()
    {
        if (!leftForwarded) return;
        if ((DateTime.Now - lastDragMoveSent).TotalMilliseconds < 8) return;
        lastDragMoveSent = DateTime.Now;
        Native.POINT pt;
        if (!Native.GetCursorPos(out pt)) return;
        IntPtr hwnd = FindWallpaperWindow();
        if (hwnd == IntPtr.Zero) return;
        Native.RECT r;
        if (!Native.GetWindowRect(hwnd, out r)) return;
        Native.PostMessage(hwnd, Native.WM_MOUSEMOVE, (IntPtr)Native.MK_LBUTTON,
            Native.MakeLParam(pt.X - r.Left, pt.Y - r.Top));
    }

    bool HandleActiveShellMenuMouse(int msg)
    {
        if (!shellMenuBusy) return false;
        if (msg == Native.WM_LBUTTONDOWN || msg == Native.WM_RBUTTONDOWN)
        {
            Native.POINT mpt;
            if (Native.GetCursorPos(out mpt))
            {
                IntPtr under = Native.WindowFromPoint(mpt);
                string ucls = under != IntPtr.Zero ? Native.ClassOf(under) : "";
                if (ucls != "#32768")
                {
                    IntPtr menuWnd = Native.FindWindow("#32768", null);
                    if (menuWnd != IntPtr.Zero)
                    {
                        Native.PostMessage(menuWnd, Native.WM_KEYDOWN, (IntPtr)Native.VK_ESCAPE, IntPtr.Zero);
                        Native.PostMessage(menuWnd, Native.WM_CANCELMODE, IntPtr.Zero, IntPtr.Zero);
                    }
                    if (under != IntPtr.Zero)
                    {
                        IntPtr rootUnder = Native.GetAncestor(under, Native.GA_ROOT);
                        if (rootUnder == IntPtr.Zero) rootUnder = under;
                        Native.SetForegroundWindow(rootUnder);
                    }
                    leftForwarded = false;
                    rightForwarded = false;
                    string u2, r2;
                    // 若点击目标是外部应用/任务栏，放行点击使一次点击即可切换焦点并关菜单；若在桌面/抽屉区域则拦截避免误穿透
                    return IsDesktopUnderCursor(out u2, out r2);
                }
            }
            leftForwarded = false;
            rightForwarded = false;
            return false;
        }
        if (msg == Native.WM_LBUTTONUP && leftForwarded) { leftForwarded = false; return true; }
        if (msg == Native.WM_RBUTTONUP && rightForwarded) { rightForwarded = false; return true; }
        return false;
    }

    // 把桌面左键转发给壁纸页面：WE 不向网页转发 mousedown，导致胶囊/按钮点不动。
    // 剧场模式全屏接管；卡片模式在空白桌面主舞台/底栏交互区接管；胶囊/纯净模式只接管右上角胶囊区域，避免影响桌面图标。
    bool HandleLeftClick(int msg)
    {
        if (shellMenuBusy) return HandleActiveShellMenuMouse(msg);
        if (!IsNientumCurrent()) return false;
        if (msg == Native.WM_LBUTTONUP && !leftForwarded) return false;

        string underCls, rootCls;
        if (msg == Native.WM_LBUTTONDOWN && !IsDesktopUnderCursor(out underCls, out rootCls)) return false;
        if (msg == Native.WM_LBUTTONUP && !leftForwarded && !IsDesktopUnderCursor(out underCls, out rootCls)) return false;

        if (msg == Native.WM_LBUTTONDOWN) RefreshUiMode(true);
        Native.POINT pt;
        if (!Native.GetCursorPos(out pt)) return false;
        IntPtr hwnd = FindWallpaperWindow();
        if (hwnd == IntPtr.Zero) return false;
        int dcx, dcy;
        bool inDrawer = IsCursorInDrawer(pt, hwnd, msg == Native.WM_LBUTTONDOWN, out dcx, out dcy);
        // 指针停在桌面图标上时不吞掉左键，保持 Windows 图标双击/拖拽选中原生手感（快捷抽屉覆盖区除外）
        if (msg == Native.WM_LBUTTONDOWN && uiMode != "theater" && !inDrawer && IsCursorOverDesktopIconFast(pt)) return false;

        Native.RECT r;
        if (!Native.GetWindowRect(hwnd, out r)) return false;
        int w = r.Right - r.Left;
        int h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) return false;
        int cx = pt.X - r.Left;
        int cy = pt.Y - r.Top;

        bool inCapsule = cx > w * 0.66 && cy < h * 0.16;
        bool inCardArea = (uiMode == "card") && cx > w * 0.04 && cx < w * 0.96 && cy > h * 0.02 && cy < h * 0.96;
        bool forward = uiMode == "theater" || inDrawer || inCardArea || inCapsule;
        if (msg == Native.WM_LBUTTONDOWN)
        {
            if (!forward) return false;
            leftForwarded = true;
            Native.PostMessage(hwnd, Native.WM_LBUTTONDOWN, (IntPtr)Native.MK_LBUTTON, Native.MakeLParam(cx, cy));
            return true;
        }
        else
        {
            Native.PostMessage(hwnd, Native.WM_LBUTTONUP, IntPtr.Zero, Native.MakeLParam(cx, cy));
            leftForwarded = false;
            return true;
        }
    }

    // 右键落在已展开的快捷抽屉区域内时，拦截系统空白桌面菜单并触发 Windows 原生 Shell 右键菜单
    bool HandleRightClick(int msg)
    {
        if (shellMenuBusy) return HandleActiveShellMenuMouse(msg);
        if (!IsNientumCurrent()) return false;
        if (msg == Native.WM_RBUTTONUP && !rightForwarded) return false;

        if (msg == Native.WM_RBUTTONDOWN)
        {
            string underCls, rootCls;
            if (!IsDesktopUnderCursor(out underCls, out rootCls)) return false;
        }

        Native.POINT pt;
        if (!Native.GetCursorPos(out pt))
        {
            if (msg == Native.WM_RBUTTONUP) rightForwarded = false;
            return false;
        }
        IntPtr hwnd = FindWallpaperWindow();
        if (hwnd == IntPtr.Zero)
        {
            if (msg == Native.WM_RBUTTONUP) rightForwarded = false;
            return false;
        }
        int cx, cy;
        bool inDrawer = IsCursorInDrawer(pt, hwnd, msg == Native.WM_RBUTTONDOWN, out cx, out cy);
        if (msg == Native.WM_RBUTTONDOWN)
        {
            if (!inDrawer) return false;
            rightForwarded = true;
            Native.PostMessage(hwnd, Native.WM_RBUTTONDOWN, (IntPtr)Native.MK_RBUTTON, Native.MakeLParam(cx, cy));
            return true;
        }
        else
        {
            Native.PostMessage(hwnd, Native.WM_RBUTTONUP, IntPtr.Zero, Native.MakeLParam(cx, cy));
            rightForwarded = false;
            string curHover = hoverItemPath;
            if (!string.IsNullOrEmpty(curHover) && (DateTime.UtcNow - hoverItemUtc).TotalSeconds < 20)
            {
                TriggerShellMenuFromHook(curHover);
            }
            return true;
        }
    }

    IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                if (msg == Native.WM_LBUTTONDOWN || msg == Native.WM_LBUTTONUP)
                {
                    if (HandleLeftClick(msg)) return (IntPtr)1;
                }
                else if (msg == Native.WM_RBUTTONDOWN || msg == Native.WM_RBUTTONUP)
                {
                    if (HandleRightClick(msg)) return (IntPtr)1;
                }
                else if (msg == Native.WM_MOUSEMOVE)
                {
                    ForwardDragMove();
                }
                else if (msg == Native.WM_MOUSEWHEEL)
                {
                    var info = Marshal.PtrToStructure<Native.MSLLHOOKSTRUCT>(lParam);
                    int delta = (short)((info.mouseData >> 16) & 0xFFFF);
                    if (delta != 0)
                    {
                        bool nientum = IsNientumCurrent();
                        string underCls, rootCls;
                        bool desktop = IsDesktopUnderCursor(out underCls, out rootCls);
                        if (nientum && desktop)
                        {
                            IntPtr hwnd = FindWallpaperWindow();
                            if (hwnd != IntPtr.Zero)
                            {
                                SendWheelSignal(hwnd, delta);
                                return (IntPtr)1;
                            }
                            Log("no wallpaper window found");
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log("hook error: " + ex.Message);
        }
        return Native.CallNextHookEx(hookHandle, nCode, wParam, lParam);
    }

    void SendWheelSignal(IntPtr hwnd, int delta)
    {
        int n = Math.Max(1, Math.Min(6, (int)Math.Round(Math.Abs(delta) / 40.0)));
        int dir = delta > 0 ? -1 : 1;

        double scale = 1.0;
        try
        {
            uint dpi = Native.GetDpiForWindow(hwnd);
            if (dpi > 0) scale = dpi / 96.0;
        }
        catch { scale = 1.5; }
        if (scale < 0.5 || scale > 4.0) scale = 1.5;

        int pageX = 30 + 30 * n;
        // 与焦点信号相同：y 不乘缩放，3 = 向上，13 = 向下；页面按 <= 3 判定方向。
        int pageY = dir < 0 ? 3 : 13;
        int winX = (int)Math.Round(pageX / scale);
        int winY = (int)Math.Round(pageY / scale);

        Native.PostMessage(hwnd, Native.WM_MOUSEMOVE, (IntPtr)Native.MK_RBUTTON, Native.MakeLParam(winX, winY));
        Native.PostMessage(hwnd, Native.WM_MOUSEMOVE, IntPtr.Zero, Native.MakeLParam(800, 500));
    }

    void Log(string msg)
    {
        try
        {
            lock (logLock)
            {
                var fi = new FileInfo(logPath);
                if (fi.Exists && fi.Length > 512 * 1024) File.Delete(logPath);
                File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + "\r\n", Encoding.UTF8);
            }
        }
        catch { }
    }

    [STAThread]
    static int Main(string[] args)
    {
        if (args != null)
        {
            foreach (var a in args)
            {
                if (a != null && a.Equals("--shell-menu", StringComparison.OrdinalIgnoreCase))
                    return ShellMenuRunner.Run(args);
            }
        }

        bool prepareRuntime = false;
        bool proxySelftest = false;
        int testPort = 17997;
        if (args != null)
        {
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i] == null ? "" : args[i];
                if (a.Equals("--prepare-runtime", StringComparison.OrdinalIgnoreCase)) prepareRuntime = true;
                else if (a.Equals("--proxy-selftest", StringComparison.OrdinalIgnoreCase)) proxySelftest = true;
                else if (a.Equals("--port", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    int p;
                    if (int.TryParse(args[i + 1], out p) && p > 0 && p < 65536) testPort = p;
                }
                else if (a.StartsWith("--port=", StringComparison.OrdinalIgnoreCase))
                {
                    int p;
                    if (int.TryParse(a.Substring(7), out p) && p > 0 && p < 65536) testPort = p;
                }
            }
        }

        string appDir = Path.GetDirectoryName(Application.ExecutablePath);
        if (prepareRuntime || proxySelftest)
        {
            Action<string> modeLog = delegate(string m)
            {
                try
                {
                    File.AppendAllText(Path.Combine(appDir, "_prepare.log"), DateTime.Now.ToString("HH:mm:ss.fff") + " " + m + "\r\n", Encoding.UTF8);
                }
                catch { }
            };
            if (proxySelftest)
                return ProxySelfTest.Run(appDir, testPort, modeLog);
            try
            {
                ProxyRuntimePaths rt = PayloadRuntime.Ensure(appDir, modeLog);
                File.WriteAllText(Path.Combine(appDir, "_prepare_result.txt"), rt == null ? "FAIL" : ("OK " + rt.Root), Encoding.UTF8);
                return rt == null ? 1 : 0;
            }
            catch (Exception ex)
            {
                modeLog("prepare error: " + ex.Message);
                try { File.WriteAllText(Path.Combine(appDir, "_prepare_result.txt"), "FAIL " + ex.Message, Encoding.UTF8); } catch { }
                return 1;
            }
        }

        bool daemon = false;
        bool noNetease = false;
        bool replace = false;
        bool fromWe = false;
        if (args != null)
        {
            foreach (var a in args)
            {
                if (a.Equals("--daemon", StringComparison.OrdinalIgnoreCase) || a.Equals("-daemon", StringComparison.OrdinalIgnoreCase))
                    daemon = true;
                else if (a.Equals("--no-netease", StringComparison.OrdinalIgnoreCase))
                    noNetease = true;
                else if (a.Equals("--replace", StringComparison.OrdinalIgnoreCase))
                    replace = true;
                else if (a.Equals("--from-we", StringComparison.OrdinalIgnoreCase))
                    fromWe = true;
            }
        }

        if (replace || daemon || fromWe)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + CTRL_PORT + "/bridge/shutdown");
                req.Method = "POST";
                req.Timeout = 400;
                req.ContentLength = 0;
                using (var resp = req.GetResponse()) { }
                Thread.Sleep(250);
            }
            catch { }

            if (replace || daemon)
            {
                try
                {
                    int selfPid = Process.GetCurrentProcess().Id;
                    foreach (var p in Process.GetProcessesByName(Process.GetCurrentProcess().ProcessName))
                    {
                        if (p.Id == selfPid) continue;
                        try { p.Kill(); p.WaitForExit(1500); } catch { }
                    }
                }
                catch { }
                try
                {
                    foreach (var p in Process.GetProcessesByName("NientumWheelBridge"))
                    {
                        try { p.Kill(); p.WaitForExit(1800); } catch { }
                    }
                }
                catch { }
            }
        }

        Mutex mutex = null;
        bool created = false;
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < 2800)
        {
            try
            {
                mutex = new Mutex(true, "NientumBridge_SingleInstance", out created);
                if (created) break;
                mutex.Close();
                mutex = null;
            }
            catch { }
            if (!(replace || daemon || fromWe)) return 0;
            Thread.Sleep(120);
        }
        if (!created) return 0;

        using (mutex)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            globalBridge = new Bridge(daemon, fromWe, noNetease);
            if (noNetease) globalBridge.SetNoNetease();
            else globalBridge.StartNeteaseNow();
            Application.Run(new HiddenContext());
            GC.KeepAlive(mutex);
        }
        return 0;
    }

    static Bridge globalBridge;
}