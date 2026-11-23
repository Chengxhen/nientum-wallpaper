const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { execFile, spawn } = require('child_process');
const api = require('@neteasecloudmusicapienhanced/api');

const PORT = Number(process.env.NIENTUM_PROXY_PORT) || 17988;
const HOST = '127.0.0.1';
const BRIDGE_VER = 4;
const BRIDGE_CTRL_PORT = 17989;
// 代码目录（解压出来的 runtime\proxy-*）与用户数据目录分离：
// exe 升级只替换代码，cookie / 导入壁纸 / 图标缓存等留在 Nientum_Bridge 根目录。
const CODE_DIR = __dirname;
const DATA_DIR = process.env.NIENTUM_DATA_DIR ? path.resolve(process.env.NIENTUM_DATA_DIR) : __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const COOKIE_FILE = path.join(DATA_DIR, 'cookie.json');
const DOCK_SLOTS_FILE = path.join(DATA_DIR, 'dock-slots.json');
const CUSTOM_CARDS_DIR = path.join(DATA_DIR, 'custom-cards');
const IMPORTED_WP_FILE = path.join(DATA_DIR, 'imported-wallpapers.json');
const IMPORTED_THUMB_DIR = path.join(DATA_DIR, 'imported-thumbs');
const IMPORTED_MEDIA_DIR = path.join(DATA_DIR, 'imported-media');
const UI_STATE_FILE = path.join(DATA_DIR, 'ui-state.txt');
const AUDIO_CACHE_DIR = path.join(DATA_DIR, 'audio-cache');
const AUDIO_CACHE_MAX_BYTES = Math.max(128, Number(process.env.NIENTUM_AUDIO_CACHE_MB) || 1024) * 1024 * 1024;
// 网易云 CDN 复用长连接，避免每首歌/每次拖动进度都重新 TLS 握手；
// 默认只走 IPv4（国内网络 IPv6 回程不稳时最容易表现为播放中途卡住）。
const IPV4_ONLY = process.env.NIENTUM_IPV4 !== '0';
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8, keepAliveMsecs: 15000, timeout: 60000 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8, keepAliveMsecs: 15000, timeout: 60000 });
let nativeInputMemory = { seq: 0, field: '', text: '', commit: false, ts: 0 };
let hookContextMenuState = { open: false, invokedSeq: 0, ts: 0 };

function callWheelBridge(endpoint, formObj, timeoutMs = 600) {
  return new Promise((resolve) => {
    try {
      const body = new URLSearchParams(formObj || {}).toString();
      const req = http.request({
        hostname: HOST,
        port: BRIDGE_CTRL_PORT,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: timeoutMs
      }, (resp) => {
        let out = '';
        resp.on('data', (c) => { out += c; });
        resp.on('end', () => {
          try { resolve(out ? JSON.parse(out) : { ok: true }); }
          catch (_) { resolve({ ok: true }); }
        });
      });
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
      req.on('error', () => resolve(null));
      req.end(body);
    } catch (_) {
      resolve(null);
    }
  });
}
let ffmpegExeCache = undefined;
let importProgress = { active: false, percent: 0, message: '', startedAt: 0 };
const songUrlCache = new Map();
const lyricCache = new Map();
let importedWallpapers = [];
let importedById = new Map();
let weScanCache = new Map();
let weDirCache = '';
let weRecording = false;
const WE_CAPTURE_WINDOW = 'NientumCapture';

const DEFAULT_DOCK_SLOTS = [
  { id: 'slot_desktop', title: '桌面', path: '@desktop', card: 'cover_act0' },
  { id: 'slot_downloads', title: '下载', path: '@downloads', card: 'cover_act1' },
  { id: 'slot_documents', title: '文档', path: '@documents', card: 'cover_act2' },
  { id: 'slot_pictures', title: '图片', path: '@pictures', card: 'cover_act3' }
];

function resolveSpecialPath(raw) {
  const s = String(raw || '').trim();
  const home = os.homedir();
  if (s === '@desktop') return path.join(home, 'Desktop');
  if (s === '@downloads') return path.join(home, 'Downloads');
  if (s === '@documents') return path.join(home, 'Documents');
  if (s === '@pictures') return path.join(home, 'Pictures');
  return path.resolve(s);
}

function loadDockSlots() {
  try {
    if (fs.existsSync(DOCK_SLOTS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(DOCK_SLOTS_FILE, 'utf8'));
      if (Array.isArray(arr)) return arr;
    }
  } catch (_) {}
  return DEFAULT_DOCK_SLOTS.slice();
}

function saveDockSlots(slots) {
  fs.writeFileSync(DOCK_SLOTS_FILE, JSON.stringify(slots, null, 2), 'utf8');
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 512 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// ===== 系统状态（桌面左侧信息栏）：CPU 占用按两次采样差值计算 =====
function readCpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}
let lastCpuTimes = readCpuTimes();

// ===== Windows 资源管理器同款图标（SHGetImageList 48px），一次 PowerShell 批量提取并缓存为 PNG =====
const ICON_CACHE_DIR = path.join(DATA_DIR, 'icon-cache');
const ICON_PS_SCRIPT = `
param()
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class IconX {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct SHFILEINFO {
    public IntPtr hIcon; public int iIcon; public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string szTypeName;
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SHGetFileInfo(string p, uint attr, ref SHFILEINFO sfi, uint cb, uint flags);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SHGetFileInfo(IntPtr pidl, uint attr, ref SHFILEINFO sfi, uint cb, uint flags);
  [DllImport("shell32.dll")]
  public static extern int SHGetSpecialFolderLocation(IntPtr hwnd, int csidl, out IntPtr ppidl);
  [DllImport("shell32.dll", EntryPoint="#727")]
  public static extern int SHGetImageList(int iImageList, ref Guid riid, out IImageList ppv);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
  [ComImport, Guid("46EB5926-582E-4017-9FDF-E8998DAA0950"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IImageList {
    [PreserveSig] int Add(IntPtr hbmImage, IntPtr hbmMask, ref int pi);
    [PreserveSig] int ReplaceIcon(int i, IntPtr hicon, ref int pi);
    [PreserveSig] int SetOverlayImage(int iImage, int iOverlay);
    [PreserveSig] int Replace(int i, IntPtr hbmImage, IntPtr hbmMask);
    [PreserveSig] int AddMasked(IntPtr hbmImage, int crMask, ref int pi);
    [PreserveSig] int Draw(IntPtr pimldp);
    [PreserveSig] int Remove(int i);
    [PreserveSig] int GetIcon(int i, int flags, ref IntPtr picon);
  }
  static bool SaveByIndex(int iIcon, IntPtr fallbackHic, string outPng) {
    IntPtr hic = IntPtr.Zero;
    try {
      Guid iid = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");
      IImageList il;
      if (SHGetImageList(2, ref iid, out il) == 0 && il != null) il.GetIcon(iIcon, 1, ref hic);
    } catch (Exception) { hic = IntPtr.Zero; }
    if (hic == IntPtr.Zero) hic = fallbackHic;
    if (hic == IntPtr.Zero) return false;
    try {
      using (Icon ic = Icon.FromHandle(hic))
      using (Bitmap bmp = ic.ToBitmap()) { bmp.Save(outPng, ImageFormat.Png); }
    } finally {
      if (hic != fallbackHic) DestroyIcon(hic);
      if (fallbackHic != IntPtr.Zero) DestroyIcon(fallbackHic);
    }
    return true;
  }
  public static bool SaveSpecial(int csidl, string outPng) {
    IntPtr pidl = IntPtr.Zero;
    if (SHGetSpecialFolderLocation(IntPtr.Zero, csidl, out pidl) != 0 || pidl == IntPtr.Zero) return false;
    try {
      SHFILEINFO sfi = new SHFILEINFO();
      IntPtr r = SHGetFileInfo(pidl, 0, ref sfi, (uint)Marshal.SizeOf(sfi), 0x0008 | 0x4000);
      if (r == IntPtr.Zero) return false;
      SHFILEINFO s2 = new SHFILEINFO();
      SHGetFileInfo(pidl, 0, ref s2, (uint)Marshal.SizeOf(s2), 0x0008 | 0x0100);
      return SaveByIndex(sfi.iIcon, s2.hIcon, outPng);
    } finally { Marshal.FreeCoTaskMem(pidl); }
  }
  public static bool Save(string path, bool isDir, bool useAttr, string outPng) {
    SHFILEINFO sfi = new SHFILEINFO();
    uint flags = 0x4000;
    if (useAttr) flags |= 0x10;
    uint attr = isDir ? 0x10u : 0x80u;
    IntPtr r = SHGetFileInfo(path, attr, ref sfi, (uint)Marshal.SizeOf(sfi), flags);
    if (r == IntPtr.Zero) return false;
    SHFILEINFO s2 = new SHFILEINFO();
    uint f2 = 0x100 | 0x0;
    if (useAttr) f2 |= 0x10;
    SHGetFileInfo(path, attr, ref s2, (uint)Marshal.SizeOf(s2), f2);
    return SaveByIndex(sfi.iIcon, s2.hIcon, outPng);
  }
}
"@
foreach ($line in [System.IO.File]::ReadAllLines('__LIST__', [System.Text.Encoding]::UTF8)) {
  $parts = $line.Split('|', 4)
  if ($parts.Length -lt 4) { continue }
  $out = Join-Path '__OUT__' ($parts[0] + '.png')
  if (Test-Path $out) { continue }
  if ($parts[1] -eq '2') {
    $csidl = 0
    [void][int]::TryParse($parts[3], [ref]$csidl)
    [void][IconX]::SaveSpecial($csidl, $out)
  } else {
    [void][IconX]::Save($parts[3], ($parts[1] -eq '1'), ($parts[2] -eq '1'), $out)
  }
}
`;

function iconKeyFor(item) {
  const full = String(item.path || '');
  if (full === '@thispc') return { key: 'sys_thispc', mode: 2, useAttr: false, p: '17' };
  if (full === '@recyclebin') return { key: 'sys_recyclebin', mode: 2, useAttr: false, p: '10' };
  const ext = path.extname(full).toLowerCase();
  const isDir = !!item.isDir;
  if (isDir) return { key: 'dir_generic', mode: 1, useAttr: true, p: full };
  const perFile = ['.exe', '.lnk', '.ico', '.url', '.msi', '.scr', '.appref-ms'].includes(ext);
  if (perFile) {
    const h = require('crypto').createHash('sha1').update(full.toLowerCase()).digest('hex').slice(0, 20);
    return { key: 'f_' + h, mode: 0, useAttr: false, p: full };
  }
  const safeExt = (ext.replace(/[^a-z0-9]/g, '') || 'none').slice(0, 16);
  return { key: 'ext_' + safeExt, mode: 0, useAttr: true, p: full };
}

let iconJobChain = Promise.resolve();
function resolveShellIcons(items) {
  const job = iconJobChain.then(() => new Promise((resolve) => {
    fs.mkdirSync(ICON_CACHE_DIR, { recursive: true });
    const map = {};
    const missing = new Map();
    for (const it of items) {
      if (!it || !it.path) continue;
      const k = iconKeyFor(it);
      map[it.path] = k.key;
      const png = path.join(ICON_CACHE_DIR, k.key + '.png');
      if (!fs.existsSync(png) && !missing.has(k.key)) missing.set(k.key, k);
    }
    const finish = () => {
      const out = {};
      for (const p0 of Object.keys(map)) {
        if (fs.existsSync(path.join(ICON_CACHE_DIR, map[p0] + '.png'))) {
          out[p0] = `/api/fs/icon-file?k=${map[p0]}`;
        }
      }
      resolve(out);
    };
    if (!missing.size) return finish();
    const listFile = path.join(ICON_CACHE_DIR, `_list_${Date.now()}.txt`);
    const lines = [];
    for (const k of missing.values()) {
      lines.push(`${k.key}|${k.mode}|${k.useAttr ? 1 : 0}|${k.p.replace(/[\r\n|]/g, '')}`);
    }
    try { fs.writeFileSync(listFile, lines.join('\n'), 'utf8'); } catch (_) { return finish(); }
    const script = ICON_PS_SCRIPT
      .replace('__LIST__', listFile.replace(/'/g, "''"))
      .replace('__OUT__', ICON_CACHE_DIR.replace(/'/g, "''"));
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 45000, windowsHide: true }, () => {
        try { fs.unlinkSync(listFile); } catch (_) {}
        finish();
      });
  }));
  iconJobChain = job.catch(() => {});
  return job;
}

// 音质档位：与页面上的五档对应，br 为网易云 song_url 使用的码率参数
const QUALITY_LEVELS = {
  standard: { br: 128000, label: '标准', type: 'mp3' },
  higher:   { br: 192000, label: '较高', type: 'mp3' },
  exhigh:   { br: 320000, label: '极高', type: 'mp3' },
  lossless: { br: 999000, label: '无损', type: 'flac' },
  hires:    { br: 1999000, label: 'Hi-Res', type: 'flac' },
  jyeffect: { br: 0, label: '高清臻音', type: 'flac' },
  jymaster: { br: 0, label: '超清母带', type: 'flac' },
  sky:      { br: 0, label: '沉浸环绕声', type: 'flac' }
};
const QUALITY_FALLBACK = ['hires', 'lossless', 'exhigh', 'higher', 'standard'];
const BASE_ORDER = ['hires', 'lossless', 'exhigh', 'higher', 'standard'];

function normalizeLevel(level) {
  level = String(level || '').toLowerCase();
  return QUALITY_LEVELS[level] ? level : 'exhigh';
}

function loadAuth() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { cookie: '', profile: null };
}

function saveAuth(auth) {
  try {
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(auth, null, 2), 'utf8');
  } catch (_) {}
}

let auth = loadAuth();
let focusState = { blur: false, ts: 0 };
let uiMode = 'capsule';
try { if (fs.existsSync(UI_STATE_FILE)) uiMode = fs.readFileSync(UI_STATE_FILE, 'utf8').trim() || 'capsule'; } catch (_) {}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range'
  });
  res.end(JSON.stringify(data));
}

// ===== 导入其他壁纸（本地图片/视频 + Wallpaper Engine 视频壁纸） =====
const WP_MEDIA_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/mp4', '.ogg': 'video/ogg'
};

