# Nientum Wallpaper — Interactive Desktop

A Wallpaper Engine web wallpaper for **Nientum - Op.ZERO**: CG gallery, theater-style music player, and Netease Cloud Music streaming, with a local bridge for mouse-wheel switching, a quick folder drawer, and desktop icon integration.

This repository contains source code only. Game CG, character art, music, and Spine assets are **not** included; the game content is copyright QueseraGames.

## Layout

- `web/` — Wallpaper Engine web project (`project.json`, `index.html`, `css/`, `js/`, `vendor/`)
- `netease-bridge/` — local Netease Cloud Music proxy (Node.js, `127.0.0.1:17988`)
- `bridge/` — unified C# bridge: global mouse-wheel hook + embedded Node/proxy (`NientumBridge.exe`)
- `installer/` — installer scripts used by the release package

## Why a bridge

Wallpaper Engine does not forward mouse-wheel events to web wallpapers, and the page cannot enumerate desktop icons or open folders. The bridge captures the wheel via a low-level hook and injects synthetic mouse events, and exposes local HTTP endpoints for folder listing, icons, and native text input.

## Run the web project

1. Install Wallpaper Engine and open `web/` as a web wallpaper (or copy it into WE's `projects` folder).
2. Provide `assets/` (CG, character art, thumbnails) and `音乐/` (local tracks) next to the project; the expected structure is described in `web/js/data.js`. These assets are not shipped here.
3. Start the Netease proxy if you want online music.

## Netease proxy

Requires Node.js 18+:

```bat
cd netease-bridge
npm install
npm start
```

The proxy listens on `127.0.0.1:17988`. Log in by scanning a QR code on the wallpaper page. The login cookie is stored in `netease-bridge/cookie.json` (git-ignored; never publish it).

Features: search, playlists, daily recommendations, lyrics, quality selection, likes (`/api/liked`, `/api/song/like`), streaming with Range and resume, local audio cache, and `/api/ping` health check (`bridgeVer=4`).

Bundle the proxy into a single file for embedding into the exe:

```bat
npm install
npm run bundle
```

Output goes to `netease-bridge/payload/`. Gzip those files and embed them with the `csc` command documented at the top of `bridge/NientumBridge.cs`. `node.exe` is not shipped; supply your own Node 18+ binary.

## Build the bridge (optional)

`bridge/NientumBridge.cs` is a single-file C# program that compiles with the .NET Framework `csc.exe` (see the header comment for resource arguments). Command-line flags: `--prepare-runtime`, `--daemon --replace`, `--proxy-selftest`.

## Release

`NientumWallpaper_20261123_no-login.zip`: web project + bridge + ffmpeg + game CG assets. No Netease login, no personal imports, no local music. Run `一键安装壁纸.bat`.

## Third-party components

- `web/vendor/spine-webgl.js` — Esoteric Software Spine WebGL runtime, see `spine-webgl-LICENSE.txt`.
- `netease-bridge` depends on [@neteasecloudmusicapienhanced/api](https://www.npmjs.com/package/@neteasecloudmusicapienhanced/api) under its own license.
- The Netease Cloud Music API is for personal study only; follow Netease's terms of service.

## Copyright and takedown

This is a fan-made, unofficial project and is not affiliated with the developers or publishers of Nientum - Op.ZERO. All game content (CG, character art, music, fonts, script text) is copyright QueseraGames. Release packages are for personal, non-commercial study and sharing only. If a rights holder believes a release infringes their rights, please open an Issue in this repository and the material will be removed promptly.

## License

MIT for the code, see [LICENSE](LICENSE). Game assets and third-party components keep their own licenses.