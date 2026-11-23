# Nientum Wallpaper 交互桌面

《Nientum - Op.ZERO》主题的 Wallpaper Engine 网页壁纸：CG 画廊 + 剧场式音乐播放器 + 网易云在线音乐，配合本地桥接器实现滚轮切换、快捷抽屉和桌面图标联动。

本仓库只包含代码。游戏 CG、立绘、音乐、Spine 素材均不包含（`assets/`、`音乐/` 需自备）；游戏内容版权归 QueseraGames 所有。

## 目录

- `web/` — Wallpaper Engine 网页工程（`project.json` + `index.html` + `css/` + `js/` + `vendor/`）
- `netease-bridge/` — 本机网易云代理（Node.js，`127.0.0.1:17988`）
- `bridge/` — 统一桥接器 C# 源码（全局滚轮钩子 + 内嵌 node/proxy，编译成 `NientumBridge.exe`）
- `installer/` — 发布包使用的安装脚本（`installer.ps1` + 三个 bat + 使用说明）

## 为什么需要桥接器

Wallpaper Engine 的桌面层不把鼠标滚轮事件转发给网页，网页也拿不到桌面图标/文件夹信息。桥接器用全局低级鼠标钩子把滚轮编码成“带右键状态的合成 mousemove”送进页面，并通过本地 HTTP 提供文件夹列表、图标、原生输入焦点等能力。页面端约定写在 `bridge/NientumBridge.cs` 头部注释里。

## 运行网页工程

1. 安装 Wallpaper Engine，把 `web/` 作为网页类型项目打开（或把整个目录放进 WE 的 `projects` 目录）。
2. 项目根目录需要有 `assets/`（CG/立绘/缩略图）与 `音乐/`（本地曲目），格式参照 `web/js/data.js` 里的条目结构；本仓库不附带这些素材。
3. 需要网易云在线音乐时，先启动代理（见下）。

## 网易云代理

需要 Node.js 18+：

```bat
cd netease-bridge
npm install
npm start
```

代理监听 `127.0.0.1:17988`，首次使用在壁纸页面扫码登录；登录态保存在 `netease-bridge/cookie.json`（已在 `.gitignore` 中，切勿提交或外发）。

功能包含：搜索、歌单、每日推荐、歌词、音质解析、收藏（`/api/liked`、`/api/song/like`）、音频流 Range/断点续传/本地缓存，以及 `/api/ping` 健康检查（`bridgeVer=4`）。

把代理打包成单文件（供 exe 内嵌）：

```bat
npm install
npm run bundle
```

产物在 `netease-bridge/payload/`，压缩成 `.gz` 后按 `bridge/NientumBridge.cs` 头部的 `csc` 命令嵌入 exe。`node.exe` 不随仓库分发，请自行准备 Node 18+ 的 `node.exe`。

## 编译桥接器（可选）

`bridge/NientumBridge.cs` 是单文件 C#（.NET Framework 4.x 自带 `csc.exe` 即可编译）：

```bat
csc.exe -platform:x64 -target:winexe -out:NientumBridge.exe ^
  -resource:payload/node.exe.gz,payload.node.gz ^
  -resource:payload/proxy/server.js.gz,payload.server.js.gz ^
  -resource:payload/proxy/we_record_window.ps1,payload.we_record_window.ps1 ^
  -resource:payload/data/china_ip_ranges.txt,payload.china_ip_ranges.txt ^
  bridge\NientumBridge.cs
```

运行参数：`--prepare-runtime` 解压内核，`--daemon --replace` 启动守护进程，`--proxy-selftest` 自检。

## 第三方

- `web/vendor/spine-webgl.js`：Esoteric Software Spine WebGL runtime，许可见 `spine-webgl-LICENSE.txt`。
- `netease-bridge` 依赖 [@neteasecloudmusicapienhanced/api](https://www.npmjs.com/package/@neteasecloudmusicapienhanced/api)，遵循其自身许可。
- 网易云音乐接口仅供个人学习使用，请遵守网易云音乐服务条款，不要用于商业分发。

## 已知限制

- 网页壁纸必须运行在 Wallpaper Engine 中；直接用浏览器打开只能看到降级界面。
- 网页内核（CEF）不支持 HEVC/H.265 视频导入，需转 H.264/VP9/AV1。
- 没有附带素材时页面会显示空画廊；`data.js` 里的曲目/CG 条目需要与 `assets/` 实际文件对应。
- 桥接器只针对 Windows x64。

## 发布包

Release 提供 `NientumWallpaper_20261123_无登录.zip`：网页工程 + `NientumBridge.exe` + ffmpeg + 游戏 CG 素材。不含网易云登录、个人导入、缓存与音乐；解压后运行 `一键安装壁纸.bat`。

## 版权与下架声明

本项目为非官方玩家工具，与《Nientum - Op.ZERO》的开发商、发行商无隶属关系。游戏及其 CG、立绘、音乐、字体、剧本等素材版权归 QueseraGames 所有；发布包中的素材仅限个人学习交流，禁止商用、二次售卖或冒充官方。如权利人认为侵权，请通过本仓库 Issue 联系，核实后立即下架相关源码与发布物。

## 许可

代码以 MIT 许可发布，见 [LICENSE](LICENSE)。游戏素材与第三方组件不在 MIT 许可范围内，分别遵循各自版权与许可。