function mimeForFile(file) {
  return WP_MEDIA_MIME[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream';
}

// 网页壁纸的 Chromium/CEF 不支持 HEVC/H.265；导入时直接识别并给出中文原因，
// 避免出现“导入成功但整块黑屏/没有缩略图”的含糊结果。
function detectVideoCodec(file) {
  try {
    if (!file || !fs.existsSync(file)) return { codec: 'missing', playable: false };
    const ext = path.extname(file).toLowerCase();
    if (ext === '.webm') return { codec: 'webm', playable: true };
    if (ext === '.mov') return { codec: 'mov', playable: false };
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const headLen = Math.min(4 * 1024 * 1024, stat.size);
    const tailLen = Math.min(8 * 1024 * 1024, Math.max(0, stat.size - headLen));
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    let tail = Buffer.alloc(0);
    if (tailLen > 0) {
      tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, stat.size - tailLen);
    }
    fs.closeSync(fd);
    const scan = Buffer.concat([head, tail]);
    const has = (s) => scan.indexOf(Buffer.from(s)) >= 0;
    if (has('hvc1') || has('hev1') || has('hvc2') || has('dvh1') || has('dvhe')) {
      return { codec: 'hevc', playable: false };
    }
    if (has('avc1') || has('avc3')) return { codec: 'h264', playable: true };
    if (has('av01')) return { codec: 'av1', playable: true };
    if (has('vp09')) return { codec: 'vp9', playable: true };
    if (has('vp08')) return { codec: 'vp8', playable: true };
    return { codec: 'unknown', playable: true };
  } catch (_) {
    return { codec: 'unknown', playable: true };
  }
}

function codecErrorMessage(codec) {
  if (codec === 'hevc') return '检测到 HEVC/H.265 编码：Wallpaper Engine 的网页内核无法播放。请转成 H.264 MP4 或 WebM 后重新导入。';
  if (codec === 'mov') return 'MOV 容器无法在网页内核中播放，请转成 H.264 MP4 或 WebM 后重新导入。';
  return '';
}

function getFfmpegExe() {
  if (ffmpegExeCache !== undefined) return ffmpegExeCache;
  const cands = [
    path.join(DATA_DIR, 'ffmpeg.exe'),
    path.join(DATA_DIR, 'tools', 'ffmpeg.exe'),
    path.join(CODE_DIR, 'ffmpeg.exe'),
    path.join(CODE_DIR, 'tools', 'ffmpeg.exe'),
    path.join(CODE_DIR, '..', 'tools', 'ffmpeg.exe')
  ];
  if (process.env.FFMPEG_PATH) cands.unshift(process.env.FFMPEG_PATH);
  try {
    for (const p of String(process.env.PATH || '').split(path.delimiter)) {
      if (p) cands.push(path.join(p, 'ffmpeg.exe'));
    }
  } catch (_) {}
  ffmpegExeCache = '';
  for (const p of cands) {
    try { if (p && fs.existsSync(p)) { ffmpegExeCache = p; break; } } catch (_) {}
  }
  return ffmpegExeCache;
}

function resolveImportFile(p) {
  if (!p) return '';
  try { return path.isAbsolute(p) ? p : path.join(DATA_DIR, p); } catch (_) { return p; }
}

function toImportRelative(absPath) {
  try { return path.relative(DATA_DIR, absPath); } catch (_) { return absPath; }
}

function isManagedImportFile(p) {
  if (!p) return false;
  try {
    const abs = path.resolve(resolveImportFile(p));
    const root = path.resolve(IMPORTED_MEDIA_DIR) + path.sep;
    return abs.toLowerCase().startsWith(root.toLowerCase());
  } catch (_) { return false; }
}

function setImportProgress(active, percent, message) {
  importProgress = {
    active: !!active,
    percent: Math.max(0, Math.min(100, Math.round(Number(percent) || 0))),
    message: String(message || ''),
    startedAt: active ? (importProgress.startedAt || Date.now()) : 0
  };
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const exe = getFfmpegExe();
    if (!exe) return resolve(0);
    const proc = spawn(exe, ['-hide_banner', '-i', file], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-4000); });
    proc.on('error', () => resolve(0));
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
      resolve(m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : 0);
    });
  });
}

function runFfmpeg(args, timeoutMs, onProgress) {
  return new Promise((resolve, reject) => {
    const exe = getFfmpegExe();
    if (!exe) return reject(new Error('未找到 ffmpeg.exe，无法处理视频；请检查 Nientum_Bridge\\ffmpeg.exe'));
    const finalArgs = onProgress ? [...args.slice(0, -1), '-progress', 'pipe:1', '-nostats', args[args.length - 1]] : args;
    const proc = spawn(exe, finalArgs, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch (_) {}
      reject(new Error('ffmpeg 处理超时'));
    }, timeoutMs || 30 * 60 * 1000);
    proc.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-8000); });
    if (onProgress) {
      proc.stdout.on('data', d => {
        stdout = (stdout + d.toString()).slice(-4000);
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop();
        for (const line of lines) {
          const m = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (m) {
            const sec = (+m[1] * 3600 + +m[2] * 60 + +m[3]);
            try { onProgress(sec); } catch (_) {}
          }
        }
      });
    }
    proc.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error((stderr || '').trim() || ('ffmpeg 退出码 ' + code)));
    });
  });
}

function ensureImportedMediaDir() {
  fs.mkdirSync(IMPORTED_MEDIA_DIR, { recursive: true });
}

function copyImageToImports(src, id) {
  ensureImportedMediaDir();
  const ext = path.extname(src).toLowerCase() || '.png';
  const dest = path.join(IMPORTED_MEDIA_DIR, id + ext);
  fs.copyFileSync(src, dest);
  return toImportRelative(dest);
}

function copyPreviewToImports(src, id) {
  if (!src || !fs.existsSync(src)) return '';
  ensureImportedMediaDir();
  const ext = path.extname(src).toLowerCase() || '.jpg';
  const dest = path.join(IMPORTED_MEDIA_DIR, id + '_preview' + ext);
  try { fs.copyFileSync(src, dest); return toImportRelative(dest); } catch (_) { return ''; }
}

async function generateVideoThumbFromFile(videoPath, id) {
  try {
    const exe = getFfmpegExe();
    if (!exe) return '';
    fs.mkdirSync(IMPORTED_THUMB_DIR, { recursive: true });
    const thumbAbs = path.join(IMPORTED_THUMB_DIR, id + '.jpg');
    await runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', '0.5', '-i', videoPath,
      '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '3', thumbAbs
    ], 120000);
    if (fs.existsSync(thumbAbs) && fs.statSync(thumbAbs).size > 0) return id + '.jpg';
  } catch (_) {}
  return '';
}

function resolveWeLoopMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'none' || m === 'off' || m === 'false') return 'none';
  if (m === 'match' || m === 'smart') return 'match';
  return 'crossfade';
}

function captureRawRgbFrames(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const exe = getFfmpegExe();
    if (!exe) return reject(new Error('no ffmpeg'));
    const p = spawn(exe, args, { windowsHide: true });
    const chunks = [];
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { p.kill(); } catch (_) {}
        reject(new Error('frame probe timeout'));
      }
    }, timeoutMs || 30000);
    p.stdout.on('data', d => chunks.push(d));
    p.on('error', err => {
      if (!settled) { settled = true; clearTimeout(t); reject(err); }
    });
    p.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (code !== 0) return reject(new Error('ffmpeg exit ' + code));
      resolve(Buffer.concat(chunks));
    });
  });
}

async function findBestLoopEndTime(videoPath, minT, maxT) {
  try {
    const frameBytes = 128 * 72 * 3;
    const headBuf = await captureRawRgbFrames([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', videoPath, '-frames:v', '1',
      '-vf', 'scale=128:72', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    ], 15000);
    if (!headBuf || headBuf.length < frameBytes) return null;
    const candBuf = await captureRawRgbFrames([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', minT.toFixed(2), '-to', maxT.toFixed(2),
      '-i', videoPath,
      '-vf', 'fps=10,scale=128:72', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    ], 30000);
    const count = Math.floor((candBuf ? candBuf.length : 0) / frameBytes);
    if (count < 2) return null;
    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < count; i++) {
      const off = i * frameBytes;
      let diff = 0;
      for (let j = 0; j < frameBytes; j += 4) {
        diff += Math.abs(headBuf[j] - candBuf[off + j]);
      }
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    return bestIdx >= 0 ? Number((minT + bestIdx * 0.1).toFixed(2)) : null;
  } catch (_) {
    return null;
  }
}

async function materializeVideo(src, id, progressBase, progressSpan, opts) {
  const pBase = Number.isFinite(progressBase) ? progressBase : 0;
  const pSpan = Number.isFinite(progressSpan) ? progressSpan : 100;
  const report = (local, msg) => setImportProgress(true, pBase + (local * pSpan) / 100, msg);
  ensureImportedMediaDir();
  const info = detectVideoCodec(src);
  if (info.codec === 'missing') throw new Error('源视频文件不存在');
  if (!getFfmpegExe()) throw new Error('未找到 ffmpeg.exe，无法处理视频；请检查 Nientum_Bridge\\ffmpeg.exe');
  // 统一输出 CEF 原生兼容的 WebM (VP9)，避免 H.264 解码缺失与双份转码耗时
  const destAbs = path.join(IMPORTED_MEDIA_DIR, id + '.webm');
  const duration = await probeDuration(src);
  const loopMode = opts && opts.loopMode ? resolveWeLoopMode(opts.loopMode) : 'none';
  const targetDur = opts && Number.isFinite(opts.targetDuration) ? opts.targetDuration : duration;
  const srcExt = path.extname(src).toLowerCase();
  const canFastRemux = loopMode === 'none' && srcExt === '.webm' && ['webm', 'vp9', 'vp8'].includes(info.codec);
  const onP = (sec, label) => {
    const den = targetDur > 0 ? targetDur : duration;
    const local = den > 0 ? Math.min(88, (sec / den) * 88) : 0;
    const pctText = den > 0 ? ' ' + Math.round(local) + '%' : '';
    report(local, label + pctText);
  };
  let vp9Args = null;
  if (loopMode === 'crossfade' && duration > 3) {
    const fadeDur = Number((opts && opts.fadeDur ? opts.fadeDur : Math.min(1.5, Math.max(0.6, targetDur * 0.15))).toFixed(2));
    if (duration > fadeDur + 1.5) {
      const trimEnd = Number(Math.min(duration, targetDur + fadeDur).toFixed(2));
      const mainLen = Math.max(1.0, trimEnd - fadeDur);
      const offset = Number(Math.max(0.4, mainLen - fadeDur).toFixed(2));
      const fc = `[0:v]split=2[v1][v2];`
        + `[v1]trim=start=${fadeDur}:end=${trimEnd},setpts=PTS-STARTPTS[main];`
        + `[v2]trim=start=0:end=${fadeDur},setpts=PTS-STARTPTS[head];`
        + `[main][head]xfade=transition=fade:duration=${fadeDur}:offset=${offset},`
        + `scale='trunc(min(3840\\,iw)/2)*2':-2:flags=lanczos,format=yuv420p[out]`;
      vp9Args = [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', src,
        '-filter_complex', fc, '-map', '[out]', '-an',
        '-c:v', 'libvpx-vp9',
        '-deadline', 'good', '-cpu-used', '4',
        '-row-mt', '1', '-tile-columns', '2', '-threads', '0',
        '-crf', '24', '-b:v', '0', '-g', '120',
        destAbs
      ];
    }
  } else if (loopMode === 'match' && duration > 4) {
    report(2, '正在智能分析首尾循环点...');
    const minT = Math.max(3, Math.min(duration - 1.5, targetDur * 0.72));
    const maxT = Math.max(minT + 0.5, duration - 0.1);
    const bestT = await findBestLoopEndTime(src, minT, maxT);
    const cutT = bestT && bestT > 3 ? bestT : Math.min(duration, targetDur);
    vp9Args = [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', src,
      '-t', cutT.toFixed(2),
      '-map', '0:v:0', '-an',
      '-vf', "scale='trunc(min(3840\\,iw)/2)*2':-2:flags=lanczos,format=yuv420p",
      '-c:v', 'libvpx-vp9',
      '-deadline', 'good', '-cpu-used', '4',
      '-row-mt', '1', '-tile-columns', '2', '-threads', '0',
      '-crf', '24', '-b:v', '0', '-g', '120',
      destAbs
    ];
  }
  if (!vp9Args) {
    vp9Args = [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', src,
      '-map', '0:v:0', '-an',
      '-vf', "scale='trunc(min(3840\\,iw)/2)*2':-2:flags=lanczos,format=yuv420p",
      '-c:v', 'libvpx-vp9',
      '-deadline', 'good', '-cpu-used', '4',
      '-row-mt', '1', '-tile-columns', '2', '-threads', '0',
      '-crf', '24', '-b:v', '0', '-g', '120',
      destAbs
    ];
  }
  let remuxed = false;
  if (canFastRemux) {
    try {
      report(4, '正在封装 WebM 视频（免重编码）');
      await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-map', '0:v:0', '-an', '-c:v', 'copy', destAbs], 5 * 60 * 1000, sec => onP(sec, '正在封装 WebM 视频'));
      remuxed = fs.existsSync(destAbs) && fs.statSync(destAbs).size > 0;
    } catch (_) {
      try { if (fs.existsSync(destAbs)) fs.unlinkSync(destAbs); } catch (_) {}
      remuxed = false;
    }
  }
  if (!remuxed) {
    report(2, '正在单通转码为 WebM (VP9)');
    await runFfmpeg(vp9Args, 60 * 60 * 1000, sec => onP(sec, '正在转码为 WebM (VP9)'));
  }
  if (!fs.existsSync(destAbs) || fs.statSync(destAbs).size <= 0) throw new Error('视频处理失败：输出文件为空');
  report(92, '正在生成缩略图');
  const thumb = await generateVideoThumbFromFile(destAbs, id);
  report(97, '正在写入壁纸清单');
  return {
    relativePath: toImportRelative(destAbs),
    fallbackPath: '',
    codec: 'vp9',
    thumb
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getWeExe() {
  if (!weDirCache) {
    const scan = scanWeWallpapers();
    if (!scan.ok) throw new Error(scan.error || '未找到 Wallpaper Engine');
  }
  for (const name of ['wallpaper64.exe', 'wallpaper32.exe']) {
    const p = path.join(weDirCache, name);
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  throw new Error('未找到 wallpaper64.exe / wallpaper32.exe');
}

function isWeRunning() {
  const check = (exeName) => new Promise(resolve => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH'], { windowsHide: true, encoding: 'buffer' }, (err, stdout) => {
      try {
        const s = Buffer.isBuffer(stdout) ? stdout.toString('latin1') : String(stdout || '');
        resolve(!err && s.toLowerCase().includes(exeName.toLowerCase()));
      } catch (_) { resolve(false); }
    });
  });
  return check('wallpaper64.exe').then(found => found || check('wallpaper32.exe'));
}

function resolveWeRecordResolution(resKey) {
  const k = String(resKey || '').trim().toLowerCase();
  if (k === '1080p' || k === 'fhd') return { key: '1080p', label: '1080p', width: 1920, height: 1080 };
  if (k === '2k' || k === '1440p' || k === 'qhd') return { key: '2k', label: '2K', width: 2560, height: 1440 };
  return { key: '4k', label: '4K', width: 3840, height: 2160 };
}

function runWeWindowScript(action, opts) {
  return new Promise(resolve => {
    const script = path.join(CODE_DIR, 'we_record_window.ps1');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action];
    if (opts && opts.width && opts.height) {
      args.push('-Width', String(opts.width), '-Height', String(opts.height));
      args.push('-X', String(Number.isFinite(opts.x) ? opts.x : 0), '-Y', String(Number.isFinite(opts.y) ? opts.y : 0));
    }
    execFile('powershell.exe', args,
      { windowsHide: true, timeout: 20000, encoding: 'utf8' },
      (err, stdout) => resolve({ err, out: String(stdout || '') }));
  });
}

function parseCaptureRect(out) {
  const o = String(out || '').match(/CLIENT_ORIGIN=(-?\d+),(-?\d+)/);
  const s = String(out || '').match(/CLIENT_SIZE=(\d+)x(\d+)/);
  if (!o || !s) return null;
  const w = parseInt(s[1], 10), h = parseInt(s[2], 10);
  if (!(w > 200 && h > 120)) return null;
  return { x: parseInt(o[1], 10), y: parseInt(o[2], 10), w, h };
}

async function openWeCaptureWindow(info, targetRes) {
  const exe = getWeExe();
  if (!fs.existsSync(info.projectFile)) throw new Error('Wallpaper Engine 项目文件不存在');
  if (!(await isWeRunning())) {
    try {
      const p = spawn(exe, [], { windowsHide: true, detached: true, stdio: 'ignore' });
      p.unref();
    } catch (_) {}
    await delay(4500);
  }
  const tw = targetRes ? targetRes.width : 3840;
  const th = targetRes ? targetRes.height : 2160;
  const tx = tw >= 2560 ? '0' : '20';
  const ty = th >= 1440 ? '0' : '20';
  await new Promise((resolve, reject) => {
    const p = spawn(exe, [
      '-control', 'openWallpaper', '-file', info.projectFile,
      '-playInWindow', WE_CAPTURE_WINDOW,
      '-width', String(tw), '-height', String(th), '-x', tx, '-y', ty,
      '-activate', '-borderless'
    ], { windowsHide: true, stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error('Wallpaper Engine 退出码 ' + code)));
  });
}

async function waitForWeCaptureWindow(timeoutMs, targetRes) {
  const deadline = Date.now() + (timeoutMs || 20000);
  const opts = targetRes ? {
    width: targetRes.width,
    height: targetRes.height,
    x: targetRes.width >= 2560 ? 0 : 20,
    y: targetRes.height >= 1440 ? 0 : 20
  } : null;
  while (Date.now() < deadline) {
    const r = await runWeWindowScript('set', opts);
    const rect = parseCaptureRect(r.out);
    if (rect) return rect;
    await delay(500);
  }
  throw new Error('Wallpaper Engine 录制窗口没有出现');
}

async function closeWeCaptureWindow() {
  try {
    const exe = getWeExe();
    spawn(exe, ['-control', 'closeWallpaper', '-location', WE_CAPTURE_WINDOW], { windowsHide: true, stdio: 'ignore' }).unref();
  } catch (_) {}
  await delay(700);
  try {
    const r = await runWeWindowScript('close');
    if (/CLOSED/.test(r.out)) await delay(900);
  } catch (_) {}
}

async function recordWeScene(info, seconds, resolution, loopMode) {
  if (weRecording) throw new Error('正在录制另一张壁纸，请稍候');
  const duration = Math.max(5, Math.min(300, Math.round(Number(seconds) || 15)));
  const targetRes = resolveWeRecordResolution(resolution);
  const loop = resolveWeLoopMode(loopMode);
  const fadeDur = loop === 'crossfade' ? Number(Math.min(1.5, Math.max(0.6, duration * 0.15)).toFixed(2)) : 0;
  const extraMatch = loop === 'match' ? Math.min(6, Math.max(2, Math.round(duration * 0.25))) : 0;
  const recDuration = Number((duration + fadeDur + extraMatch).toFixed(2));
  const id = importedIdFor('we-scene:' + String(info.projectFile || '').toLowerCase());
  const old = importedById.get(id);
  if (old) {
    const sameParams = old.recordDuration === duration && old.recordResolution === targetRes.key && (old.recordLoopMode || 'none') === loop;
    if (sameParams && fs.existsSync(resolveImportFile(old.path))) {
      return { item: publicImportedItem(old), reused: true };
    }
    try {
      const oldAbs = resolveImportFile(old.path);
      if (oldAbs && isManagedImportFile(old.path) && fs.existsSync(oldAbs)) fs.unlinkSync(oldAbs);
    } catch (_) {}
    importedWallpapers = importedWallpapers.filter(e => e.id !== id);
    importedById.delete(id);
    saveImportedWallpapers();
  }
  ensureImportedMediaDir();
  const tempAbs = path.join(IMPORTED_MEDIA_DIR, '_rec_' + id + '.mp4');
  try { if (fs.existsSync(tempAbs)) fs.unlinkSync(tempAbs); } catch (_) {}
  weRecording = true;
  let rect = null;
  try {
    setImportProgress(true, 2, '正在启动 Wallpaper Engine...');
    await openWeCaptureWindow(info, targetRes);
    setImportProgress(true, 6, '正在等待场景加载...');
    rect = await waitForWeCaptureWindow(22000, targetRes);
    await delay(3500);
    const totalLabel = Math.round(recDuration);
    setImportProgress(true, 10, `正在录制场景壁纸 0/${totalLabel} 秒 (${rect.w}×${rect.h})`);
    const recArgs = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'gdigrab', '-draw_mouse', '0', '-framerate', '30',
      '-offset_x', String(rect.x), '-offset_y', String(rect.y),
      '-video_size', `${rect.w}x${rect.h}`, '-i', 'desktop',
      '-t', String(recDuration),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '15',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tempAbs
    ];
    await runFfmpeg(recArgs, (recDuration + 120) * 1000, sec => {
      const done = Math.min(totalLabel, Math.ceil(sec));
      setImportProgress(true, Math.round(10 + Math.min(1, sec / recDuration) * 52), `正在录制场景壁纸 ${done}/${totalLabel} 秒 (${rect.w}×${rect.h})`);
    });
    await closeWeCaptureWindow();
    if (!fs.existsSync(tempAbs) || fs.statSync(tempAbs).size < 1024) throw new Error('录制结果为空，请确认 Wallpaper Engine 能正常播放这张壁纸');
    setImportProgress(true, 64, loop === 'crossfade' ? '正在做首尾柔化并封装 WebM...' : (loop === 'match' ? '正在分析首尾帧并封装 WebM...' : '正在封装 WebM 场景动画...'));
    const mat = await materializeVideo(tempAbs, id, 65, 35, {
      loopMode: loop,
      targetDuration: duration,
      fadeDur
    });
    const outDuration = await probeDuration(resolveImportFile(mat.relativePath));
    const preview = info.previewPath ? copyPreviewToImports(info.previewPath, id) : '';
    const item = addImportedWallpaper({
      id, title: info.title, kind: 'video', path: mat.relativePath, fallbackPath: '',
      previewPath: preview, thumb: mat.thumb, sourcePath: info.projectFile,
      source: 'we', weType: 'scene', codec: mat.codec, playable: true,
      width: rect.w, height: rect.h, duration: outDuration || duration,
      recordDuration: duration, recordResolution: targetRes.key, recordLoopMode: loop
    });
    return { item, reused: false };
  } finally {
    try { await closeWeCaptureWindow(); } catch (_) {}
    try { if (fs.existsSync(tempAbs)) fs.unlinkSync(tempAbs); } catch (_) {}
    weRecording = false;
  }
}

function loadImportedWallpapers() {
  importedById = new Map();
  try {
    if (fs.existsSync(IMPORTED_WP_FILE)) {
      const arr = JSON.parse(fs.readFileSync(IMPORTED_WP_FILE, 'utf8'));
      if (Array.isArray(arr)) {
        importedWallpapers = arr.filter(e => e && /^imp_[a-f0-9]{8,16}$/i.test(String(e.id || '')) && e.path);
      } else importedWallpapers = [];
    }
  } catch (_) { importedWallpapers = []; }
  let codecChanged = false;
  for (const e of importedWallpapers) {
    if (e.kind === 'video') {
      const info = detectVideoCodec(resolveImportFile(e.path));
      if (e.codec !== info.codec || e.playable !== info.playable) {
        e.codec = info.codec;
        e.playable = info.playable;
        codecChanged = true;
      }
    }
    importedById.set(e.id, e);
  }
  if (codecChanged) saveImportedWallpapers();
}

function saveImportedWallpapers() {
  try {
    fs.writeFileSync(IMPORTED_WP_FILE, JSON.stringify(importedWallpapers, null, 2), 'utf8');
  } catch (_) {}
}

function importedIdFor(filePath) {
  return 'imp_' + crypto.createHash('sha1').update(String(filePath).toLowerCase()).digest('hex').slice(0, 12);
}

function normalizeCrop(crop) {
  if (!crop || typeof crop !== 'object') return null;
  const x = Number(crop.x);
  const y = Number(crop.y);
  const zoom = Number(crop.zoom);
  const cx = Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5;
  const cy = Number.isFinite(y) ? Math.max(0, Math.min(1, y)) : 0.5;
  const cz = Number.isFinite(zoom) ? Math.max(1, Math.min(3.5, zoom)) : 1;
  return {
    x: Math.round(cx * 10000) / 10000,
    y: Math.round(cy * 10000) / 10000,
    zoom: Math.round(cz * 1000) / 1000
  };
}

function publicImportedItem(e) {
  return {
    id: e.id, title: e.title || '', kind: e.kind === 'video' ? 'video' : 'image',
    source: e.source || 'local', weType: e.weType || '',
    addedAt: e.addedAt || 0, duration: e.duration || 0, width: e.width || 0, height: e.height || 0,
    codec: e.codec || '', playable: e.kind === 'video' ? e.playable !== false : true,
    hasFallback: !!e.fallbackPath,
    hasThumb: !!(e.thumb || e.previewPath),
    crop: normalizeCrop(e.crop)
  };
}

function addImportedWallpaper(entry) {
  const id = entry.id || importedIdFor(entry.sourcePath || entry.path);
  const old = importedById.get(id);
  if (old) {
    if (entry.title && !old.title) old.title = entry.title;
    saveImportedWallpapers();
    return publicImportedItem(old);
  }
  const item = Object.assign({
    id, title: entry.title || path.basename(entry.sourcePath || entry.path) || '导入壁纸',
    kind: entry.kind === 'video' ? 'video' : 'image',
    source: entry.source || 'local', weType: entry.weType || '',
    path: entry.path, previewPath: entry.previewPath || '', fallbackPath: entry.fallbackPath || '', thumb: '',
    sourcePath: entry.sourcePath || '',
    addedAt: Date.now(), duration: 0, width: 0, height: 0
  }, entry);
  item.id = id;
  item.kind = item.kind === 'video' ? 'video' : 'image';
  if (item.kind === 'video') {
    const info = entry.codec ? { codec: entry.codec, playable: entry.playable !== false } : detectVideoCodec(resolveImportFile(item.path));
    item.codec = info.codec;
    item.playable = info.playable;
  }
  importedWallpapers.push(item);
  importedById.set(id, item);
  saveImportedWallpapers();
  return publicImportedItem(item);
}

function readBridgeWeConfigPath() {
  try {
    const ini = path.join(DATA_DIR, 'bridge.ini');
    if (!fs.existsSync(ini)) return '';
    for (const line of fs.readFileSync(ini, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*we_config\s*=\s*(.+?)\s*$/i);
      if (m && m[1]) return m[1].trim();
    }
  } catch (_) {}
  return '';
}

function findWeConfigPath() {
  const cands = [];
  const fromIni = readBridgeWeConfigPath();
  if (fromIni) cands.push(fromIni);
  const rels = [
    'SteamLibrary/steamapps/common/wallpaper_engine/config.json',
    'Steam/steamapps/common/wallpaper_engine/config.json',
    'Games/Steam/steamapps/common/wallpaper_engine/config.json',
    'Program Files (x86)/Steam/steamapps/common/wallpaper_engine/config.json',
    'Program Files/Steam/steamapps/common/wallpaper_engine/config.json'
  ];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    for (const rel of rels) {
      const p = path.join(letter + ':\\', rel.split('/').join(path.sep));
      if (fs.existsSync(p)) cands.push(p);
    }
  }
  const uniq = Array.from(new Set(cands)).filter(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
  const scored = uniq.map(p => {
    let mtime = 0;
    try { mtime = fs.statSync(p).mtimeMs; } catch (_) {}
    return { p, mtime };
  }).sort((a, b) => b.mtime - a.mtime);
  return scored.length ? scored[0].p : '';
}

function readJsonFileSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function collectSteamLibraries(weDir) {
  const libs = new Set();
  const libRoot = path.resolve(weDir, '..', '..', '..');
  libs.add(libRoot);
  try {
    const vdf = path.join(libRoot, 'steamapps', 'libraryfolders.vdf');
    if (fs.existsSync(vdf)) {
      const text = fs.readFileSync(vdf, 'utf8');
      const re = /"path"\s+"([^"]+)"/gi;
      let m;
      while ((m = re.exec(text))) {
        const p = m[1].replace(/\\\\/g, '\\');
        if (p) libs.add(path.resolve(p));
      }
    }
  } catch (_) {}
  return Array.from(libs);
}

function walkProjectJsons(root, out, depth) {
  if (!root || out.length >= 400 || depth > 5) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return; }
  for (const ent of entries) {
    if (out.length >= 400) return;
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) walkProjectJsons(full, out, depth + 1);
    else if (ent.isFile() && ent.name.toLowerCase() === 'project.json') out.push(full);
  }
}

function findPreviewPath(dir, raw) {
  const cands = [];
  if (raw) cands.push(path.resolve(dir, String(raw)));
  for (const name of ['preview.jpg', 'preview.jpeg', 'preview.png', 'preview.webp', 'preview.gif']) {
    cands.push(path.join(dir, name));
  }
  let best = '';
  let bestSize = -1;
  for (const p of cands) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
        const size = fs.statSync(p).size;
        if (size > bestSize) { best = p; bestSize = size; }
      }
    } catch (_) {}
  }
  return best;
}

function findVideoInDir(dir, depth) {
  depth = depth || 0;
  if (depth > 2) return '';
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (['.mp4', '.webm', '.mov', '.m4v'].includes(ext)) return full;
      }
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const found = findVideoInDir(path.join(dir, ent.name), depth + 1);
        if (found) return found;
      }
    }
  } catch (_) {}
  return '';
}

function detectWeType(raw, file) {
  const t = String(raw && raw.type || '').toLowerCase();
  if (t === 'video' || t === 'web' || t === 'scene' || t === 'application') return t;
  const ext = path.extname(String(file || '')).toLowerCase();
  if (['.mp4', '.webm', '.mov', '.m4v'].includes(ext)) return 'video';
  if (['.html', '.htm'].includes(ext)) return 'web';
  if (['.pkg', '.json'].includes(ext) || /scene\.json$/i.test(String(file || ''))) return 'scene';
  if (ext === '.exe') return 'application';
  return 'scene';
}

function scanWeWallpapers() {
  weScanCache = new Map();
  const cfgPath = findWeConfigPath();
  if (!cfgPath) return { ok: false, error: '未找到 Wallpaper Engine 配置，请确认 WE 已安装并运行过一次' };
  const cfg = readJsonFileSafe(cfgPath) || {};
  const weDir = String(cfg['?installdirectory'] || path.dirname(cfgPath)).replace(/\//g, path.sep);
  if (!fs.existsSync(weDir)) return { ok: false, error: 'Wallpaper Engine 安装目录不存在' };
  weDirCache = weDir;
  const roots = [];
  for (const lib of collectSteamLibraries(weDir)) {
    roots.push(path.join(lib, 'steamapps', 'workshop', 'content', '431960'));
  }
  roots.push(path.join(weDir, 'projects'));
  const projectFiles = [];
  for (const root of roots) {
    if (fs.existsSync(root)) walkProjectJsons(root, projectFiles, 0);
  }
  const seen = new Set();
  const items = [];
  for (const projectFile of projectFiles) {
    const dir = path.dirname(projectFile);
    if (seen.has(dir.toLowerCase())) continue;
    if (/[\\/](templates|assets)[\\/]/i.test(dir)) continue;
    seen.add(dir.toLowerCase());
    const raw = readJsonFileSafe(projectFile);
    if (!raw) continue;
    const declared = raw.file ? path.resolve(dir, String(raw.file)) : '';
    let weType = detectWeType(raw, declared);
    if (!weType) weType = 'scene';
    let videoPath = '';
    if (weType === 'video') {
      if (declared && fs.existsSync(declared) && fs.statSync(declared).isFile() &&
          ['.mp4', '.webm', '.mov', '.m4v'].includes(path.extname(declared).toLowerCase())) {
        videoPath = declared;
      } else {
        videoPath = findVideoInDir(dir);
      }
    }
    const previewPath = findPreviewPath(dir, raw.preview);
    if (!videoPath && !previewPath) continue;
    let title = String(raw.title || '').trim();
    if (!title || /^[a-f0-9]{16,}$/i.test(title)) {
      const base = path.basename(dir);
      title = 'WE 壁纸 ' + (base.length > 10 ? base.slice(-8) : base);
    }
    const id = 'we_' + crypto.createHash('sha1').update(projectFile.toLowerCase()).digest('hex').slice(0, 12);
    const support = videoPath ? 'dynamic' : 'static';
    const item = {
      id, title, weType, support, projectFile,
      videoPath, previewPath: previewPath || '',
      hasPreview: !!previewPath,
      folder: dir
    };
    weScanCache.set(id, item);
    items.push({
      id, title, weType, support, hasPreview: !!previewPath,
      previewable: !!previewPath,
      recordable: weType === 'scene',
      note: support === 'dynamic' ? '动态视频' : (weType === 'scene' ? '场景壁纸 · 自动录制 15 秒' : '仅静态封面')
    });
  }
  items.sort((a, b) => {
    const da = a.support === 'dynamic' ? 0 : 1;
    const db = b.support === 'dynamic' ? 0 : 1;
    return da - db || String(a.title).localeCompare(String(b.title), 'zh-CN');
  });
  return { ok: true, items: items.slice(0, 300), weDir };
}

function serveLocalFile(req, res, fullPath, cacheSeconds) {
  let stat;
  try {
    stat = fs.statSync(fullPath);
    if (!stat.isFile()) throw new Error('not file');
  } catch (_) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('Not found');
    return;
  }
  const mime = mimeForFile(fullPath);
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=' + (cacheSeconds || 0)
  };
  const range = req.headers.range;
  if (range) {
    const m = String(range).match(/^bytes=(\d*)-(\d*)$/);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (!isFinite(start) || start < 0) start = 0;
      if (!isFinite(end) || end >= stat.size) end = stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Access-Control-Allow-Origin': '*', 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = String(end - start + 1);
      res.writeHead(206, headers);
      fs.createReadStream(fullPath, { start, end }).pipe(res);
      return;
    }
  }
  headers['Content-Length'] = String(stat.size);
  res.writeHead(200, headers);
  fs.createReadStream(fullPath).pipe(res);
}

loadImportedWallpapers();

function formatTrack(s, actLabel) {
  const ar = (s.ar || s.artists || []).map(a => a.name).filter(Boolean).join(' / ') || '未知艺术家';
  const al = s.al || s.album || {};
  const pic = (al.picUrl || '').replace(/^http:/, 'https:');
  return {
    id: 'ncm_' + s.id,
    ncmId: s.id,
    title: s.name || '未知曲目',
    artist: ar,
    album: al.name || '',
    act: 'NCM',
    actLabel: '网易云音乐',
    actZh: actLabel || al.name || '在线歌单',
    duration: Math.round((s.dt || s.duration || 0) / 1000),
    cover: pic ? `${pic}?param=500y500` : '',
    src: `http://${HOST}:${PORT}/api/song/stream?id=${s.id}`,
    isNetease: true
  };
}

async function fetchSongAtLevel(id, lv) {
  let d = null;
  try {
    const q = { id, level: lv, cookie: auth.cookie };
    if (lv === 'sky') q.immerseType = 'c51';
    const r = await api.song_url_v1(q);
    d = r && r.body && r.body.data && r.body.data[0];
  } catch (_) {}
  if ((!d || !d.url) && QUALITY_LEVELS[lv] && QUALITY_LEVELS[lv].br) {
    try {
      const r2 = await api.song_url({ id, br: QUALITY_LEVELS[lv].br, cookie: auth.cookie });
      d = r2 && r2.body && r2.body.data && r2.body.data[0];
    } catch (_) {}
  }
  return d;
}

async function resolveSongUrl(id, level, forceRefresh = false) {
  level = normalizeLevel(level);
  const cacheKey = String(id) + ':' + level;
  if (forceRefresh) {
    songUrlCache.delete(cacheKey);
  } else {
    const cached = songUrlCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached;
  }

  const order = BASE_ORDER.includes(level)
    ? BASE_ORDER.slice(BASE_ORDER.indexOf(level))
    : [level].concat(BASE_ORDER);
  for (const lv of order) {
    const d = await fetchSongAtLevel(id, lv);
    if (d && d.url) {
      const result = {
        url: d.url.replace(/^http:/, 'https:'),
        rawUrl: d.url,
        level: d.level || lv,
        br: d.br || (QUALITY_LEVELS[lv] ? QUALITY_LEVELS[lv].br : 0),
        type: d.type || (QUALITY_LEVELS[lv] ? QUALITY_LEVELS[lv].type : 'flac'),
        size: d.size || 0,
        requested: level,
        expiresAt: Date.now() + 3 * 60 * 1000
      };
      songUrlCache.set(cacheKey, result);
      return result;
    }
  }
  return null;
}

// ===== 音频缓存与流式转发 =====
// 目标：首次播放仍直接走网易云 CDN，但整首完整收到后落盘；之后同一首歌（含拖动进度）
// 全部本地读取。CDN 中途断流时从“已经送出的字节”续传，不再整首重开。
function parseByteRange(value) {
  const m = String(value || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;
  return {
    start: hasStart ? parseInt(m[1], 10) : null,
    end: hasEnd ? parseInt(m[2], 10) : null
  };
}

function audioCacheEntry(id, level) {
  const key = 'ncm_' + String(id).replace(/[^\d]/g, '') + '_' + String(level).replace(/[^a-z0-9]/gi, '');
  return {
    key,
    file: path.join(AUDIO_CACHE_DIR, key + '.audio'),
    meta: path.join(AUDIO_CACHE_DIR, key + '.json'),
    part: path.join(AUDIO_CACHE_DIR, key + '.part')
  };
}

function readAudioCache(id, level, expectedSize) {
  const entry = audioCacheEntry(id, level);
  try {
    const meta = JSON.parse(fs.readFileSync(entry.meta, 'utf8'));
    const st = fs.statSync(entry.file);
    if (!st.isFile() || st.size <= 0 || st.size !== meta.size) return null;
    if (expectedSize && meta.size !== expectedSize) return null;
    return Object.assign({}, entry, { size: st.size, type: meta.type || 'mp3', level: meta.level || level });
  } catch (_) {
    return null;
  }
}

function serveAudioCache(req, res, entry) {
  let stat;
  try {
    stat = fs.statSync(entry.file);
    if (!stat.isFile()) throw new Error('missing');
  } catch (_) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('Not found');
    return false;
  }
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Accept-Ranges': 'bytes',
    'Content-Type': entry.type === 'flac' ? 'audio/flac' : (entry.type === 'mp3' ? 'audio/mpeg' : 'application/octet-stream'),
    'Cache-Control': 'public, max-age=86400'
  };
  const range = parseByteRange(req.headers.range);
  if (range) {
    let start;
    let end;
    if (range.start === null) {
      const suffix = Math.max(0, range.end || 0);
      start = Math.max(0, stat.size - suffix);
      end = stat.size - 1;
    } else {
      start = range.start;
      end = range.end === null ? stat.size - 1 : Math.min(range.end, stat.size - 1);
    }
    if (!isFinite(start) || start < 0) start = 0;
    if (!isFinite(end) || end >= stat.size) end = stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Access-Control-Allow-Origin': '*', 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return true;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = String(end - start + 1);
    res.writeHead(206, headers);
    fs.createReadStream(entry.file, { start, end }).pipe(res);
    return true;
  }
  headers['Content-Length'] = String(stat.size);
  res.writeHead(200, headers);
  fs.createReadStream(entry.file).pipe(res);
  return true;
}

const activeAudioCacheFills = new Set();
const audioDownloadTasks = new Map();

function notifyAudioTask(task) {
  if (!task || !task.waiters || !task.waiters.size) return;
  for (const fn of Array.from(task.waiters)) {
    try { fn(); } catch (_) {}
  }
}

function getOrStartAudioTask(meta, cacheEntry, onAllFailed) {
  const existing = audioDownloadTasks.get(cacheEntry.key);
  if (existing && !existing.failed) return existing;

  ensureAudioCacheDirSafe();
  const task = {
    key: cacheEntry.key,
    entry: cacheEntry,
    id: cacheEntry.id,
    level: cacheEntry.level,
    type: meta.type || cacheEntry.type || 'mp3',
    contentType: '',
    totalSize: cacheEntry.expectedSize || meta.size || 0,
    downloaded: 0,
    headersReady: false,
    done: false,
    failed: false,
    waiters: new Set(),
    redirects: 0,
    resumeCount: 0,
    ws: null
  };
  audioDownloadTasks.set(cacheEntry.key, task);

  try { if (fs.existsSync(cacheEntry.part)) fs.unlinkSync(cacheEntry.part); } catch (_) {}
  try {
    task.ws = fs.createWriteStream(cacheEntry.part);
    task.ws.on('error', () => {
      task.failed = true;
      audioDownloadTasks.delete(task.key);
      notifyAudioTask(task);
    });
  } catch (_) {
    task.failed = true;
    audioDownloadTasks.delete(cacheEntry.key);
    return task;
  }

  const fetchUpstream = (urlStr) => {
    if (task.done || task.failed) return;
    if (task.redirects > 4) {
      task.failed = true;
      try { if (task.ws) task.ws.destroy(); } catch (_) {}
      try { fs.unlinkSync(cacheEntry.part); } catch (_) {}
      audioDownloadTasks.delete(task.key);
      notifyAudioTask(task);
      return;
    }
    let u;
    try { u = new URL(urlStr); } catch (_) {
      task.failed = true;
      audioDownloadTasks.delete(task.key);
      notifyAudioTask(task);
      return;
    }
    const client = u.protocol === 'https:' ? https : http;
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 5.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://music.163.com/',
      'Accept-Encoding': 'identity'
    };
    if (task.downloaded > 0) reqHeaders['Range'] = `bytes=${task.downloaded}-`;
    const reqOpts = {
      method: 'GET',
      headers: reqHeaders,
      agent: client === https ? keepAliveHttps : keepAliveHttp
    };
    if (IPV4_ONLY) {
      reqOpts.family = 4;
      reqOpts.autoSelectFamily = false;
    }

    const uReq = client.request(u, reqOpts, (uRes) => {
      if ([301, 302, 303, 307, 308].includes(uRes.statusCode) && uRes.headers.location) {
        uRes.resume();
        task.redirects++;
        fetchUpstream(new URL(uRes.headers.location, u).toString());
        return;
      }
      if (uRes.statusCode >= 400) {
        uRes.resume();
        handleFail();
        return;
      }
      if (task.downloaded > 0 && uRes.statusCode !== 206) {
        uRes.resume();
        handleFail();
        return;
      }
      if (!task.contentType && uRes.headers['content-type']) {
        task.contentType = uRes.headers['content-type'];
      }
      if (!task.totalSize) {
        const cr = String(uRes.headers['content-range'] || '').match(/\/(\d+)$/);
        if (cr) task.totalSize = parseInt(cr[1], 10) || 0;
        else if (uRes.headers['content-length']) task.totalSize = parseInt(uRes.headers['content-length'], 10) || 0;
      }
      task.headersReady = true;
      notifyAudioTask(task);

      uRes.setTimeout(25000, () => { uRes.destroy(new Error('bg upstream read timeout')); });
      uRes.on('data', (chunk) => {
        if (task.failed || task.done) return;
        task.downloaded += chunk.length;
        try {
          if (task.ws) task.ws.write(chunk);
        } catch (_) {}
        notifyAudioTask(task);
      });
      uRes.on('end', () => {
        if (task.failed || task.done) return;
        if (task.totalSize > 0 && task.downloaded < task.totalSize) {
          handleFail();
          return;
        }
        task.done = true;
        const finish = () => {
          try {
            if (task.downloaded > 0) {
              fs.renameSync(cacheEntry.part, cacheEntry.file);
              fs.writeFileSync(cacheEntry.meta, JSON.stringify({
                id: cacheEntry.id, level: cacheEntry.level, size: task.downloaded, type: task.type, cachedAt: Date.now()
              }), 'utf8');
              console.log('[Nientum NeteaseBridge] audio cached: ' + cacheEntry.key + ' (' + Math.round(task.downloaded / 1024) + ' KB)');
              setTimeout(pruneAudioCache, 80);
            }
          } catch (_) {
            try { fs.unlinkSync(cacheEntry.part); } catch (_) {}
          }
          audioDownloadTasks.delete(task.key);
          notifyAudioTask(task);
        };
        if (task.ws) task.ws.end(finish); else finish();
      });
      let failedThisAttempt = false;
      const handleFail = () => {
        if (failedThisAttempt || task.done || task.failed) return;
        failedThisAttempt = true;
        if (task.downloaded > 0 && task.resumeCount < 6) {
          task.resumeCount++;
          setTimeout(() => fetchUpstream(urlStr), 250);
          return;
        }
        if (onAllFailed && !task.headersReady) {
          audioDownloadTasks.delete(task.key);
          try { if (task.ws) task.ws.destroy(); } catch (_) {}
          try { fs.unlinkSync(cacheEntry.part); } catch (_) {}
          onAllFailed(task);
          return;
        }
        task.failed = true;
        try { if (task.ws) task.ws.destroy(); } catch (_) {}
        try { fs.unlinkSync(cacheEntry.part); } catch (_) {}
        audioDownloadTasks.delete(task.key);
        notifyAudioTask(task);
      };
      uRes.on('error', handleFail);
      uRes.on('aborted', handleFail);
    });
    uReq.setTimeout(15000, () => { uReq.destroy(new Error('bg upstream connect timeout')); });
    uReq.on('error', () => {
      if (task.done || task.failed) return;
      if (task.downloaded > 0 && task.resumeCount < 6) {
        task.resumeCount++;
        setTimeout(() => fetchUpstream(urlStr), 300);
        return;
      }
      task.failed = true;
      try { if (task.ws) task.ws.destroy(); } catch (_) {}
      try { fs.unlinkSync(cacheEntry.part); } catch (_) {}
      audioDownloadTasks.delete(task.key);
      notifyAudioTask(task);
    });
    uReq.end();
  };

  fetchUpstream(meta.url);
  return task;
}

function ensureAudioCacheDirSafe() {
  try { fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true }); } catch (_) {}
}

function serveDownloadingAudio(req, res, task, onEarlyFail) {
  let closed = false;
  let started = false;
  let headersSent = false;
  let pos = 0;
  let endPos = null;
  let pumping = false;

  const cleanup = () => {
    closed = true;
    task.waiters.delete(onUpdate);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  const readChunk = (offset, len) => {
    const buf = Buffer.allocUnsafe(len);
    const tryRead = (p) => {
      const fd = fs.openSync(p, 'r');
      try {
        const n = fs.readSync(fd, buf, 0, len, offset);
        return n > 0 ? buf.subarray(0, n) : null;
      } finally {
        fs.closeSync(fd);
      }
    };
    try {
      return tryRead(task.done ? task.entry.file : task.entry.part);
    } catch (_) {
      try { return tryRead(task.done ? task.entry.part : task.entry.file); } catch (_) { return null; }
    }
  };

  const pump = () => {
    if (closed || pumping || res.writableEnded || res.destroyed) return;
    pumping = true;
    try {
      while (!closed && !res.writableEnded && !res.destroyed) {
        if (endPos !== null && pos > endPos) {
          res.end();
          cleanup();
          return;
        }
        const avail = task.downloaded;
        if (pos < avail) {
          const maxTo = endPos !== null ? Math.min(avail - 1, endPos) : (avail - 1);
          const toRead = Math.min(262144, maxTo - pos + 1);
          if (toRead <= 0) break;
          const slice = readChunk(pos, toRead);
          if (!slice || !slice.length) break;
          pos += slice.length;
          if (!res.write(slice)) {
            res.once('drain', () => { pumping = false; pump(); });
            pumping = false;
            return;
          }
          continue;
        }
        if (task.done) {
          res.end();
          cleanup();
          return;
        }
        if (task.failed) {
          if (!headersSent && onEarlyFail) { cleanup(); onEarlyFail(); return; }
          if (!res.writableEnded) res.end();
          cleanup();
          return;
        }
        break;
      }
    } finally {
      pumping = false;
    }
  };

  const onUpdate = () => {
    if (closed) return;
    if (!started) {
      if (task.failed && !task.headersReady) {
        cleanup();
        if (onEarlyFail) onEarlyFail();
        else if (!res.headersSent) { res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); res.end(); }
        return;
      }
      if (!task.headersReady && task.downloaded === 0 && !task.done) return;
      started = true;
      const total = task.totalSize || (task.done ? task.downloaded : 0);
      const range = parseByteRange(req.headers.range);
      if (range && total > 0) {
        if (range.start === null) {
          const suffix = Math.max(0, range.end || 0);
          pos = Math.max(0, total - suffix);
          endPos = total - 1;
        } else {
          pos = range.start;
          endPos = range.end === null ? total - 1 : Math.min(range.end, total - 1);
        }
        if (pos > endPos || pos >= total) {
          res.writeHead(416, { 'Access-Control-Allow-Origin': '*', 'Content-Range': `bytes */${total}` });
          res.end();
          cleanup();
          return;
        }
        res.writeHead(206, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
          'Content-Type': task.contentType || (task.type === 'flac' ? 'audio/flac' : 'audio/mpeg'),
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${pos}-${endPos}/${total}`,
          'Content-Length': String(endPos - pos + 1),
          'Cache-Control': 'public, max-age=86400'
        });
      } else {
        pos = range && range.start ? range.start : 0;
        endPos = total > 0 ? total - 1 : null;
        const h = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
          'Content-Type': task.contentType || (task.type === 'flac' ? 'audio/flac' : 'audio/mpeg'),
          'Accept-Ranges': total > 0 ? 'bytes' : 'none',
          'Cache-Control': 'public, max-age=86400'
        };
        if (total > 0) h['Content-Length'] = String(total);
        res.writeHead(200, h);
      }
      headersSent = true;
    }
    pump();
  };

  task.waiters.add(onUpdate);
  onUpdate();
}

function pruneAudioCache() {
  try {
    fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
    const files = fs.readdirSync(AUDIO_CACHE_DIR);
    const items = [];
    let total = 0;
    const now = Date.now();
    for (const f of files) {
      const full = path.join(AUDIO_CACHE_DIR, f);
      try {
        const st = fs.statSync(full);
        if (f.endsWith('.part')) {
          if (now - st.mtimeMs > 6 * 3600 * 1000) fs.unlinkSync(full);
          continue;
        }
        if (!f.endsWith('.audio')) continue;
        if (now - st.mtimeMs < 60000) continue;
        items.push({ name: f, size: st.size, mtime: st.mtimeMs });
        total += st.size;
      } catch (_) {}
    }
    if (total <= AUDIO_CACHE_MAX_BYTES) return;
    items.sort((a, b) => b.mtime - a.mtime);
    for (let i = items.length - 1; i >= 0 && total > AUDIO_CACHE_MAX_BYTES; i--) {
      const it = items[i];
      try { fs.unlinkSync(path.join(AUDIO_CACHE_DIR, it.name)); total -= it.size; } catch (_) {}
      try { fs.unlinkSync(path.join(AUDIO_CACHE_DIR, it.name.replace(/\.audio$/, '.json'))); } catch (_) {}
    }
    console.log('[Nientum NeteaseBridge] audio cache pruned to ' + Math.round(total / 1048576) + ' MB');
  } catch (_) {}
}

function finalizeAudioCache(cache, cacheStream, cacheWritten) {
  if (!cache || cache.done) return;
  cache.done = true;
  cacheStream.end(() => {
    try {
      if (cacheWritten > 0 && cacheWritten === cache.expectedSize) {
        fs.renameSync(cache.part, cache.file);
        fs.writeFileSync(cache.meta, JSON.stringify({
          id: cache.id, level: cache.level, size: cacheWritten, type: cache.type, cachedAt: Date.now()
        }), 'utf8');
        console.log('[Nientum NeteaseBridge] audio cached: ' + cache.key + ' (' + Math.round(cacheWritten / 1024) + ' KB)');
        setTimeout(pruneAudioCache, 80);
      } else {
        try { fs.unlinkSync(cache.part); } catch (_) {}
      }
    } catch (_) {
      try { fs.unlinkSync(cache.part); } catch (_) {}
    }
    activeAudioCacheFills.delete(cache.key);
  });
}

function proxyAudio(targetUrl, req, res, opts = {}) {
  const state = Object.assign({
    redirects: 0,
    resumeCount: 0,
    headersSent: false,
    offset: null,
    endOffset: null,
    clientRange: null,
    onFail: null,
    cache: null,
    forceFull: false
  }, opts || {});
  const dbg = process.env.NIENTUM_DEBUG_STREAM === '1';
  if (dbg) console.log('[stream] start headersSent=' + state.headersSent + ' offset=' + state.offset + ' range=' + (req.headers.range || '-'));

  if (state.redirects > 4) {
    if (!res.headersSent) res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
    if (!res.writableEnded) res.end('Too many redirects');
    return;
  }

  const u = new URL(targetUrl);
  const client = u.protocol === 'https:' ? https : http;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://music.163.com/',
    'Accept-Encoding': 'identity'
  };
  if (state.headersSent) {
    const from = state.offset;
    headers['Range'] = 'bytes=' + from + '-' + (state.endOffset !== null && state.endOffset !== undefined ? state.endOffset : '');
  } else if (state.clientRange && state.clientRange.start !== null && !(state.forceFull && state.clientRange.start === 0)) {
    headers['Range'] = req.headers.range;
  }

  const requestOptions = {
    method: 'GET',
    headers,
    agent: client === https ? keepAliveHttps : keepAliveHttp
  };
  if (IPV4_ONLY) {
    requestOptions.family = 4;
    requestOptions.autoSelectFamily = false;
  }

  let settled = false;
  let resumeScheduled = false;
  let bytesThisAttempt = 0;
  let cacheStream = null;
  let cacheWritten = 0;
  let cachePaused = false;
  const cache = state.cache;

  if (cache && !state.headersSent && !activeAudioCacheFills.has(cache.key)) {
    activeAudioCacheFills.add(cache.key);
  } else if (cache) {
    state.cache = null;
  }
  const activeCache = state.cache;

  const abortCache = () => {
    if (!activeCache) return;
    if (cacheStream) {
      try { cacheStream.destroy(); } catch (_) {}
      try { fs.unlinkSync(activeCache.part); } catch (_) {}
      cacheStream = null;
    }
    activeAudioCacheFills.delete(activeCache.key);
  };

  const pReq = client.request(u, requestOptions, (pRes) => {
    if ([301, 302, 303, 307, 308].includes(pRes.statusCode) && pRes.headers.location) {
      settled = true;
      pRes.resume();
      if (state.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      const nextUrl = new URL(pRes.headers.location, u).toString();
      proxyAudio(nextUrl, req, res, Object.assign({}, state, { redirects: state.redirects + 1 }));
      return;
    }

    if (state.headersSent) {
      // 续传必须从请求的 offset 返回；CDN 不认 Range 时宁可断开让页面刷新链接。
      if (pRes.statusCode !== 206) {
        pRes.resume();
        if (!res.writableEnded) res.end();
        return;
      }
      const cr = String(pRes.headers['content-range'] || '').match(/^bytes\s+(\d+)-/i);
      if (cr && parseInt(cr[1], 10) !== state.offset) {
        pRes.resume();
        if (!res.writableEnded) res.end();
        return;
      }
    } else if (pRes.statusCode >= 400 && pRes.statusCode !== 416 && state.onFail) {
      settled = true;
      pRes.resume();
      state.onFail();
      return;
    }

    settled = true;
    if (dbg) console.log('[stream] upstream status=' + pRes.statusCode + ' range=' + (pRes.headers['content-range'] || '-') + ' len=' + (pRes.headers['content-length'] || '-') + ' accept=' + (pRes.headers['accept-ranges'] || '-'));

    if (!state.headersSent) {
      const outHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
        'Cache-Control': 'public, max-age=86400',
        'Content-Type': pRes.headers['content-type'] || (activeCache && activeCache.type === 'flac' ? 'audio/flac' : 'audio/mpeg'),
        'Accept-Ranges': pRes.headers['accept-ranges'] || 'bytes'
      };
      let outStatus = pRes.statusCode || 200;
      if (pRes.headers['content-length']) outHeaders['Content-Length'] = pRes.headers['content-length'];
      if (pRes.headers['content-range']) outHeaders['Content-Range'] = pRes.headers['content-range'];
      // 客户端发了 Range: bytes=0-，但我们为了落盘改取了完整响应；这里补回 206 语义，
      // 让 CEF 认为资源可 Range（不影响整段顺序下载）。
      if (state.forceFull && state.clientRange && outStatus === 200 && outHeaders['Content-Length']) {
        const fullLen = parseInt(outHeaders['Content-Length'], 10);
        if (fullLen > 0) {
          outHeaders['Content-Range'] = 'bytes 0-' + (fullLen - 1) + '/' + fullLen;
          outStatus = 206;
        }
      }
      res.writeHead(outStatus, outHeaders);
    }

    // 只有完整 200 响应才值得落盘；带 Content-Range 的部分响应直接透传。
    if (activeCache && !cacheStream && pRes.statusCode === 200) {
      const len = parseInt(pRes.headers['content-length'] || '0', 10);
      const size = activeCache.expectedSize || len;
      if (size > 0 && len === size && size <= AUDIO_CACHE_MAX_BYTES) {
        try {
          fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
          cacheStream = fs.createWriteStream(activeCache.part);
          cacheStream.on('error', () => { cacheStream = null; activeAudioCacheFills.delete(activeCache.key); });
        } catch (_) {
          cacheStream = null;
          activeAudioCacheFills.delete(activeCache.key);
        }
      }
    }

    const rangeSupported = pRes.statusCode === 206 || String(pRes.headers['accept-ranges'] || '').toLowerCase() === 'bytes';
    let clientPaused = false;
    const pauseReasons = new Set();
    const pauseUpstream = (reason) => {
      pauseReasons.add(reason);
      try { pRes.pause(); } catch (_) {}
    };
    const resumeUpstream = (reason) => {
      pauseReasons.delete(reason);
      if (pauseReasons.size === 0) {
        try { pRes.resume(); } catch (_) {}
      }
    };
    pRes.setTimeout(30000, () => {
      pRes.destroy(new Error('Upstream read timeout'));
    });
    pRes.on('data', (chunk) => {
      bytesThisAttempt += chunk.length;
      if (dbg && bytesThisAttempt <= chunk.length) console.log('[stream] first chunk ' + chunk.length + ' bytes');
      if (cacheStream) {
        cacheWritten += chunk.length;
        try {
          if (!cacheStream.write(chunk) && !cachePaused) {
            cachePaused = true;
            pauseUpstream('cache');
            cacheStream.once('drain', () => {
              cachePaused = false;
              resumeUpstream('cache');
            });
          }
        } catch (_) {
          cacheStream = null;
        }
      }
      if (!res.destroyed && !res.writableEnded) {
        try {
          if (!res.write(chunk) && !clientPaused) {
            clientPaused = true;
            pauseUpstream('client');
            res.once('drain', () => {
              clientPaused = false;
              resumeUpstream('client');
            });
          }
        } catch (_) {}
      }
    });
    pRes.on('end', () => {
      if (cacheStream) finalizeAudioCache(activeCache, cacheStream, cacheWritten);
      if (!res.writableEnded && !res.destroyed) {
        try { res.end(); } catch (_) {}
      }
    });
    let failureHandled = false;
    const handleUpstreamFailure = () => {
      if (failureHandled) return;
      failureHandled = true;
      abortCache();
      if (dbg) console.log('[stream] failure handled ended=' + res.writableEnded + ' destroyed=' + res.destroyed + ' bytes=' + bytesThisAttempt);
      if (res.writableEnded || res.destroyed) return;
      const sentOffsetBase = state.headersSent ? state.offset : (state.clientRange && state.clientRange.start !== null ? state.clientRange.start : 0);
      const nextOffset = sentOffsetBase + bytesThisAttempt;
      const clientEnd = state.headersSent ? state.endOffset : (state.clientRange ? state.clientRange.end : null);
      const canResume = rangeSupported && state.resumeCount < 3;
      if (canResume && (clientEnd === null || clientEnd === undefined || nextOffset <= clientEnd)) {
        console.log('[Nientum NeteaseBridge] stream resumed at byte ' + nextOffset);
        resumeScheduled = true;
        setTimeout(() => {
          if (dbg) console.log('[stream] resume tick ended=' + res.writableEnded + ' destroyed=' + res.destroyed);
          if (res.writableEnded || res.destroyed) return;
          proxyAudio(targetUrl, req, res, Object.assign({}, state, {
            headersSent: true,
            offset: nextOffset,
            endOffset: clientEnd,
            resumeCount: state.resumeCount + 1,
            cache: null,
            onFail: null
          }));
        }, 220);
        return;
      }
      if (!res.writableEnded) res.end();
    };
    pRes.on('error', handleUpstreamFailure);
    pRes.on('aborted', handleUpstreamFailure);
  });

  pReq.setTimeout(20000, () => {
    pReq.destroy(new Error('Upstream connect timeout'));
  });

  pReq.on('error', (err) => {
    if (dbg) console.log('[stream] request error: ' + (err && err.message));
    abortCache();
    if (!settled && state.onFail && !res.headersSent && !res.writableEnded) {
      settled = true;
      state.onFail();
      return;
    }
    if (resumeScheduled) return;
    if (!res.headersSent) {
      res.writeHead(502, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    }
    if (!res.writableEnded) res.end('Stream error');
  });

  res.once('close', () => {
    if (!res.writableEnded) {
      abortCache();
      try { pReq.destroy(); } catch (_) {}
    }
  });
  pReq.end();
}

async function refreshProfile() {
  if (!auth.cookie) {
    auth.profile = null;
    return null;
  }
  const st = await api.login_status({ cookie: auth.cookie });
  const prof = st && st.body && st.body.data && st.body.data.profile;
  if (prof && prof.userId) {
    auth.profile = {
      userId: prof.userId,
      nickname: prof.nickname,
      avatarUrl: (prof.avatarUrl || '').replace(/^http:/, 'https:'),
      vipType: prof.vipType || 0
    };
    saveAuth(auth);
    return auth.profile;
  }
  auth.profile = null;
  return null;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range'
    });
    res.end();
    return;
  }

  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = u.pathname;

  try {
    if (p === '/api/ping') {
      return sendJson(res, 200, { ok: true, bridgeVer: BRIDGE_VER, dir: CODE_DIR, dataDir: DATA_DIR, port: PORT, cache: AUDIO_CACHE_DIR });
    }

    if (p === '/api/shutdown' && req.method === 'POST') {
      sendJson(res, 200, { ok: true, stopping: true });
      setTimeout(() => { try { server.close(); } catch (_) {} process.exit(0); }, 40);
      return;
    }

    if (p === '/api/ui-state') {
      const patch = {};
      const mode = (u.searchParams.get('mode') || '').toLowerCase();
      if (mode === 'capsule' || mode === 'theater' || mode === 'pure' || mode === 'card') {
        uiMode = mode;
        patch.mode = mode;
      }
      const drawerParam = (u.searchParams.get('drawer') || '').toLowerCase();
      const drParam = u.searchParams.get('dr');
      if (drawerParam === 'closed') {
        patch.drawer = 'closed';
      } else if (drParam !== null) {
        const parts = drParam.split(',').map(Number);
        if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > parts[0] && parts[3] > parts[1]) {
          patch.dr = parts.map(v => v.toFixed(4)).join(',');
        } else if (!drParam) {
          patch.dr = '';
        }
      }
      if (u.searchParams.has('hoverItem')) {
        patch.hoverItem = u.searchParams.get('hoverItem') || '';
      }
      if (Object.keys(patch).length) {
        callWheelBridge('/bridge/state', patch, 350);
      }
      return sendJson(res, 200, { ok: true, mode: uiMode });
    }

    if (p === '/api/input-state') {
      const on = u.searchParams.get('on') === '1' ? '1' : '0';
      const clean = (v) => String(v || '').replace(/[|\r\n]/g, '');
      const field = clean(u.searchParams.get('field'));
      const x = parseInt(u.searchParams.get('x'), 10) || 0;
      const y = parseInt(u.searchParams.get('y'), 10) || 0;
      const w = parseInt(u.searchParams.get('w'), 10) || 0;
      const h = parseInt(u.searchParams.get('h'), 10) || 0;
      const value = clean(u.searchParams.get('value'));
      callWheelBridge('/bridge/input', { on, field, x: String(x), y: String(y), w: String(w), h: String(h), value }, 500);
      return sendJson(res, 200, { ok: true, on });
    }

    if (p === '/api/focus') {
      const blurParam = u.searchParams.get('blur');
      if (blurParam !== null) {
        focusState = { blur: blurParam === '1' || blurParam === 'true', ts: Date.now() };
      }
      return sendJson(res, 200, { ok: true, blur: focusState.blur, ts: focusState.ts });
    }

    if (p === '/api/native-input') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (body && body.field) {
          nativeInputMemory = {
            seq: Number(body.seq) || (nativeInputMemory.seq + 1),
            field: String(body.field),
            text: String(body.text || ''),
            commit: body.commit !== false,
            ts: Number(body.ts) || Date.now()
          };
        }
        return sendJson(res, 200, { ok: true });
      }
      const data = Object.assign({}, nativeInputMemory);
      data.focusBlur = focusState.blur;
      data.focusTs = focusState.ts;
      data.menuOpen = !!(hookContextMenuState.open && Date.now() - hookContextMenuState.ts < 120000);
      data.menuInvokedSeq = hookContextMenuState.invokedSeq || 0;
      return sendJson(res, 200, data);
    }

    if (p === '/api/status') {
      const profile = await refreshProfile();
      return sendJson(res, 200, { ok: true, loggedIn: !!profile, profile });
    }

    if (p === '/api/liked') {
      if (auth.cookie && (!auth.profile || !auth.profile.userId)) {
        await refreshProfile();
      }
      if (!auth.cookie || !auth.profile || !auth.profile.userId) {
        return sendJson(res, 200, { ok: false, error: '未登录网易云', ids: [] });
      }
      try {
        const r = await api.likelist({ uid: auth.profile.userId, cookie: auth.cookie, timestamp: Date.now() });
        const body = (r && r.body) || {};
        const ids = Array.isArray(body.ids) ? body.ids
          : (body.data && Array.isArray(body.data.ids) ? body.data.ids
          : (Array.isArray(body.data) ? body.data : []));
        return sendJson(res, 200, { ok: true, ids });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: (e && e.message) || '获取收藏失败', ids: [] });
      }
    }

    if (p === '/api/song/like') {
      const id = u.searchParams.get('id');
      const like = u.searchParams.get('like') !== '0';
      if (!id) return sendJson(res, 400, { ok: false, error: '缺少歌曲 id' });
      if (!auth.cookie) return sendJson(res, 200, { ok: false, error: '未登录网易云' });
      try {
        const r = await api.like({ id, like: like ? 'true' : 'false', cookie: auth.cookie, timestamp: Date.now() });
        const body = (r && r.body) || {};
        const code = body.code || (body.data && body.data.code);
        if (code !== 200) {
          return sendJson(res, 200, { ok: false, error: body.message || body.msg || '收藏失败', code: code || 0 });
        }
        return sendJson(res, 200, { ok: true, liked: like, code });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: (e && e.message) || '收藏失败' });
      }
    }

    if (p === '/api/qr/create') {
      const kRes = await api.login_qr_key({ timestamp: Date.now() });
      const unikey = kRes.body && kRes.body.data && kRes.body.data.unikey;
      if (!unikey) return sendJson(res, 500, { ok: false, error: '无法生成二维码 key' });
      const qRes = await api.login_qr_create({ key: unikey, qrimg: true, timestamp: Date.now() });
      const qrimg = qRes.body && qRes.body.data && qRes.body.data.qrimg;
      return sendJson(res, 200, { ok: true, key: unikey, qrimg });
    }

    if (p === '/api/qr/check') {
      const key = u.searchParams.get('key') || '';
      const cRes = await api.login_qr_check({ key, timestamp: Date.now() });
      const body = cRes.body || {};
      if (body.code === 803 && body.cookie) {
        auth.cookie = body.cookie;
        await refreshProfile();
        saveAuth(auth);
      }
      return sendJson(res, 200, {
        ok: true,
        code: body.code,
        message: body.message || '',
        loggedIn: body.code === 803,
        profile: auth.profile
      });
    }

    if (p === '/api/logout') {
      auth = { cookie: '', profile: null };
      saveAuth(auth);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/playlists') {
      const profile = auth.profile || (await refreshProfile());
      if (!profile || !profile.userId) {
        return sendJson(res, 401, { ok: false, error: '未登录' });
      }
      const plRes = await api.user_playlist({ uid: profile.userId, limit: 100, cookie: auth.cookie });
      const list = ((plRes.body && plRes.body.playlist) || []).map(pl => ({
        id: pl.id,
        name: pl.name,
        trackCount: pl.trackCount || 0,
        cover: (pl.coverImgUrl || '').replace(/^http:/, 'https:') + '?param=300y300',
        creator: pl.creator ? pl.creator.nickname : ''
      }));
      return sendJson(res, 200, { ok: true, playlists: list });
    }

    if (p === '/api/playlist/tracks') {
      const id = u.searchParams.get('id');
      const name = u.searchParams.get('name') || '歌单';
      if (!id) return sendJson(res, 400, { ok: false, error: '缺少歌单 id' });
      const tRes = await api.playlist_track_all({ id, limit: 300, offset: 0, cookie: auth.cookie });
      const tracks = ((tRes.body && tRes.body.songs) || []).map(s => formatTrack(s, name));
      return sendJson(res, 200, { ok: true, tracks });
    }

    if (p === '/api/recommend') {
      if (!auth.cookie) return sendJson(res, 401, { ok: false, error: '未登录' });
      const rRes = await api.recommend_songs({ cookie: auth.cookie });
      const raw = (rRes.body && rRes.body.data && rRes.body.data.dailySongs) || [];
      const tracks = raw.map(s => formatTrack(s, '每日推荐'));
      return sendJson(res, 200, { ok: true, tracks });
    }

    if (p === '/api/search') {
      const keywords = (u.searchParams.get('keywords') || '').trim();
      if (!keywords) return sendJson(res, 200, { ok: true, tracks: [] });
      const sRes = await api.cloudsearch({ keywords, limit: 50, type: 1, cookie: auth.cookie });
      const raw = (sRes.body && sRes.body.result && sRes.body.result.songs) || [];
      const tracks = raw.map(s => formatTrack(s, `搜索：${keywords}`));
      return sendJson(res, 200, { ok: true, tracks });
    }

    if (p === '/api/song/resolve') {
      const id = u.searchParams.get('id');
      const level = normalizeLevel(u.searchParams.get('level'));
      if (!id) return sendJson(res, 400, { ok: false, error: '缺少歌曲 id' });
      const meta = await resolveSongUrl(id, level);
      return sendJson(res, 200, {
        ok: !!meta,
        requested: level,
        levels: Object.keys(QUALITY_LEVELS).map(k => ({ level: k, label: QUALITY_LEVELS[k].label, br: QUALITY_LEVELS[k].br })),
        resolved: meta ? { level: meta.level, br: meta.br, type: meta.type, size: meta.size, url: meta.url } : null
      });
    }

    if (p === '/api/song/lyric') {
      const id = u.searchParams.get('id');
      if (!id) return sendJson(res, 400, { ok: false, error: '缺少歌曲 id' });
      const key = String(id);
      if (lyricCache.has(key)) {
        return sendJson(res, 200, lyricCache.get(key));
      }
      const lRes = await api.lyric({ id: key, cookie: auth.cookie });
      const body = (lRes && lRes.body) || {};
      const data = {
        ok: true,
        lrc: (body.lrc && body.lrc.lyric) || '',
        tlyric: (body.tlyric && body.tlyric.lyric) || ''
      };
      if (lyricCache.size > 100) {
        const firstKey = lyricCache.keys().next().value;
        lyricCache.delete(firstKey);
      }
      lyricCache.set(key, data);
      return sendJson(res, 200, data);
    }

    if (p === '/api/song/stream') {
      const id = u.searchParams.get('id');
      const level = normalizeLevel(u.searchParams.get('level'));
      const forceRefresh = u.searchParams.get('refresh') === '1';
      if (!id) {
        res.writeHead(400);
        res.end('missing id');
        return;
      }
      // 先按请求档位直接命中磁盘缓存：连网易云解析都省掉。
      const preCache = readAudioCache(id, level);
      if (preCache) {
        console.log('[Nientum NeteaseBridge] audio cache hit: ' + preCache.key);
        serveAudioCache(req, res, preCache);
        return;
      }
      let meta = await resolveSongUrl(id, level, forceRefresh);
      if (!meta) {
        await new Promise(r => setTimeout(r, 350));
        meta = await resolveSongUrl(id, level, true);
      }
      if (!meta) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end('No playable url');
        return;
      }
      const resolvedCache = readAudioCache(id, meta.level, meta.size || 0);
      if (resolvedCache) {
        console.log('[Nientum NeteaseBridge] audio cache hit: ' + resolvedCache.key);
        serveAudioCache(req, res, resolvedCache);
        return;
      }
      const clientRange = parseByteRange(req.headers.range);
      const canUseTask = meta.size <= 0 || meta.size <= AUDIO_CACHE_MAX_BYTES;
      if (canUseTask) {
        const cacheEntry = Object.assign(audioCacheEntry(id, meta.level), {
          id: String(id),
          level: meta.level,
          expectedSize: meta.size || 0,
          type: meta.type || 'mp3',
          done: false
        });
        const task = getOrStartAudioTask(meta, cacheEntry);
        serveDownloadingAudio(req, res, task, async () => {
          try {
            const fresh = await resolveSongUrl(id, level, true);
            if (fresh && fresh.url && !res.headersSent && !res.writableEnded) {
              proxyAudio(fresh.url, req, res, { clientRange });
              return;
            }
          } catch (_) {}
          if (!res.headersSent) res.writeHead(502, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
          if (!res.writableEnded) res.end('Stream fallback failed');
        });
        return;
      }
      const wantCache = (!clientRange || (clientRange.start === 0 && clientRange.end === null)) &&
        meta.size > 0 && meta.size <= AUDIO_CACHE_MAX_BYTES;
      const cacheEntry = wantCache ? Object.assign(audioCacheEntry(id, meta.level), {
        id: String(id),
        level: meta.level,
        expectedSize: meta.size,
        type: meta.type || 'mp3',
        done: false
      }) : null;

      const finalFail = () => {
        if (!res.headersSent) res.writeHead(502, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        if (!res.writableEnded) res.end('Stream fallback failed');
      };
      const onFail = async () => {
        try {
          const fresh = await resolveSongUrl(id, level, true);
          if (fresh && fresh.url && !res.headersSent && !res.writableEnded) {
            proxyAudio(fresh.url, req, res, {
              clientRange,
              cache: cacheEntry,
              forceFull: !!cacheEntry,
              onFail: () => {
                if (fresh.rawUrl && fresh.rawUrl !== fresh.url && !res.headersSent) {
                  proxyAudio(fresh.rawUrl, req, res, { clientRange });
                  return;
                }
                finalFail();
              }
            });
            return;
          }
        } catch (_) {}
        finalFail();
      };

      proxyAudio(meta.url, req, res, {
        clientRange,
        cache: cacheEntry,
        forceFull: !!cacheEntry,
        onFail
      });
      return;
    }

    if (p === '/api/clipboard') {
      execFile('powershell.exe', [
        '-NoProfile', '-STA', '-Command',
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $t = Get-Clipboard -Raw; if ($null -ne $t) { [Console]::Out.Write($t) }'
      ], { timeout: 2500, encoding: 'utf8' }, (err, stdout) => {
        const text = (stdout || '').replace(/\r?\n/g, ' ').trim();
        sendJson(res, 200, { ok: !err, text });
      });
      return;
    }

    if (p === '/api/fs/slots' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, slots: loadDockSlots() });
    }

    if (p === '/api/fs/slots' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.slots)) {
        return sendJson(res, 400, { ok: false, error: 'slots must be array' });
      }
      const clean = body.slots.slice(0, 16).map((s, idx) => ({
        id: String((s && s.id) || `slot_${Date.now()}_${idx}`),
        title: String((s && s.title) || '文件夹').slice(0, 20),
        path: String((s && s.path) || '@desktop'),
        card: String((s && s.card) || 'cover_act0').slice(0, 260)
      }));
      saveDockSlots(clean);
      return sendJson(res, 200, { ok: true, slots: clean });
    }

    if (p === '/api/fs/list') {
      const rawPath = u.searchParams.get('path') || '@desktop';
      const targetDir = resolveSpecialPath(rawPath);
      try {
        const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
        const ignoreNames = new Set(['desktop.ini', 'thumbs.db', '$recycle.bin', 'system volume information']);
        const items = [];
        for (const ent of entries) {
          const lower = ent.name.toLowerCase();
          if (ent.name.startsWith('.') || ignoreNames.has(lower)) continue;
          const full = path.join(targetDir, ent.name);
          const isDir = ent.isDirectory();
          let size = 0;
          let mtime = 0;
          try {
            const st = await fs.promises.stat(full);
            size = st.size || 0;
            mtime = st.mtimeMs || 0;
          } catch (_) {}
          items.push({
            name: ent.name,
            path: full,
            isDir,
            ext: isDir ? '' : path.extname(ent.name).toLowerCase(),
            size,
            mtime
          });
          if (items.length >= 300) break;
        }
        items.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name, 'zh-CN');
        });
        const parent = path.dirname(targetDir);
        return sendJson(res, 200, {
          ok: true,
          path: targetDir,
          parent: parent !== targetDir ? parent : '',
          items
        });
      } catch (err) {
        return sendJson(res, 200, { ok: false, path: targetDir, error: (err && err.message) || '无法读取目录', items: [] });
      }
    }

    if (p === '/api/fs/open' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const rawTarget = String(body.path || '').trim();
      if (!rawTarget) return sendJson(res, 400, { ok: false, error: 'missing path' });
      if (rawTarget === '@thispc') {
        spawn('explorer.exe', ['shell:MyComputerFolder'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        return sendJson(res, 200, { ok: true, path: rawTarget });
      }
      if (rawTarget === '@recyclebin') {
        spawn('explorer.exe', ['shell:RecycleBinFolder'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        return sendJson(res, 200, { ok: true, path: rawTarget });
      }
      const target = path.win32.normalize(resolveSpecialPath(rawTarget));
      if (!fs.existsSync(target)) {
        return sendJson(res, 200, { ok: false, error: '路径不存在: ' + target });
      }
      const st = fs.statSync(target);
      try {
        if (body.reveal) {
          spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        } else if (st.isDirectory()) {
          spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        } else {
          spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        }
        return sendJson(res, 200, { ok: true, path: target });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: (err && err.message) || '打开失败' });
      }
    }

    if (p === '/api/fs/context-menu/event') {
      let st = '';
      let inv = false;
      if (req.method === 'POST') {
        let raw = '';
        await new Promise((resolve) => {
          req.on('data', (c) => { raw += c; });
          req.on('end', resolve);
          req.on('error', resolve);
        });
        const sp = new URLSearchParams(raw || u.search);
        st = (sp.get('state') || '').toLowerCase();
        inv = sp.get('invoked') === '1';
      } else {
        st = (u.searchParams.get('state') || '').toLowerCase();
        inv = u.searchParams.get('invoked') === '1';
      }
      if (st === 'open') {
        hookContextMenuState.open = true;
        hookContextMenuState.ts = Date.now();
      } else if (st === 'done') {
        hookContextMenuState.open = false;
        hookContextMenuState.ts = Date.now();
        if (inv) hookContextMenuState.invokedSeq = (hookContextMenuState.invokedSeq || 0) + 1;
      }
      return sendJson(res, 200, { ok: true, menuOpen: hookContextMenuState.open, menuInvokedSeq: hookContextMenuState.invokedSeq });
    }

    if (p === '/api/fs/context-menu' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const rawPath = String((body && body.path) || '').trim();
      if (!rawPath) return sendJson(res, 200, { ok: false, error: 'missing_path' });
      let target = rawPath;
      if (rawPath !== '@thispc' && rawPath !== '@recyclebin') {
        target = resolveSpecialPath(rawPath);
        if (!fs.existsSync(target)) {
          return sendJson(res, 200, { ok: false, error: '文件或目录不存在' });
        }
      }
      hookContextMenuState.open = true;
      hookContextMenuState.ts = Date.now();
      const result = await callWheelBridge('/bridge/shell-menu', { path: target }, 180000);
      hookContextMenuState.open = false;
      hookContextMenuState.ts = Date.now();
      if (!result) return sendJson(res, 200, { ok: false, error: '未连接 NientumWheelBridge' });
      return sendJson(res, 200, result);
    }

    if (p === '/api/fs/pick-folder' && req.method === 'POST') {
      const pickBody = await readJsonBody(req);
      const desc = String(pickBody.desc || '选择要添加到右侧桌面封票的文件夹').replace(/["`$]/g, '').slice(0, 60);
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
        `$d.Description = "${desc}";`,
        '$d.ShowNewFolderButton = $true;',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::Out.Write($d.SelectedPath) }'
      ].join(' ');
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { timeout: 60000, encoding: 'utf8' }, (err, stdout) => {
        const picked = (stdout || '').trim();
        return sendJson(res, 200, {
          ok: !err && !!picked,
          path: picked,
          name: picked ? path.basename(picked) || picked : ''
        });
      });
      return;
    }

    if (p === '/api/fs/pick-image' && req.method === 'POST') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$d = New-Object System.Windows.Forms.OpenFileDialog;',
        '$d.Title = "选择自定义封票图片";',
        '$d.Filter = "图片文件 (*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp)|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp|所有文件 (*.*)|*.*";',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::Out.Write($d.FileName) }'
      ].join(' ');
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { timeout: 60000, encoding: 'utf8' }, (err, stdout) => {
        const picked = (stdout || '').trim();
        if (err || !picked || !fs.existsSync(picked)) {
          return sendJson(res, 200, { ok: false });
        }
        try {
          fs.mkdirSync(CUSTOM_CARDS_DIR, { recursive: true });
          const ext = path.extname(picked).toLowerCase() || '.png';
          const safeName = `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`;
          const dst = path.join(CUSTOM_CARDS_DIR, safeName);
          fs.copyFileSync(picked, dst);
          return sendJson(res, 200, {
            ok: true,
            card: `custom:${safeName}`,
            file: safeName
          });
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: (e && e.message) || '复制图片失败' });
        }
      });
      return;
    }

    if (p === '/api/sys') {
      const cur = readCpuTimes();
      let cpu = 0;
      if (lastCpuTimes) {
        const dt = cur.total - lastCpuTimes.total;
        const di = cur.idle - lastCpuTimes.idle;
        cpu = dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : 0;
      }
      lastCpuTimes = cur;
      let netName = '';
      let netIp = '';
      try {
        const ifs = os.networkInterfaces();
        for (const name of Object.keys(ifs)) {
          const hit = (ifs[name] || []).find(a => a.family === 'IPv4' && !a.internal);
          if (hit) { netName = name; netIp = hit.address; break; }
        }
      } catch (_) {}
      const total = os.totalmem();
      return sendJson(res, 200, {
        ok: true,
        cpu,
        memUsed: total - os.freemem(),
        memTotal: total,
        uptime: os.uptime(),
        netName,
        netIp
      });
    }

    if (p === '/api/fs/icons' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const list = Array.isArray(body.items) ? body.items.slice(0, 160) : [];
      try {
        const icons = await resolveShellIcons(list);
        return sendJson(res, 200, { ok: true, icons });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: (err && err.message) || '图标提取失败', icons: {} });
      }
    }

    if (p === '/api/fs/icon-file') {
      const key = String(u.searchParams.get('k') || '');
      if (!/^[a-z0-9_.-]{1,64}$/i.test(key)) {
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
        res.end('bad key');
        return;
      }
      const full = path.join(ICON_CACHE_DIR, key + '.png');
      if (!fs.existsSync(full)) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=604800'
      });
      fs.createReadStream(full).pipe(res);
      return;
    }

    if (p === '/api/fs/custom-card') {
      const file = path.basename(String(u.searchParams.get('file') || ''));
      if (!file) {
        res.writeHead(400);
        res.end('missing file');
        return;
      }
      const full = path.join(CUSTOM_CARDS_DIR, file);
      if (!fs.existsSync(full)) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp'
      };
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': mimeMap[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400'
      });
      fs.createReadStream(full).pipe(res);
      return;
    }

    // ===== 导入其他壁纸 =====
    if (p === '/api/wp/list') {
      return sendJson(res, 200, { ok: true, items: importedWallpapers.map(publicImportedItem) });
    }

    if (p === '/api/wp/import-progress') {
      return sendJson(res, 200, { ok: true, active: importProgress.active, percent: importProgress.percent, message: importProgress.message });
    }

    if (p === '/api/wp/pick-local' && req.method === 'POST') {
      setImportProgress(true, 0, '等待选择文件...');
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$d = New-Object System.Windows.Forms.OpenFileDialog;',
        '$d.Multiselect = $true;',
        '$d.Title = "选择要导入的图片或视频壁纸（支持多选）";',
        '$d.Filter = "图片或视频 (*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.mp4;*.webm;*.mov;*.mkv;*.avi;*.m4v;*.gif)|*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.mp4;*.webm;*.mov;*.mkv;*.avi;*.m4v;*.gif|静态图片 (*.png;*.jpg;*.jpeg;*.webp;*.bmp)|*.png;*.jpg;*.jpeg;*.webp;*.bmp|视频与动图 (*.mp4;*.webm;*.mov;*.mkv;*.avi;*.m4v;*.gif)|*.mp4;*.webm;*.mov;*.mkv;*.avi;*.m4v;*.gif|所有文件 (*.*)|*.*";',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::Out.Write(($d.FileNames -join "`n")) }'
      ].join(' ');
      try {
        const picked = await new Promise((resolve) => {
          execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { timeout: 120000, encoding: 'utf8' }, (err, stdout) => {
            resolve({ err, out: stdout || '' });
          });
        });
        const files = String(picked.out || '').split(/\r?\n/).map(s => s.trim()).filter(f => f && fs.existsSync(f));
        if (picked.err || !files.length) return sendJson(res, 200, { ok: false, error: '未选择文件' });
        const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];
        const videoExts = ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.gif'];
        const validFiles = files.filter(f => {
          const ext = path.extname(f).toLowerCase();
          return imageExts.includes(ext) || videoExts.includes(ext);
        });
        if (!validFiles.length) {
          return sendJson(res, 200, { ok: false, error: '仅支持 png/jpg/webp/bmp 图片，或 mp4/webm/mov/mkv/avi/m4v/gif 视频动图' });
        }
        const items = [];
        const errors = [];
        let reusedCount = 0;
        const total = validFiles.length;
        for (let i = 0; i < total; i++) {
          const file = validFiles[i];
          const ext = path.extname(file).toLowerCase();
          const kind = videoExts.includes(ext) ? 'video' : 'image';
          const basePct = (i / total) * 100;
          const spanPct = 100 / total;
          const prefix = total > 1 ? `[${i + 1}/${total}] ` : '';
          try {
            const id = importedIdFor(file);
            const old = importedById.get(id);
            if (old && fs.existsSync(resolveImportFile(old.path))) {
              items.push(publicImportedItem(old));
              reusedCount++;
              continue;
            }
            if (old) {
              importedWallpapers = importedWallpapers.filter(e => e.id !== id);
              importedById.delete(id);
              saveImportedWallpapers();
            }
            const title = path.basename(file, ext);
            if (kind === 'video') {
              setImportProgress(true, basePct + 1, `${prefix}准备处理视频: ${title}`);
              const mat = await materializeVideo(file, id, basePct, spanPct);
              const item = addImportedWallpaper({
                id, title, kind: 'video', path: mat.relativePath, fallbackPath: '', sourcePath: file,
                source: 'local', codec: mat.codec, playable: true, thumb: mat.thumb
              });
              items.push(item);
            } else {
              setImportProgress(true, basePct + spanPct * 0.4, `${prefix}正在导入图片: ${title}`);
              const rel = copyImageToImports(file, id);
              const item = addImportedWallpaper({
                id, title, kind: 'image', path: rel, sourcePath: file, source: 'local', previewPath: ''
              });
              items.push(item);
            }
          } catch (itemErr) {
            errors.push(`${path.basename(file)}: ${(itemErr && itemErr.message) || '失败'}`);
          }
        }
        if (!items.length) {
          return sendJson(res, 200, { ok: false, error: errors[0] || '导入失败' });
        }
        return sendJson(res, 200, {
          ok: true,
          item: items[0],
          items,
          count: items.length,
          reused: reusedCount === items.length,
          errors
        });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: (e && e.message) || '导入失败' });
      } finally {
        setImportProgress(false, 100, '');
      }
    }

    if (p === '/api/wp/we-list') {
      const result = scanWeWallpapers();
      return sendJson(res, 200, result);
    }

    if (p === '/api/wp/import-we' && req.method === 'POST') {
      setImportProgress(true, 0, '正在准备导入...');
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      let info = weScanCache.get(id);
      if (!info) {
        const scan = scanWeWallpapers();
        if (!scan.ok) { setImportProgress(false, 0, ''); return sendJson(res, 200, { ok: false, error: scan.error || '扫描失败' }); }
        info = weScanCache.get(id);
      }
      if (!info) { setImportProgress(false, 0, ''); return sendJson(res, 200, { ok: false, error: '壁纸已失效，请刷新列表' }); }
      try {
        if (info.videoPath) {
          const impId = importedIdFor(info.videoPath);
          const old = importedById.get(impId);
          if (old && fs.existsSync(resolveImportFile(old.path))) {
            return sendJson(res, 200, { ok: true, item: publicImportedItem(old), staticOnly: false, weType: 'video', reused: true });
          }
          if (old) {
            importedWallpapers = importedWallpapers.filter(e => e.id !== impId);
            importedById.delete(impId);
            saveImportedWallpapers();
          }
          const mat = await materializeVideo(info.videoPath, impId);
          const preview = info.previewPath ? copyPreviewToImports(info.previewPath, impId) : '';
          const item = addImportedWallpaper({
            id: impId, title: info.title, kind: 'video', path: mat.relativePath, fallbackPath: '',
            previewPath: preview, thumb: mat.thumb, sourcePath: info.videoPath,
            source: 'we', weType: 'video', codec: mat.codec, playable: true
          });
          return sendJson(res, 200, { ok: true, item, staticOnly: false, weType: 'video' });
        }
        if (info.previewPath) {
          const impId = importedIdFor(info.previewPath);
          const old = importedById.get(impId);
          if (old && fs.existsSync(resolveImportFile(old.path))) {
            return sendJson(res, 200, { ok: true, item: publicImportedItem(old), staticOnly: true, weType: info.weType || '', reused: true });
          }
          if (old) {
            importedWallpapers = importedWallpapers.filter(e => e.id !== impId);
            importedById.delete(impId);
            saveImportedWallpapers();
          }
          const rel = copyImageToImports(info.previewPath, impId);
          const item = addImportedWallpaper({
            id: impId, title: info.title, kind: 'image', path: rel, previewPath: rel,
            sourcePath: info.previewPath, source: 'we', weType: info.weType || 'scene'
          });
          return sendJson(res, 200, { ok: true, item, staticOnly: true, weType: info.weType || '' });
        }
        return sendJson(res, 200, { ok: false, error: '该壁纸没有可导入的视频或预览图' });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: (e && e.message) || '导入失败' });
      } finally {
        setImportProgress(false, 100, '');
      }
    }

    if (p === '/api/wp/we-record' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      let info = weScanCache.get(id);
      if (!info) {
        const scan = scanWeWallpapers();
        if (!scan.ok) return sendJson(res, 200, { ok: false, error: scan.error || '扫描失败' });
        info = weScanCache.get(id);
      }
      if (!info) return sendJson(res, 200, { ok: false, error: '壁纸已失效，请刷新列表' });
      if (info.weType !== 'scene' || !info.projectFile) {
        return sendJson(res, 200, { ok: false, error: '这张壁纸不需要录制，可直接导入视频或封面' });
      }
      try {
        const result = await recordWeScene(info, body.duration, body.resolution, body.loopMode);
        return sendJson(res, 200, { ok: true, item: result.item, reused: !!result.reused, recorded: !result.reused, weType: 'scene' });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: (e && e.message) || '自动录制失败' });
      } finally {
        setImportProgress(false, 100, '');
      }
    }

    if (p === '/api/wp/remove' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      const entry = importedById.get(id);
      if (!entry) return sendJson(res, 200, { ok: true, removed: false });
      importedWallpapers = importedWallpapers.filter(e => e.id !== id);
      importedById.delete(id);
      if (entry.thumb && /^[a-z0-9_.-]+$/i.test(entry.thumb) && path.basename(entry.thumb) === entry.thumb) {
        try { fs.unlinkSync(path.join(IMPORTED_THUMB_DIR, entry.thumb)); } catch (_) {}
      }
      for (const p of [entry.path, entry.previewPath, entry.fallbackPath]) {
        if (p && isManagedImportFile(p)) {
          try { fs.unlinkSync(resolveImportFile(p)); } catch (_) {}
        }
      }
      saveImportedWallpapers();
      return sendJson(res, 200, { ok: true, removed: true });
    }

    if (p === '/api/wp/thumb' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      const entry = importedById.get(id);
      if (!entry) return sendJson(res, 200, { ok: false, error: '壁纸不存在' });
      const m = String(body.data || '').match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) return sendJson(res, 200, { ok: false, error: '缩略图格式不支持' });
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length || buf.length > 3 * 1024 * 1024) return sendJson(res, 200, { ok: false, error: '缩略图过大' });
      try {
        fs.mkdirSync(IMPORTED_THUMB_DIR, { recursive: true });
        const ext = m[1] === 'png' ? '.png' : '.jpg';
        const filename = entry.id + ext;
        fs.writeFileSync(path.join(IMPORTED_THUMB_DIR, filename), buf);
        if (entry.thumb && entry.thumb !== filename) {
          try { fs.unlinkSync(path.join(IMPORTED_THUMB_DIR, entry.thumb)); } catch (_) {}
        }
        entry.thumb = filename;
        saveImportedWallpapers();
        return sendJson(res, 200, { ok: true, thumb: filename });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: (e && e.message) || '保存缩略图失败' });
      }
    }

    if (p === '/api/wp/rename' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      const title = String(body.title || '').trim().slice(0, 60);
      const entry = importedById.get(id);
      if (!entry) return sendJson(res, 200, { ok: false, error: '壁纸不存在' });
      if (!title) return sendJson(res, 200, { ok: false, error: '名称不能为空' });
      entry.title = title;
      saveImportedWallpapers();
      return sendJson(res, 200, { ok: true, item: publicImportedItem(entry) });
    }

    if (p === '/api/wp/meta' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      const entry = importedById.get(id);
      if (!entry) return sendJson(res, 200, { ok: false, error: '壁纸不存在' });
      const w = Number(body.width), h = Number(body.height), d = Number(body.duration);
      if (isFinite(w) && w > 0) entry.width = Math.round(w);
      if (isFinite(h) && h > 0) entry.height = Math.round(h);
      if (isFinite(d) && d > 0) entry.duration = Math.round(d);
      saveImportedWallpapers();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/wp/crop' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      const entry = importedById.get(id);
      if (!entry) return sendJson(res, 200, { ok: false, error: '壁纸不存在' });
      const norm = body.reset ? null : normalizeCrop(body.crop || body);
      entry.crop = norm;
      saveImportedWallpapers();
      return sendJson(res, 200, { ok: true, item: publicImportedItem(entry) });
    }

    if (p === '/api/wp/we-thumb') {
      const id = String(u.searchParams.get('id') || '');
      let info = weScanCache.get(id);
      if (!info) {
        const scan = scanWeWallpapers();
        if (scan.ok) info = weScanCache.get(id);
      }
      if (!info || !info.previewPath || !fs.existsSync(info.previewPath)) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('Not found');
        return;
      }
      return serveLocalFile(req, res, info.previewPath, 3600);
    }

    if (p === '/api/wp/media' || p === '/api/wp/thumb') {
      const id = String(u.searchParams.get('id') || '');
      const entry = importedById.get(id);
      if (!entry) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('Not found');
        return;
      }
      if (p === '/api/wp/media') {
        const useFb = String(u.searchParams.get('fb') || '') === '1';
        const mediaPath = useFb && entry.fallbackPath ? resolveImportFile(entry.fallbackPath) : resolveImportFile(entry.path);
        return serveLocalFile(req, res, mediaPath, 0);
      }
      let thumbPath = '';
      if (entry.thumb && /^[a-z0-9_.-]+$/i.test(entry.thumb) && path.basename(entry.thumb) === entry.thumb) {
        const p1 = path.join(IMPORTED_THUMB_DIR, entry.thumb);
        if (fs.existsSync(p1)) thumbPath = p1;
      }
      const previewAbs = resolveImportFile(entry.previewPath);
      if (!thumbPath && previewAbs && fs.existsSync(previewAbs)) thumbPath = previewAbs;
      const imageAbs = resolveImportFile(entry.path);
      if (!thumbPath && entry.kind === 'image' && fs.existsSync(imageAbs)) thumbPath = imageAbs;
      if (!thumbPath) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('Not found');
        return;
      }
      return serveLocalFile(req, res, thumbPath, 3600);
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: (err && err.message) || 'Server error' });
  }
});

// CEF 会复用同一条本地连接边播边拉；默认 5 秒空闲就关会让续传反复重新握手。
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;
server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch (_) {}
});
server.on('error', (err) => {
  console.error('[Nientum NeteaseBridge] server error:', err && err.message);
});

server.listen(PORT, HOST, () => {
  console.log(`[Nientum NeteaseBridge] listening at http://${HOST}:${PORT}`);
  console.log(`[Nientum NeteaseBridge] dataDir=${DATA_DIR}`);
  console.log(`[Nientum NeteaseBridge] audioCache=${AUDIO_CACHE_DIR} (max ${Math.round(AUDIO_CACHE_MAX_BYTES / 1048576)} MB)`);
  try { pruneAudioCache(); } catch (_) {}
  // 生成/刷新 xeapi 公钥，高清臻音/超清母带/沉浸环绕声需要它；失败时自动回落到基础档位
  try {
    const generateConfig = require('@neteasecloudmusicapienhanced/api/generateConfig');
    generateConfig()
      .then(() => console.log('[Nientum NeteaseBridge] xeapi key ready'))
      .catch((e) => console.warn('[Nientum NeteaseBridge] xeapi key error:', e && e.message));
  } catch (e) {
    console.warn('[Nientum NeteaseBridge] xeapi config unavailable:', e && e.message);
  }
});
