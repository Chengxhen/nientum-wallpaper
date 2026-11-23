(function () {
  'use strict';

  const DATA = window.NIENTUM_DATA || { chapters: [], tracks: [], wallpapers: [] };
  const STORAGE_KEY = 'nientum_wallpaper_v4';
  const BASE_WALLPAPERS = DATA.wallpapers.slice();
  let importedWallpapers = [];
  let wpRemoveArm = { id: '', time: 0 };

  const state = {
    uiMode: 'capsule',       // capsule | pure | theater
    chapter: 'ALL',
    trackIndex: 0,
    defaultTrackIndex: null,
    playing: false,
    loopMode: 'list',        // list | single | shuffle | order
    volume: 0.75,
    autoSyncCg: false,
    wpCat: 'all',
    wallpaperId: 'l2d_actT',
    particles: 0.8,
    resScale: 1.0,
    fpsLimit: 60,
    spineSpeed: 1.0,         // Spine 动画播放速度倍率（设置中 20%~200%）
    uiOpacity: 0.96,
    footlights: true,
    halo: true,
    ncmLevel: 'exhigh',      // standard | higher | exhigh | lossless | hires
    ncmCoverToCard: false,
    localCoverToCard: false,
    ncmLyricEnabled: true,
    lyricScale: 1,           // 桌面歌词字号倍率（设置中 70%~160%）
    dockEnabled: true,
    dockMotion: 'soft',      // snappy | normal | soft | silk
    capsuleCollapsed: false,
    capsuleAutoCollapseSec: 30,
    capsuleExpandMode: 'hover', // hover | click
    defocusBlur: true,
    vizGain: 1,              // 音频律动强度倍率（设置中 30%~200%）
    cardGlass: false,        // 卡片模式玻璃材质
    cardTilt: 1,             // 卡片悬停倾斜强弱倍率（设置中 0%~500%，1=默认 0.4°）
    uiGlass: true,           // 选曲界面与弹窗玻璃材质
    fontWaveEnabled: false,  // 全局字体水波渐变配色（右上金→左下自定义）
    fontWaveColor: '#6ec6ff',
    showSideClock: true,
    showSideDrawer: true,
    wpCrops: {}
  };

  let audio = null;
  let audioCtx = null;
  let analyser = null;
  let freqData = null;
  let fadeTimer = null;
  let arcRaf = 0;
  let audioError = '';
  let autoAdvancing = false;
  let autoSkipCount = 0;
  let autoSkipTimer = 0;
  let autoEndedGuard = false;
  let ncmLastTime = -1;
  let ncmLastProgressAt = 0;
  let ncmLastBufferedEnd = 0;
  let ncmStallRetryCount = 0;
  let ncmStallRecovering = false;
  let ncmReconnectCount = 0;
  let ncmReconnectTimer = 0;
  let ncmLastKnownTime = 0;
  let ncmActiveLevel = '';
  let ncmLyricSongId = '';
  let ncmLyricLines = [];
  let ncmLyricActiveIdx = -2;
  let selectedIndex = 0;
  let playScopeChapter = 'ALL';
  let shuffleHistory = [];
  let progressDrag = { active: false, ratio: 0 };
  let blockCapsuleOpenUntil = 0;
  let autoplayUnlockBound = false;
  let selectionLocked = false;
  let lastCardClick = { idx: -1, time: 0 };
  let lastDblPlayAt = 0;
  const vizBins = new Float32Array(64);
  const vizParticles = Array.from({ length: 42 }, () => ({
    x: Math.random(),
    y: 0.45 + Math.random() * 0.55,
    spd: 4 + Math.random() * 12,
    r: [1, 1, 2, 2, 3][Math.floor(Math.random() * 5)],
    alpha: (20 + Math.random() * 70) / 255,
    ph: Math.random() * 6.28
  }));
  let glowSpriteCanvas = null;
  let weAudioData = null;
  let weAudioAt = 0;
  let weEnergySmooth = 0;
  let hasSavedSettings = false;
  let lastWeProps = null;
  const NCM_BASE = 'http://127.0.0.1:17988';
  const NCM_LEVELS = ['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jyeffect', 'jymaster', 'sky'];
  const NCM_LEVEL_LABEL = { standard: '标准', higher: '较高', exhigh: '极高', lossless: '无损', hires: 'Hi-Res', jyeffect: '高清臻音', jymaster: '超清母带', sky: '沉浸环绕声' };
  let ncmPendingSeek = 0;
  let ncmRetryTimer = 0;
  let ncmRetryCount = 0;
  let activeSource = 'local'; // 'local' | 'ncm'
  let ncmViewTracks = [];
  let ncmPlayQueue = [];
  let ncmPlayIndex = -1;
  let ncmPlaylists = [];
  let ncmActivePlaylistId = null;
  let ncmSelectedTrackId = null;
  let ncmCenterRaf = 0;
  let ncmCenterTimer = 0;
  let ncmScrollPos = 0;
  let ncmScrollTarget = 0;
  let ncmScrollRaf = 0;
  let ncmShuffleHistory = [];
  let ncmQrKey = '';
  let ncmQrTimer = 0;
  let ncmConnected = false;
  let ncmLoggedIn = false;
  let ncmLikedIds = new Set();
  let ncmLikedAt = 0;
  let ncmLikeBusy = false;
  let ncmLikeStatusTimer = 0;
  let lastPointerX = 960;
  let bridgeFocusActive = false;
  let nativeInputBridgeReady = false;
  let lastNativeInputFocus = { field: '', t: 0 };
  let detectedMusicPrefix = '';
  let localAudioRetryState = null;
  const MUSIC_PREFIXES = ['音乐/', 'media/音乐/', 'assets/音乐/', 'assets/music/'];

  function resolveMusicCandidates(rawSrc) {
    const clean = String(rawSrc || '').replace(/\\/g, '/');
    const m = /^(?:assets\/music\/|assets\/音乐\/|media\/音乐\/|音乐\/)(.+)$/i.exec(clean);
    if (!m) return [clean];
    const rel = m[1];
    const list = [];
    if (detectedMusicPrefix) list.push(detectedMusicPrefix + rel);
    for (let i = 0; i < MUSIC_PREFIXES.length; i++) {
      const cand = MUSIC_PREFIXES[i] + rel;
      if (!list.includes(cand)) list.push(cand);
    }
    return list;
  }

  const LOOP_ORDER = ['list', 'single', 'shuffle', 'order'];
  const NCM_LOOP_ORDER = LOOP_ORDER.concat('daily');
  const LOOP_META = {
    list: {
      label: '列表循环',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>'
    },
    single: {
      label: '单曲循环',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11.2 10.2L12.5 9v6" stroke-width="2"/></svg>'
    },
    shuffle: {
      label: '下一首随机',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>'
    },
    order: {
      label: '顺序播放',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h12"/><path d="M4 12h12"/><path d="M4 17h8"/><path d="M16 14l4 3-4 3"/></svg>'
    },
    daily: {
      label: '每日推荐',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="M12 13l1 2 2 .3-1.5 1.5.4 2.2-1.9-1-1.9 1 .4-2.2L9 15.3l2-.3z"/></svg>'
    }
  };

  // 对齐 Plugin.cs LayoutMusicCards：纯状态驱动滚动，不依赖原生 scrollTop，确保 WE 中 100% 可滚轮滑动
  const ROW_STRIDE = 98;
  const TOP_PAD = 96;
  let visibleRows = [];
  let scrollPos = 0;
  let wheelTarget = 0;
  let wheelRaf = 0;

  const _elCache = Object.create(null);
  const $ = (id) => _elCache[id] || (_elCache[id] = document.getElementById(id));

  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      hasSavedSettings = true;
      const hasVizPref = saved.__vizV === 2;
      Object.assign(state, saved);
      // 旧版本没有音频可视化开关记录，首次升级默认开启
      if (!hasVizPref) {
        state.footlights = true;
        state.halo = true;
      }
      if (!state.wpCrops || typeof state.wpCrops !== 'object') state.wpCrops = {};
      state.__vizV = 2;
    } catch (_) {}
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        uiMode: state.uiMode === 'theater' ? 'capsule' : state.uiMode,
        chapter: state.chapter,
        trackIndex: state.trackIndex,
        defaultTrackIndex: state.defaultTrackIndex,
        loopMode: state.loopMode,
        volume: state.volume,
        autoSyncCg: state.autoSyncCg,
        wpCat: state.wpCat,
        wallpaperId: state.wallpaperId,
        particles: state.particles,
        resScale: state.resScale,
        fpsLimit: state.fpsLimit,
        spineSpeed: Number.isFinite(Number(state.spineSpeed)) ? Math.max(0.2, Math.min(2, Number(state.spineSpeed))) : 1,
        ncmLevel: state.ncmLevel,
        ncmCoverToCard: !!state.ncmCoverToCard,
        ncmLyricEnabled: state.ncmLyricEnabled !== false,
        lyricScale: Number(state.lyricScale) || 1,
        dockEnabled: state.dockEnabled !== false,
        dockMotion: state.dockMotion || 'soft',
        capsuleCollapsed: !!state.capsuleCollapsed,
        capsuleAutoCollapseSec: Number.isFinite(Number(state.capsuleAutoCollapseSec)) ? Number(state.capsuleAutoCollapseSec) : 30,
        capsuleExpandMode: state.capsuleExpandMode === 'click' ? 'click' : 'hover',
        defocusBlur: state.defocusBlur !== false,
        vizGain: Number(state.vizGain) || 1,
        cardGlass: !!state.cardGlass,
        cardTilt: Number.isFinite(Number(state.cardTilt)) ? Math.max(0, Math.min(5, Number(state.cardTilt))) : 1,
        uiGlass: state.uiGlass !== false,
        fontWaveEnabled: !!state.fontWaveEnabled,
        fontWaveColor: /^#[0-9a-f]{6}$/i.test(String(state.fontWaveColor || '')) ? String(state.fontWaveColor) : '#6ec6ff',
        showSideClock: state.showSideClock !== false,
        showSideDrawer: state.showSideDrawer !== false,
        uiOpacity: state.uiOpacity,
        footlights: state.footlights,
        halo: state.halo,
        wpCrops: state.wpCrops || {},
        __vizV: 2
      }));
    } catch (_) {}
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // 使用 Chromium 原生 zoom 等比缩放 1920 基准舞台（不产生巨型离屏合成纹理，彻底避免丢块）
  function updateCanvasScale() {
    const shell = $('theater-shell');
    if (!shell) return;
    const scale = window.innerWidth / 1920;
    const vh = window.innerHeight / Math.max(scale, 0.01);
    shell.style.width = '1920px';
    shell.style.height = vh.toFixed(1) + 'px';
    shell.style.zoom = scale.toFixed(6);
    scheduleArcLayout();
  }

  let capsuleHovered = false;
  let capsuleHoverExpanded = false;
  let capsuleAutoTimer = 0;
  let capsuleLeaveTimer = 0;
  let ignoreCapsuleLeaveUntil = 0;

  let capAnimTimer = 0;
  function syncCapsuleVisualState() {
    const visuallyCollapsed = !!state.capsuleCollapsed && !capsuleHoverExpanded;
    const dock = $('capsule-dock');
    if (dock) {
      const was = dock.classList.contains('collapsed');
      if (was !== visuallyCollapsed) {
        // 动画期间临时关闭毛玻璃，保证展开/收起过渡流畅
        dock.classList.add('cap-anim');
        if (capAnimTimer) clearTimeout(capAnimTimer);
        capAnimTimer = setTimeout(() => {
          capAnimTimer = 0;
          dock.classList.remove('cap-anim');
        }, 520);
      }
      dock.classList.toggle('collapsed', visuallyCollapsed);
    }
    const disc = $('cap-disc');
    if (disc) {
      disc.title = visuallyCollapsed
        ? (state.capsuleExpandMode === 'click' ? '点击展开音乐胶囊' : '悬停展开音乐胶囊')
        : '点击展开自由选曲';
    }
  }

  function clearCapsuleTimers() {
    if (capsuleAutoTimer) { clearTimeout(capsuleAutoTimer); capsuleAutoTimer = 0; }
    if (capsuleLeaveTimer) { clearTimeout(capsuleLeaveTimer); capsuleLeaveTimer = 0; }
  }

  function scheduleCapsuleAutoCollapse() {
    if (capsuleAutoTimer) { clearTimeout(capsuleAutoTimer); capsuleAutoTimer = 0; }
    const sec = Number.isFinite(Number(state.capsuleAutoCollapseSec)) ? Number(state.capsuleAutoCollapseSec) : 30;
    if (sec <= 0 || state.capsuleCollapsed || capsuleHovered || progressDrag.active) return;
    if (state.uiMode !== 'capsule' || document.body.classList.contains('desktop-card-mode')) return;
    capsuleAutoTimer = setTimeout(() => {
      capsuleAutoTimer = 0;
      if (!state.capsuleCollapsed && !capsuleHovered && !progressDrag.active &&
          state.uiMode === 'capsule' && !document.body.classList.contains('desktop-card-mode')) {
        setCapsuleCollapsed(true, true);
      }
    }, sec * 1000);
  }

  function setCapsuleCollapsed(collapsed, persist) {
    state.capsuleCollapsed = !!collapsed;
    if (state.capsuleCollapsed) {
      capsuleHoverExpanded = false;
      if (capsuleAutoTimer) { clearTimeout(capsuleAutoTimer); capsuleAutoTimer = 0; }
    }
    syncCapsuleVisualState();
    if (!state.capsuleCollapsed) scheduleCapsuleAutoCollapse();
    if (persist) saveState();
  }

  function setUiMode(mode, withMorph) {
    if (mode === 'pure') mode = 'capsule';
    const capBar = document.querySelector('.capsule-bar');
    const fromRect = (mode === 'theater' && withMorph && capBar) ? capBar.getBoundingClientRect() : null;

    state.uiMode = mode;
    document.body.classList.remove('mode-capsule', 'mode-pure', 'mode-theater');
    document.body.classList.add('mode-' + mode);
    $('theater-overlay').setAttribute('aria-hidden', mode === 'theater' ? 'false' : 'true');
    // 不暂停桌面舞台：CEF 会回收不可见 4K 图层纹理，切回桌面时出现矩形缺口。
    // 剧场模式改为在 stage 上叠模糊滤镜（见 CSS），舞台始终继续渲染。
    if (mode === 'theater') {
      updateCanvasScale();
      focusPlayingTrackInList(false);

      // 从左上角播放栏平滑放大飞跃到右侧唱片下方成为「当前曲目」
      const nowBar = document.querySelector('.theater-view.active .now-bar') || document.querySelector('.now-bar');
      if (fromRect && fromRect.width > 10 && nowBar) {
        nowBar.classList.remove('morphing');
        nowBar.style.transform = 'none';
        const toRect = nowBar.getBoundingClientRect();
        const scale = window.innerWidth / 1920 || 1;
        if (toRect.width > 10) {
          const dx = (fromRect.left - toRect.left) / scale;
          const dy = (fromRect.top - toRect.top) / scale;
          const sx = fromRect.width / toRect.width;
          const sy = fromRect.height / toRect.height;
          nowBar.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
          nowBar.style.opacity = '0.68';
          nowBar.getBoundingClientRect();
          requestAnimationFrame(() => {
            nowBar.classList.add('morphing');
            nowBar.style.transform = 'translate3d(0, 0, 0) scale(1, 1)';
            nowBar.style.opacity = '1';
          });
        }
      }

      requestAnimationFrame(() => {
        updateCanvasScale();
        centerSelectedCard(false);
        layoutArcCards(false);
        centerActiveChapterPill(false);
      });
    }
    saveState();
    notifyUiMode(mode);
    if (mode === 'theater') {
      clearCapsuleTimers();
      capsuleHovered = false;
      capsuleHoverExpanded = false;
      document.body.classList.remove('capsule-hover');
      syncCapsuleVisualState();
    } else {
      scheduleCapsuleAutoCollapse();
    }
  }

  function notifyUiMode(mode) {
    let m = (mode === 'theater' || mode === 'pure') ? mode : 'capsule';
    if (m !== 'theater' && document.body.classList.contains('desktop-card-mode')) m = 'card';
    if (m !== 'theater' && (window.__nientumDockHovered || window.__nientumPanelActive)) m = 'theater';
    let drQuery = '';
    if (window.__nientumDrawerRect === 'closed') {
      drQuery = '&drawer=closed';
    } else if (window.__nientumDrawerRect && typeof window.__nientumDrawerRect === 'string') {
      drQuery = '&drawer=open&dr=' + encodeURIComponent(window.__nientumDrawerRect);
    }
    try {
      fetch(`${NCM_BASE}/api/ui-state?mode=${m}${drQuery}&t=${Date.now()}`, { cache: 'no-store' }).catch(() => {});
    } catch (_) {}
  }

  // ===== 失焦背景模糊：失焦 / 悬停胶囊 / 悬停封票架与抽屉与状态栏 → 满 300ms 才添加 bg-defocus（过渡由 CSS 负责） =====
  const DEFOCUS_DELAY_MS = 300;
  const uiHoverKeys = new Set();
  let defocusTimer = 0;

  function wantDefocus() {
    if (state.defocusBlur === false) return false;
    const cl = document.body.classList;
    if (cl.contains('mode-theater') && !cl.contains('unfocused')) return false;
    return cl.contains('unfocused') || cl.contains('capsule-hover') || uiHoverKeys.size > 0;
  }

  function evalDefocus() {
    const cl = document.body.classList;
    if (wantDefocus()) {
      if (!cl.contains('bg-defocus') && !defocusTimer) {
        defocusTimer = setTimeout(() => {
          defocusTimer = 0;
          if (wantDefocus()) document.body.classList.add('bg-defocus');
        }, DEFOCUS_DELAY_MS);
      }
    } else {
      if (defocusTimer) { clearTimeout(defocusTimer); defocusTimer = 0; }
      if (cl.contains('bg-defocus')) cl.remove('bg-defocus');
    }
  }

  window.__nientumBridge = {
    setDockActive(on) {
      window.__nientumDockHovered = !!on;
      notifyUiMode(state.uiMode);
    },
    // 桌面左侧抽屉等需要接收点击的面板：悬停期间临时让桥接器放行点击
    setPanelActive(on) {
      const v = !!on;
      if (window.__nientumPanelActive === v) return;
      window.__nientumPanelActive = v;
      notifyUiMode(state.uiMode);
    },
    setDrawerRect(open, ratios) {
      const next = open && Array.isArray(ratios) && ratios.length === 4
        ? ratios.map(n => Number(n).toFixed(4)).join(',')
        : 'closed';
      if (window.__nientumDrawerRect === next) return;
      window.__nientumDrawerRect = next;
      if (!open) window.__nientumHoverDrawerItem = '';
      notifyUiMode(state.uiMode);
    },
    setHoverDrawerItem(itemPath) {
      const next = String(itemPath || '');
      if (window.__nientumHoverDrawerItem === next) return;
      window.__nientumHoverDrawerItem = next;
      try {
        fetch(`${NCM_BASE}/api/ui-state?hoverItem=${encodeURIComponent(next)}&t=${Date.now()}`, { cache: 'no-store' }).catch(() => {});
      } catch (_) {}
    },
    // 悬停在封票架 / 展开文件夹 / 抽屉 / 状态栏上时按“失焦”处理（背景模糊）
    setUiHover(key, on) {
      const had = uiHoverKeys.has(key);
      if (on && !had) uiHoverKeys.add(key);
      else if (!on && had) uiHoverKeys.delete(key);
      else return;
      evalDefocus();
    },
    getDockSettings() {
      return {
        dockEnabled: state.dockEnabled !== false,
        dockMotion: state.dockMotion || 'soft'
      };
    }
  };

  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(evalDefocus).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // 网页壁纸没有键盘焦点：输入框 focus 时把字段/位置/当前值发给桥接器，
  // 桥接器在同一个位置弹一个原生输入框（可用输入法），确认后写回页面。
  let nativeInputSeq = 0;
  function b64Utf8(s) {
    try { return btoa(unescape(encodeURIComponent(String(s || '')))); } catch (_) { return ''; }
  }
  function notifyInputFocus(on, el) {
    try {
      let field = '', value = '', x = 0, y = 0, w = 0, h = 0;
      if (el) {
        const r = el.getBoundingClientRect();
        field = el.id || '';
        value = b64Utf8(el.value || '');
        x = Math.round(r.left); y = Math.round(r.top);
        w = Math.round(r.width); h = Math.round(r.height);
      }
      const q = `on=${on ? 1 : 0}&field=${encodeURIComponent(field)}&x=${x}&y=${y}&w=${w}&h=${h}&value=${encodeURIComponent(value)}&t=${Date.now()}`;
      fetch(`${NCM_BASE}/api/input-state?${q}`, { cache: 'no-store' }).catch(() => {});
    } catch (_) {}
  }

  let lastHookMenuSeq = 0;
  let lastHookMenuOpen = false;

  async function pollNativeInput() {
    try {
      const resp = await fetch(`${NCM_BASE}/api/native-input?t=${Date.now()}`, { cache: 'no-store' });
      const j = await resp.json();
      nativeInputBridgeReady = true;
      if (j && typeof j.focusBlur === 'boolean' && j.focusTs > 0) {
        bridgeFocusActive = true;
        document.body.classList.toggle('unfocused', !!j.focusBlur);
      }
      if (j && (!!j.menuOpen !== lastHookMenuOpen || (j.menuInvokedSeq || 0) !== lastHookMenuSeq)) {
        lastHookMenuOpen = !!j.menuOpen;
        lastHookMenuSeq = j.menuInvokedSeq || 0;
        window.dispatchEvent(new CustomEvent('nientum-context-menu-sync', {
          detail: { menuOpen: lastHookMenuOpen, invokedSeq: lastHookMenuSeq }
        }));
      }
      if (!j || !j.seq || j.seq === nativeInputSeq) return;
      nativeInputSeq = j.seq;
      if (j.ts && Date.now() - j.ts > 60000) return;
      const el = document.getElementById(j.field || '');
      if (!el) return;
      el.value = j.text || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (j.commit) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (j.field === 'ncm-search-inp' && $('btn-ncm-search')) $('btn-ncm-search').click();
        el.blur();
      }
    } catch (_) {
      nativeInputBridgeReady = false;
    }
  }
  setInterval(pollNativeInput, 55);

  function maybeOpenNativeInput(el) {
    if (!nativeInputBridgeReady || !isTypingInput(el) || !el.id) return;
    const now = performance.now();
    if (lastNativeInputFocus.field === el.id && now - lastNativeInputFocus.t < 700) return;
    lastNativeInputFocus = { field: el.id, t: now };
    if (el.id === 'ncm-search-inp' && typeof toggleNcmKbd === 'function') toggleNcmKbd(false);
    if (el.id === 'inp-fps' && $('fps-keypad')) {
      $('fps-keypad').classList.remove('open');
      $('fps-keypad').setAttribute('aria-hidden', 'true');
    }
    notifyInputFocus(true, el);
  }

  document.addEventListener('focusin', (e) => maybeOpenNativeInput(e.target));
  document.addEventListener('click', (e) => maybeOpenNativeInput(e.target), true);

  function isTypingInput(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    const t = String(el.type || 'text').toLowerCase();
    return t === 'text' || t === 'search' || t === 'number' || t === 'password' || t === 'email' || t === 'url' || t === 'tel';
  }

  function setGoldSliderValue(el, val) {
    if (!el) return;
    const min = Number(el.dataset.min || 0);
    const max = Number(el.dataset.max || 100);
    const clamped = Math.max(min, Math.min(max, Number(val) || 0));
    const pct = max > min ? ((clamped - min) / (max - min)) * 100 : 0;
    el.dataset.value = String(clamped);
    const fill = el.querySelector('.gold-slider-fill');
    const thumb = el.querySelector('.gold-slider-thumb');
    if (fill) fill.style.width = pct.toFixed(2) + '%';
    if (thumb) thumb.style.left = pct.toFixed(2) + '%';
  }

  function bindGoldSlider(el, onVal) {
      if (!el) return;
      let dragging = false;
      const updateFromClientX = (clientX) => {
        const rect = el.getBoundingClientRect();
        const min = Number(el.dataset.min || 0);
        const max = Number(el.dataset.max || 100);
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
        const val = Math.round(min + ratio * (max - min));
        setGoldSliderValue(el, val);
        onVal(val);
      };
      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        el.classList.add('dragging');
        updateFromClientX(e.clientX);
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        updateFromClientX(e.clientX);
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('dragging');
      });
      }

  function applyVisualSettings() {
    document.documentElement.style.setProperty('--ui-alpha', String(state.uiOpacity));
    document.body.classList.toggle('footlights-on', !!state.footlights);
    document.body.classList.toggle('halo-on', !!state.halo);
    if ($('chk-footlights')) $('chk-footlights').checked = !!state.footlights;
    if ($('chk-halo')) $('chk-halo').checked = !!state.halo;
    if ($('chk-defocus-blur')) $('chk-defocus-blur').checked = state.defocusBlur !== false;
    if ($('chk-side-clock')) $('chk-side-clock').checked = state.showSideClock !== false;
    if ($('chk-side-drawer')) $('chk-side-drawer').checked = state.showSideDrawer !== false;
    document.body.classList.toggle('hide-side-clock', state.showSideClock === false);
    document.body.classList.toggle('hide-side-drawer', state.showSideDrawer === false);
    if ($('chk-dock-enabled')) $('chk-dock-enabled').checked = state.dockEnabled !== false;
    if ($('chk-sync-cg-set')) $('chk-sync-cg-set').checked = !!state.autoSyncCg;
    if ($('chk-sync-cg-local')) $('chk-sync-cg-local').checked = !!state.autoSyncCg;
    if ($('chk-sync-cg')) $('chk-sync-cg').checked = !!state.autoSyncCg;
    if ($('chk-ncm-lyric')) $('chk-ncm-lyric').checked = state.ncmLyricEnabled !== false;
    if ($('chk-ncm-cover-card')) $('chk-ncm-cover-card').checked = !!state.ncmCoverToCard;
    if ($('chk-local-cover-card')) $('chk-local-cover-card').checked = !!state.localCoverToCard;
    const lyricPct = Math.round((Number(state.lyricScale) || 1) * 100);
    document.documentElement.style.setProperty('--lyric-scale', String(lyricPct / 100));
    setGoldSliderValue($('sl-lyric-size'), lyricPct);
    if ($('val-lyric-size')) $('val-lyric-size').textContent = lyricPct + '%';
    const gainPct = Math.round((Number(state.vizGain) || 1) * 100);
    setGoldSliderValue($('sl-viz-gain'), gainPct);
    if ($('val-viz-gain')) $('val-viz-gain').textContent = gainPct + '%';
    if ($('chk-card-glass')) $('chk-card-glass').checked = !!state.cardGlass;
    if ($('cp-card')) $('cp-card').classList.toggle('glass', !!state.cardGlass);
    const tiltVal = Number.isFinite(Number(state.cardTilt)) ? Math.max(0, Math.min(5, Number(state.cardTilt))) : 1;
    const tiltPct = Math.round(tiltVal * 100);
    setGoldSliderValue($('sl-card-tilt'), tiltPct);
    if ($('val-card-tilt')) $('val-card-tilt').textContent = tiltPct === 0 ? '关闭' : tiltPct + '%';
    if ($('chk-ui-glass')) $('chk-ui-glass').checked = state.uiGlass !== false;
    document.body.classList.toggle('ui-glass', state.uiGlass !== false);
    const alphaVal = Math.round((Number(state.uiOpacity) || 0.96) * 100);
    setGoldSliderValue($('sl-ui-alpha'), alphaVal);
    if ($('val-ui-alpha')) $('val-ui-alpha').textContent = alphaVal + '%';
    const curMotion = state.dockMotion || 'soft';
    document.querySelectorAll('#opt-dock-motion .sp-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.motion === curMotion);
    });
    const autoSec = Number.isFinite(Number(state.capsuleAutoCollapseSec)) ? Number(state.capsuleAutoCollapseSec) : 30;
    document.querySelectorAll('#opt-capsule-auto .sp-chip').forEach(c => {
      c.classList.toggle('active', Number(c.dataset.sec) === autoSec);
    });
    const expandMode = state.capsuleExpandMode === 'click' ? 'click' : 'hover';
    document.querySelectorAll('#opt-capsule-expand .sp-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.mode === expandMode);
    });
    syncCapsuleVisualState();
    window.dispatchEvent(new CustomEvent('nientum-dock-settings', {
      detail: {
        dockEnabled: state.dockEnabled !== false,
        dockMotion: curMotion
      }
    }));
    const spineSpeedVal = Number.isFinite(Number(state.spineSpeed)) ? Math.max(0.2, Math.min(2, Number(state.spineSpeed))) : 1;
    const spineSpeedPct = Math.round(spineSpeedVal * 100);
    setGoldSliderValue($('sl-spine-speed'), spineSpeedPct);
    if ($('val-spine-speed')) $('val-spine-speed').textContent = spineSpeedPct + '%';
    if (window.NientumRender) window.NientumRender.set({ fpsLimit: Number(state.fpsLimit) || 0, resScale: Number(state.resScale) || 1 });
    window.NientumStage.setSettings({
      particles: state.particles,
      resScale: state.resScale,
      fpsLimit: state.fpsLimit,
      spineSpeed: spineSpeedVal
    });
    const partVal = Math.round(state.particles * 100);
    setGoldSliderValue($('sl-particles'), partVal);
    setGoldSliderValue($('sl-particles-set'), partVal);
    if ($('val-particles-set')) $('val-particles-set').textContent = partVal + '%';

    // 根据分辨率档位调节轻量模糊背景模糊度
    const blurBg = $('theater-blur-bg');
    if (blurBg) {
      blurBg.style.setProperty('--theater-blur', state.resScale >= 0.95 ? '20px' : (state.resScale >= 0.75 ? '12px' : '6px'));
    }

    document.querySelectorAll('#opt-res .sp-chip').forEach(c => {
      c.classList.toggle('active', Math.abs(Number(c.dataset.res) - state.resScale) < 0.05);
    });
    document.querySelectorAll('#opt-fps-presets .sp-chip').forEach(c => {
      c.classList.toggle('active', Number(c.dataset.fps) === Number(state.fpsLimit));
    });
    if ($('inp-fps') && document.activeElement !== $('inp-fps')) {
      $('inp-fps').value = String(state.fpsLimit);
    }
    const fwColor = /^#[0-9a-f]{6}$/i.test(String(state.fontWaveColor || '')) ? String(state.fontWaveColor).toLowerCase() : '#6ec6ff';
    state.fontWaveColor = fwColor;
    const r = parseInt(fwColor.slice(1, 3), 16);
    const g = parseInt(fwColor.slice(3, 5), 16);
    const b = parseInt(fwColor.slice(5, 7), 16);
    const dr = Math.round(r * 0.78), dg = Math.round(g * 0.78), db = Math.round(b * 0.78);
    const tr = Math.min(255, Math.round(r + (255 - r) * 0.36));
    const tg = Math.min(255, Math.round(g + (255 - g) * 0.36));
    const tb = Math.min(255, Math.round(b + (255 - b) * 0.36));
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--font-wave-color', fwColor);
    rootStyle.setProperty('--font-wave-deep', `rgb(${dr}, ${dg}, ${db})`);
    rootStyle.setProperty('--font-wave-tint', `rgba(${tr}, ${tg}, ${tb}, 0.56)`);
    rootStyle.setProperty('--font-wave-glow', `rgba(${r}, ${g}, ${b}, 0.38)`);
    document.body.classList.toggle('font-wave-on', !!state.fontWaveEnabled);
    if ($('chk-font-wave')) $('chk-font-wave').checked = !!state.fontWaveEnabled;
    if ($('font-wave-preview')) $('font-wave-preview').style.background = fwColor;
    if ($('font-palette-chip')) $('font-palette-chip').style.background = fwColor;
    if ($('inp-font-wave-hex') && document.activeElement !== $('inp-font-wave-hex')) {
      $('inp-font-wave-hex').value = fwColor;
    }
    document.querySelectorAll('#opt-font-wave-swatches .sp-swatch').forEach(sw => {
      sw.classList.toggle('active', String(sw.dataset.color || '').toLowerCase() === fwColor);
    });
  }

  function isTrackCoverAppliedToCard() {
    return activeSource === 'ncm' ? !!state.ncmCoverToCard : !!state.localCoverToCard;
  }

  function syncCardDynamicState() {
    const card = $('cp-card');
    if (!card) return;
    const curWp = DATA.wallpapers.find(w => w.id === state.wallpaperId);
    const wpDynamic = !!(curWp && ((curWp.layers && curWp.layers.length) || curWp.videoSrc || curWp.spine));
    const useTrackCover = isTrackCoverAppliedToCard();
    const useDyn = wpDynamic && !useTrackCover;
    card.classList.toggle('is-dynamic', useDyn);
  }

  function normalizeCropObj(crop) {
    if (!crop || typeof crop !== 'object') return null;
    const rx = Number(crop.x);
    const ry = Number(crop.y);
    const rz = Number(crop.zoom);
    const x = Number.isFinite(rx) ? Math.max(0, Math.min(1, rx)) : 0.5;
    const y = Number.isFinite(ry) ? Math.max(0, Math.min(1, ry)) : 0.5;
    const zoom = Number.isFinite(rz) ? Math.max(1, Math.min(3.5, rz)) : 1;
    if (zoom <= 1.002 && Math.abs(x - 0.5) <= 0.002 && Math.abs(y - 0.5) <= 0.002) return null;
    return {
      x: Math.round(x * 10000) / 10000,
      y: Math.round(y * 10000) / 10000,
      zoom: Math.round(zoom * 1000) / 1000
    };
  }

  function applyCropToImgEl(imgEl, wrapEl, crop) {
    if (!imgEl) return;
    const c = normalizeCropObj(crop);
    if (!c) {
      imgEl.classList.remove('has-crop');
      imgEl.style.width = '';
      imgEl.style.height = '';
      imgEl.style.maxWidth = '';
      imgEl.style.maxHeight = '';
      imgEl.style.objectFit = '';
      imgEl.style.objectPosition = '';
      imgEl.style.transformOrigin = '';
      imgEl.style.transform = '';
      return;
    }
    imgEl.classList.add('has-crop');
    const px = c.x;
    const py = c.y;
    const zoom = c.zoom;
    const rect = wrapEl ? wrapEl.getBoundingClientRect() : null;
    // 桌面卡片会被 JS 倾斜/漂移，改用不受 transform 影响的布局尺寸
    const useLayout = !!(wrapEl && wrapEl.id === 'cp-card' && wrapEl.offsetWidth > 0);
    const cw = useLayout ? wrapEl.offsetWidth : (rect && rect.width > 0 ? rect.width : 0);
    const ch = useLayout ? wrapEl.offsetHeight : (rect && rect.height > 0 ? rect.height : 0);
    const iw = imgEl.naturalWidth || 0;
    const ih = imgEl.naturalHeight || 0;
    if (cw > 0 && ch > 0 && iw > 0 && ih > 0) {
      const coverScale = Math.max(cw / iw, ch / ih);
      const dw = iw * coverScale * zoom;
      const dh = ih * coverScale * zoom;
      const tx = (cw - dw) * px;
      const ty = (ch - dh) * py;
      imgEl.style.width = dw.toFixed(2) + 'px';
      imgEl.style.height = dh.toFixed(2) + 'px';
      imgEl.style.maxWidth = 'none';
      imgEl.style.maxHeight = 'none';
      imgEl.style.objectFit = 'fill';
      imgEl.style.objectPosition = '';
      imgEl.style.transformOrigin = '0 0';
      imgEl.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0)`;
    } else {
      imgEl.style.width = '';
      imgEl.style.height = '';
      imgEl.style.maxWidth = '';
      imgEl.style.maxHeight = '';
      imgEl.style.objectFit = 'cover';
      imgEl.style.objectPosition = `${(px * 100).toFixed(2)}% ${(py * 100).toFixed(2)}%`;
      imgEl.style.transformOrigin = `${(px * 100).toFixed(2)}% ${(py * 100).toFixed(2)}%`;
      imgEl.style.transform = zoom > 1.002 ? `scale(${zoom.toFixed(4)})` : '';
    }
  }

  function syncCardCover(coverSrc) {
    const cpCover = $('cp-cover');
    if (!cpCover) return;
    const tr = getCurrentTrack();
    const fallbackCover = coverSrc || (tr && tr.cover) || 'assets/covers/cover_ending.png';
    if (!isTrackCoverAppliedToCard()) {
      const curWp = DATA.wallpapers.find(w => w.id === state.wallpaperId);
      const targetSrc = (curWp && (curWp.src || curWp.thumb)) || fallbackCover;
      if (cpCover.getAttribute('src') !== targetSrc) cpCover.src = targetSrc;
      const crop = curWp ? curWp.crop : null;
      const applyCard = () => applyCropToImgEl(cpCover, $('cp-card'), crop);
      if (cpCover.complete && cpCover.naturalWidth) applyCard();
      else {
        applyCard();
        cpCover.addEventListener('load', applyCard, { once: true });
      }
    } else {
      if (cpCover.getAttribute('src') !== fallbackCover) cpCover.src = fallbackCover;
      applyCropToImgEl(cpCover, $('cp-card'), null);
    }
  }

  function importedToWallpaper(item) {
    const id = encodeURIComponent(item.id);
    const ver = item.addedAt || 0;
    const media = `${NCM_BASE}/api/wp/media?id=${id}`;
    const thumbUrl = item.hasThumb ? `${NCM_BASE}/api/wp/thumb?id=${id}&v=${ver}` : '';
    const fallbackUrl = item.hasFallback ? `${NCM_BASE}/api/wp/media?id=${id}&fb=1` : '';
    const isVideo = item.kind === 'video';
    const playable = !isVideo || item.playable !== false;
    const isWebmNative = ['vp9', 'vp8', 'webm', 'vp09', 'vp08'].includes(String(item.codec || '').toLowerCase());
    const primaryVideo = (isVideo && playable) ? ((fallbackUrl && !isWebmNative) ? fallbackUrl : media) : '';
    const secondaryVideo = (isVideo && playable && primaryVideo === fallbackUrl) ? media : ((isVideo && playable) ? fallbackUrl : '');
    const serverCrop = normalizeCropObj(item.crop);
    const localCrop = normalizeCropObj(state.wpCrops && state.wpCrops[item.id]);
    const crop = serverCrop || localCrop;
    if (serverCrop && state.wpCrops) state.wpCrops[item.id] = serverCrop;
    return {
      id: item.id,
      title: item.title || '导入壁纸',
      act: 'imported',
      cat: 'imported',
      badge: isVideo ? (playable ? '视频' : '编码不支持') : (item.source === 'we' ? '静态' : '图片'),
      src: isVideo ? (thumbUrl || '') : media,
      videoSrc: primaryVideo,
      videoFallback: secondaryVideo,
      thumb: isVideo ? thumbUrl : (thumbUrl || media),
      theme: 'theater_gold',
      l2d: null,
      imported: true,
      kind: isVideo ? 'video' : 'image',
      source: item.source || 'local',
      weType: item.weType || '',
      codec: item.codec || '',
      crop,
      unsupported: isVideo && !playable,
      unsupportedReason: (isVideo && !playable) ? (item.codec === 'missing' ? 'missing' : 'codec') : ''
    };
  }

  async function loadImportedWallpapers() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1800);
      const resp = await fetch(`${NCM_BASE}/api/wp/list`, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      importedWallpapers = (data && Array.isArray(data.items) ? data.items : []).map(importedToWallpaper);
    } catch (_) {
      importedWallpapers = [];
    }
    DATA.wallpapers = BASE_WALLPAPERS.concat(importedWallpapers);
    return importedWallpapers;
  }

  async function refreshImportedWallpapers(selectId) {
    await loadImportedWallpapers();
    const cur = DATA.wallpapers.find(w => w.id === state.wallpaperId);
    if (!cur || cur.unsupported) {
      const first = DATA.wallpapers.find(w => !w.unsupported);
      if (first) selectWallpaperById(first.id);
    }
    renderWallpaperCats();
    renderWallpaperGrid();
    const target = selectId ? DATA.wallpapers.find(w => w.id === selectId) : null;
    if (target && !target.unsupported) selectWallpaperById(selectId);
  }

  let wpThumbPending = new Set();
  let wpImportPending = false;
  let weScanAllItems = [];
  let weFilterMode = 'all';

  function getWeRecordDuration() {
    const inp = $('inp-we-duration');
    if (inp && inp.value !== '') {
      const n = Math.round(Number(inp.value));
      if (Number.isFinite(n)) return Math.max(5, Math.min(300, n));
    }
    const wrap = $('sel-we-duration');
    const active = wrap && wrap.querySelector('.cat-pill.active');
    const v = active ? Number(active.dataset.dur) : 15;
    return Math.max(5, Math.min(300, Number.isFinite(v) ? v : 15));
  }

  function getWeRecordResolution() {
    const wrap = $('sel-we-resolution');
    const active = wrap && wrap.querySelector('.cat-pill.active');
    const res = active ? String(active.dataset.res || '').toLowerCase() : '4k';
    return (res === '1080p' || res === '2k' || res === '4k') ? res : '4k';
  }

  function getWeLoopMode() {
    const wrap = $('sel-we-loop');
    const active = wrap && wrap.querySelector('.cat-pill.active');
    const mode = active ? String(active.dataset.loop || '').toLowerCase() : 'crossfade';
    return (mode === 'none' || mode === 'crossfade' || mode === 'match') ? mode : 'crossfade';
  }

  function applyWeImportFilter() {
    const inp = $('inp-we-search');
    const q = inp ? inp.value.trim().toLowerCase() : '';
    const filtered = weScanAllItems.filter(it => {
      const isDyn = it.support === 'dynamic';
      const isScene = !isDyn && it.weType === 'scene';
      if (weFilterMode === 'scene' && !isScene) return false;
      if (weFilterMode === 'video' && !isDyn) return false;
      if (weFilterMode === 'static' && (isDyn || isScene)) return false;
      if (q && !String(it.title || '').toLowerCase().includes(q)) return false;
      return true;
    });
    renderWeImportList(filtered);
  }

  function setWpImportStatus(msg, cls) {
    const el = $('wp-import-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'wp-import-status' + (cls ? ' ' + cls : '');
  }

  let importProgressTimer = 0;
  function applyImportProgress(j) {
    const bar = $('wp-import-progress');
    const fill = $('wp-import-progress-fill');
    if (!bar || !fill) return;
    if (j && j.active) {
      bar.classList.add('show');
      fill.style.width = Math.max(2, Math.min(100, Number(j.percent) || 0)) + '%';
      if (j.message) setWpImportStatus(j.message);
    } else {
      bar.classList.remove('show');
    }
  }
  async function pollImportProgressOnce() {
    try {
      const resp = await fetch(`${NCM_BASE}/api/wp/import-progress?t=${Date.now()}`, { cache: 'no-store' });
      const j = await resp.json();
      applyImportProgress(j);
    } catch (_) {}
  }
  function startImportProgressPoll() {
    stopImportProgressPoll();
    pollImportProgressOnce();
    importProgressTimer = setInterval(pollImportProgressOnce, 500);
  }
  function stopImportProgressPoll() {
    if (importProgressTimer) { clearInterval(importProgressTimer); importProgressTimer = 0; }
    const bar = $('wp-import-progress');
    if (bar) bar.classList.remove('show');
  }

  function openWpImport() {
    const pop = $('wp-import-pop');
    if (!pop) return;
    pop.classList.add('open');
    pop.setAttribute('aria-hidden', 'false');
    setWpImportStatus('');
    loadWeImportList();
  }

  function closeWpImport() {
    const pop = $('wp-import-pop');
    if (!pop) return;
    pop.classList.remove('open');
    pop.setAttribute('aria-hidden', 'true');
  }

  let wpCropState = { id: '', kind: 'image', x: 0.5, y: 0.5, zoom: 1, iw: 0, ih: 0, cw: 0, ch: 0 };

  function updateCropStageAspect() {
    const ws = $('wp-crop-workspace');
    const st = $('wp-crop-stage');
    if (!ws || !st) return;
    const rect = ws.getBoundingClientRect();
    const maxW = Math.max(240, (rect.width || 640) - 20);
    const maxH = Math.max(160, (rect.height || 340) - 20);
    const scrRatio = (window.innerWidth > 0 && window.innerHeight > 0)
      ? (window.innerWidth / window.innerHeight)
      : (16 / 9);
    let sw = maxW;
    let sh = sw / scrRatio;
    if (sh > maxH) {
      sh = maxH;
      sw = sh * scrRatio;
    }
    st.style.width = Math.round(sw) + 'px';
    st.style.height = Math.round(sh) + 'px';
    wpCropState.cw = Math.round(sw);
    wpCropState.ch = Math.round(sh);
  }

  function layoutCropPreview() {
    const st = $('wp-crop-stage');
    const imgEl = $('wp-crop-img');
    const vidEl = $('wp-crop-video');
    const el = wpCropState.kind === 'video' ? vidEl : imgEl;
    if (!st || !el) return;
    const cw = wpCropState.cw || st.clientWidth || 16;
    const ch = wpCropState.ch || st.clientHeight || 9;
    const iw = wpCropState.kind === 'video' ? (vidEl.videoWidth || wpCropState.iw) : (imgEl.naturalWidth || wpCropState.iw);
    const ih = wpCropState.kind === 'video' ? (vidEl.videoHeight || wpCropState.ih) : (imgEl.naturalHeight || wpCropState.ih);
    wpCropState.iw = iw || 0;
    wpCropState.ih = ih || 0;

    const pctText = Math.round(wpCropState.zoom * 100) + '%';
    if ($('val-wp-crop-zoom')) $('val-wp-crop-zoom').textContent = pctText;
    setGoldSliderValue($('sl-wp-crop-zoom'), Math.round(wpCropState.zoom * 100));

    if (iw > 0 && ih > 0) {
      const coverScale = Math.max(cw / iw, ch / ih);
      const dw = iw * coverScale * wpCropState.zoom;
      const dh = ih * coverScale * wpCropState.zoom;
      const tx = (cw - dw) * wpCropState.x;
      const ty = (ch - dh) * wpCropState.y;
      el.style.width = dw.toFixed(2) + 'px';
      el.style.height = dh.toFixed(2) + 'px';
      el.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0)`;
      if ($('wp-crop-info')) {
        const scrW = window.innerWidth || 1920;
        const scrH = window.innerHeight || 1080;
        $('wp-crop-info').textContent = `原素材 ${iw}×${ih} → 桌面 ${scrW}×${scrH} · 缩放 ${pctText}`;
      }
    } else if ($('wp-crop-info')) {
      $('wp-crop-info').textContent = `正在加载预览 · 缩放 ${pctText}`;
    }
  }

  function zoomCropAnchored(nextZoom) {
    const newZoom = Math.max(1, Math.min(3.5, Number(nextZoom) || 1));
    const iw = wpCropState.iw || 16;
    const ih = wpCropState.ih || 9;
    const cw = wpCropState.cw || 16;
    const ch = wpCropState.ch || 9;
    const texAspect = iw / ih;
    const canvasAspect = cw / ch;
    const baseU = texAspect > canvasAspect ? (canvasAspect / texAspect) : 1;
    const baseV = texAspect > canvasAspect ? 1 : (texAspect / canvasAspect);

    const oldUSpan = baseU / wpCropState.zoom;
    const oldVSpan = baseV / wpCropState.zoom;
    const uCenter = (1 - oldUSpan) * wpCropState.x + 0.5 * oldUSpan;
    const vCenter = (1 - oldVSpan) * wpCropState.y + 0.5 * oldVSpan;

    const newUSpan = baseU / newZoom;
    const newVSpan = baseV / newZoom;
    const uMaxPan = 1 - newUSpan;
    const vMaxPan = 1 - newVSpan;

    wpCropState.zoom = newZoom;
    wpCropState.x = uMaxPan > 1e-5
      ? Math.max(0, Math.min(1, (uCenter - 0.5 * newUSpan) / uMaxPan))
      : 0.5;
    wpCropState.y = vMaxPan > 1e-5
      ? Math.max(0, Math.min(1, (vCenter - 0.5 * newVSpan) / vMaxPan))
      : 0.5;
    layoutCropPreview();
  }

  function openWpCropper(wpId, opts) {
    const pop = $('wp-crop-pop');
    const wp = DATA.wallpapers.find(w => w.id === wpId);
    if (!pop || !wp || wp.unsupported) return;
    const initCrop = normalizeCropObj(wp.crop);
    wpCropState = {
      id: wp.id,
      kind: wp.kind === 'video' ? 'video' : 'image',
      x: initCrop ? initCrop.x : 0.5,
      y: initCrop ? initCrop.y : 0.5,
      zoom: initCrop ? initCrop.zoom : 1,
      iw: 0,
      ih: 0,
      cw: 0,
      ch: 0
    };
    const count = opts && Number(opts.afterImportCount) > 1 ? Number(opts.afterImportCount) : 0;
    if ($('wp-crop-title')) {
      $('wp-crop-title').textContent = `调整桌面裁切：${wp.title || '导入壁纸'}`;
    }
    if ($('wp-crop-sub')) {
      $('wp-crop-sub').textContent = count > 1
        ? `已批量导入 ${count} 张壁纸，可先调节第 1 张桌面显示范围（其余可在壁纸库卡片点击 ✂ 调整）`
        : '按当前桌面分辨率比例锁定的取景框，拖动画面位置或滚轮缩放，使非标准比例壁纸完美贴合桌面';
    }

    const imgEl = $('wp-crop-img');
    const vidEl = $('wp-crop-video');
    imgEl.classList.remove('active');
    vidEl.classList.remove('active');
    imgEl.removeAttribute('src');
    try { vidEl.pause(); vidEl.removeAttribute('src'); vidEl.load(); } catch (_) {}

    pop.classList.add('open');
    pop.setAttribute('aria-hidden', 'false');

    if (wpCropState.kind === 'video' && wp.videoSrc) {
      vidEl.classList.add('active');
      vidEl.onloadedmetadata = () => {
        if (wpCropState.id !== wp.id) return;
        wpCropState.iw = vidEl.videoWidth || 0;
        wpCropState.ih = vidEl.videoHeight || 0;
        updateCropStageAspect();
        layoutCropPreview();
        vidEl.play().catch(() => {});
      };
      vidEl.src = wp.videoSrc;
    } else {
      imgEl.classList.add('active');
      imgEl.onload = () => {
        if (wpCropState.id !== wp.id) return;
        wpCropState.iw = imgEl.naturalWidth || 0;
        wpCropState.ih = imgEl.naturalHeight || 0;
        updateCropStageAspect();
        layoutCropPreview();
      };
      imgEl.src = wp.src || wp.thumb || '';
    }

    requestAnimationFrame(() => {
      updateCropStageAspect();
      layoutCropPreview();
    });
  }

  function closeWpCropper() {
    const pop = $('wp-crop-pop');
    const vidEl = $('wp-crop-video');
    if (vidEl) {
      try { vidEl.pause(); vidEl.removeAttribute('src'); vidEl.load(); } catch (_) {}
    }
    if (!pop) return;
    pop.classList.remove('open');
    pop.setAttribute('aria-hidden', 'true');
  }

  async function saveWpCropper() {
    const id = wpCropState.id;
    if (!id) { closeWpCropper(); return; }
    const cropObj = normalizeCropObj({ x: wpCropState.x, y: wpCropState.y, zoom: wpCropState.zoom });
    if (!state.wpCrops || typeof state.wpCrops !== 'object') state.wpCrops = {};
    if (cropObj) state.wpCrops[id] = cropObj;
    else delete state.wpCrops[id];
    saveState();

    const wp = DATA.wallpapers.find(w => w.id === id);
    if (wp) wp.crop = cropObj;
    if (window.NientumStage && typeof window.NientumStage.setWallpaperCrop === 'function') {
      window.NientumStage.setWallpaperCrop(id, cropObj);
    }
    syncCardCover();
    renderWallpaperGrid();

    try {
      await fetch(`${NCM_BASE}/api/wp/crop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cropObj ? { id, crop: cropObj } : { id, reset: true })
      });
    } catch (_) {}
    closeWpCropper();
  }

  function renderWeImportList(items) {
    const list = $('wp-import-we-list');
    if (!list) return;
    if (!weScanAllItems.length) {
      list.innerHTML = '<div class="wp-import-empty">未找到可导入的 Wallpaper Engine 壁纸。需要已安装 WE，并至少有一个视频或带预览图的壁纸。</div>';
      return;
    }
    if (!items || !items.length) {
      list.innerHTML = '<div class="wp-import-empty">没有符合当前筛选或搜索关键词的壁纸</div>';
      return;
    }
    const dur = getWeRecordDuration();
    const resKey = getWeRecordResolution();
    const resLabel = resKey === '1080p' ? '1080p' : (resKey === '2k' ? '2K' : '4K');
    const loopMode = getWeLoopMode();
    const loopLabel = loopMode === 'crossfade' ? ' · 首尾柔化' : (loopMode === 'match' ? ' · 智能循环' : '');
    const typeMap = { video: '视频壁纸', scene: '场景壁纸', web: '网页壁纸', application: '应用壁纸' };
    const frag = document.createDocumentFragment();
    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'wp-we-row';
      const thumb = item.hasPreview
        ? `<img src="${NCM_BASE}/api/wp/we-thumb?id=${encodeURIComponent(item.id)}" decoding="async" alt="" />`
        : '<span>无预览</span>';
      const typeLabel = typeMap[item.weType] || '壁纸';
      const canRecord = item.support !== 'dynamic' && item.weType === 'scene';
      const meta = item.support === 'dynamic'
        ? `${typeLabel} · 动态视频`
        : (canRecord ? `${typeLabel} · 自动录制 ${dur} 秒 · ${resLabel}${loopLabel}` : `${typeLabel} · 仅静态封面`);
      const btnLabel = item.support === 'dynamic' ? '导入视频' : (canRecord ? '录制并导入' : '导入封面');
      row.innerHTML = `
        <div class="wp-we-thumb">${thumb}</div>
        <div class="wp-we-info">
          <div class="wp-we-name">${escapeHtml(item.title || '未命名壁纸')}</div>
          <div class="wp-we-meta">${escapeHtml(meta)}<span class="wp-we-res"></span></div>
        </div>
        <button type="button" class="warm-btn sm ${item.support === 'dynamic' || canRecord ? 'gold' : ''}">${btnLabel}</button>
      `;
      const btn = row.querySelector('button');
      btn.onclick = () => importWeWallpaper(item);
      if (item.support !== 'dynamic') {
        const im = row.querySelector('.wp-we-thumb img');
        const resEl = row.querySelector('.wp-we-res');
        if (im && resEl) {
          const showRes = () => { if (im.naturalWidth) resEl.textContent = `${im.naturalWidth}×${im.naturalHeight}`; };
          im.addEventListener('load', showRes);
          if (im.complete && im.naturalWidth) showRes();
        }
      }
      frag.appendChild(row);
    });
    list.innerHTML = '';
    list.appendChild(frag);
  }

  async function loadWeImportList() {
    const list = $('wp-import-we-list');
    if (list) list.innerHTML = '<div class="wp-import-empty">正在扫描 Wallpaper Engine 壁纸库...</div>';
    setWpImportStatus('正在扫描，视频较多时可能需要几秒...');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const resp = await fetch(`${NCM_BASE}/api/wp/we-list`, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      const data = await resp.json();
      if (!data || !data.ok) {
        weScanAllItems = [];
        renderWeImportList([]);
        setWpImportStatus((data && data.error) || '扫描失败', 'err');
        return;
      }
      weScanAllItems = Array.isArray(data.items) ? data.items : [];
      applyWeImportFilter();
      const dur = getWeRecordDuration();
      setWpImportStatus(`共找到 ${weScanAllItems.length} 个可导入壁纸。场景壁纸将自动拉起 WE 窗口录制 ${dur} 秒并转为 WebM；网页/应用壁纸仅导入静态封面。`, weScanAllItems.length ? 'ok' : '');
    } catch (e) {
      weScanAllItems = [];
      renderWeImportList([]);
      setWpImportStatus('无法连接本地代理，请确认 NientumBridge 正在运行', 'err');
    }
  }

  async function importLocalWallpaper() {
    if (wpImportPending) return;
    wpImportPending = true;
    const btn = $('btn-wp-pick-local');
    if (btn) btn.disabled = true;
    setWpImportStatus('正在等待文件选择；视频将自动去除音轨并单通转码为 CEF 原生 WebM (VP9)...');
    startImportProgressPoll();
    try {
      const resp = await fetch(`${NCM_BASE}/api/wp/pick-local`, { method: 'POST' });
      const data = await resp.json();
      if (!data || !data.ok) {
        setWpImportStatus((data && data.error) || '导入失败', 'err');
        return;
      }
      const list = Array.isArray(data.items) && data.items.length ? data.items : (data.item ? [data.item] : []);
      const firstId = list[0] ? list[0].id : '';
      const errNote = (Array.isArray(data.errors) && data.errors.length) ? `（${data.errors.length} 个失败）` : '';
      setWpImportStatus(`已成功导入 ${list.length} 个壁纸${errNote}，正在刷新壁纸库...`, 'ok');
      await refreshImportedWallpapers(firstId);
      closeWpImport();
      list.forEach(it => {
        if (it && it.kind === 'video' && !it.hasThumb) generateVideoThumb(it);
      });
      if (firstId) openWpCropper(firstId, { afterImportCount: list.length });
    } catch (e) {
      setWpImportStatus('导入失败：无法连接本地代理', 'err');
    } finally {
      stopImportProgressPoll();
      wpImportPending = false;
      if (btn) btn.disabled = false;
    }
  }

  async function importWeWallpaper(item) {
    if (!item || !item.id || wpImportPending) return;
    wpImportPending = true;
    const isSceneRecord = item.support !== 'dynamic' && item.weType === 'scene';
    const dur = getWeRecordDuration();
    const resKey = getWeRecordResolution();
    const resLabel = resKey === '1080p' ? '1080p' : (resKey === '2k' ? '2K' : '4K');
    const loopMode = getWeLoopMode();
    const endpoint = isSceneRecord ? '/api/wp/we-record' : '/api/wp/import-we';
    setWpImportStatus(isSceneRecord
      ? `正在自动打开 WE 窗口录制 ${dur} 秒（目标 ${resLabel}）并转码为 WebM，请勿关闭弹出的壁纸窗口...`
      : '正在复制并单通转码为 CEF 原生 WebM (VP9)...');
    document.querySelectorAll('#wp-import-we-list button').forEach(b => { b.disabled = true; });
    startImportProgressPoll();
    try {
      const resp = await fetch(`${NCM_BASE}${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isSceneRecord ? { id: item.id, duration: dur, resolution: resKey, loopMode } : { id: item.id })
      });
      const data = await resp.json();
      if (!data || !data.ok) {
        setWpImportStatus((data && data.error) || '导入失败', 'err');
        return;
      }
      await refreshImportedWallpapers(data.item.id);
      closeWpImport();
      if (data.item.kind === 'video' && !data.item.hasThumb) generateVideoThumb(data.item);
      if (data.item && data.item.id) openWpCropper(data.item.id, { afterImportCount: 1 });
    } catch (e) {
      setWpImportStatus('导入失败：无法连接本地代理', 'err');
    } finally {
      stopImportProgressPoll();
      wpImportPending = false;
      document.querySelectorAll('#wp-import-we-list button').forEach(b => { b.disabled = false; });
    }
  }

  function generateVideoThumb(item) {
    if (!item || item.kind !== 'video' || wpThumbPending.has(item.id)) return;
    wpThumbPending.add(item.id);
    const media = `${NCM_BASE}/api/wp/media?id=${encodeURIComponent(item.id)}`;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.style.cssText = 'position:fixed;left:-4px;top:-4px;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(v);
    let done = false;
    const cleanup = () => {
      wpThumbPending.delete(item.id);
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {}
      try { v.remove(); } catch (_) {}
    };
    const sendMeta = () => {
      const w = v.videoWidth || item.width || 0;
      const h = v.videoHeight || item.height || 0;
      const d = isFinite(v.duration) ? v.duration : 0;
      fetch(`${NCM_BASE}/api/wp/meta`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, width: w, height: h, duration: d })
      }).catch(() => {});
    };
    v.addEventListener('loadedmetadata', () => {
      sendMeta();
      const target = Math.min(0.5, (isFinite(v.duration) ? v.duration : 1) * 0.1);
      try { v.currentTime = Math.max(0, target || 0.1); } catch (_) {}
    });
    v.addEventListener('seeked', async () => {
      if (done) return;
      done = true;
      try {
        const w = v.videoWidth || 480;
        const h = v.videoHeight || 270;
        const tw = Math.min(480, w);
        const th = Math.max(1, Math.round(tw * h / w));
        const cv = document.createElement('canvas');
        cv.width = tw; cv.height = th;
        cv.getContext('2d').drawImage(v, 0, 0, tw, th);
        const dataUrl = cv.toDataURL('image/jpeg', 0.72);
        await fetch(`${NCM_BASE}/api/wp/thumb`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id, data: dataUrl })
        });
        await refreshImportedWallpapers(item.id);
      } catch (_) {}
      cleanup();
    });
    v.addEventListener('error', cleanup);
    setTimeout(() => { if (!done) cleanup(); }, 15000);
    v.src = media;
  }

  function selectWallpaperById(id) {
    const found = DATA.wallpapers.find(w => w.id === id);
    if (found && found.unsupported) return;
    const wp = found || (String(id || '').startsWith('imp_') ? null : DATA.wallpapers[0]);
    if (!wp) return;
    state.wallpaperId = wp.id;
    window.NientumStage.setWallpaper(wp);
    const blurBg = $('theater-blur-bg');
    if (blurBg) blurBg.src = wp.thumb || wp.src || 'assets/covers/cover_ending.png';
    if ($('header-cg-pill')) $('header-cg-pill').textContent = `当前壁纸：${wp.title}`;
    renderWallpaperCats();
    renderWallpaperGrid();
    syncCardCover();
    syncCardDynamicState();
    saveState();
  }

  function syncWallpaperToAct(actCode) {
    if (!state.autoSyncCg) return;
    const match =
      DATA.wallpapers.find(w => w.cat === 'l2d' && w.act === actCode) ||
      DATA.wallpapers.find(w => w.act === actCode);
    if (match) selectWallpaperById(match.id);
  }

  function centerActiveChapterPill(smooth) {
    const strip = $('chapter-strip');
    const activePill = strip && strip.querySelector('.ch-pill.active');
    if (!strip || !activePill) return;
    const targetLeft = activePill.offsetLeft + activePill.offsetWidth / 2 - strip.clientWidth / 2;
    const maxLeft = Math.max(0, strip.scrollWidth - strip.clientWidth);
    const clamped = Math.max(0, Math.min(maxLeft, targetLeft));
    if (strip.scrollTo) {
      strip.scrollTo({ left: clamped, behavior: smooth ? 'smooth' : 'auto' });
    } else {
      strip.scrollLeft = clamped;
    }
  }

  function focusPlayingTrackInList(smooth) {
    const tr = DATA.tracks[state.trackIndex];
    if (!tr) return;
    const inCurrentChapter = state.chapter === 'ALL' || tr.act === state.chapter;
    if (!inCurrentChapter) {
      state.chapter = tr.act || 'ALL';
      renderChapters();
      renderTrackList();
    }
    selectedIndex = state.trackIndex;
    centerSelectedCard(!!smooth);
    updateSelectionInPlace();
    centerActiveChapterPill(!!smooth);
  }

  function switchChapterFilter(chapterCode) {
    state.chapter = chapterCode;
    const nextRows = getVisibleTracks();
    // 切换分类时，若当前列表选中的封票不在新分类中，自动将选曲焦点调至该分类第一首（不做试听）
    if (nextRows.length && !nextRows.some(r => r.idx === selectedIndex)) {
      selectedIndex = nextRows[0].idx;
    }
    renderChapters();
    renderTrackList();
    centerActiveChapterPill(true);
    saveState();
  }

  function renderChapters() {
    const strip = $('chapter-strip');
    strip.innerHTML = '';

    const allBtn = document.createElement('button');
    allBtn.className = 'ch-pill' + (state.chapter === 'ALL' ? ' active' : '');
    allBtn.textContent = '全部';
    allBtn.onclick = () => switchChapterFilter('ALL');
    strip.appendChild(allBtn);

    DATA.chapters.forEach(ch => {
      const btn = document.createElement('button');
      btn.className = 'ch-pill' + (ch.code === state.chapter ? ' active' : '');
      btn.textContent = ch.label;
      btn.title = ch.zh ? `${ch.label} · ${ch.zh}` : ch.label;
      btn.onclick = () => switchChapterFilter(ch.code);
      strip.appendChild(btn);
    });
  }

  function getVisibleTracks() {
    return DATA.tracks
      .map((t, idx) => ({ track: t, idx }))
      .filter(x => state.chapter === 'ALL' || x.track.act === state.chapter);
  }

  function getChapterTracks(actCode) {
    return DATA.tracks
      .map((t, idx) => ({ track: t, idx }))
      .filter(x => x.track.act === actCode);
  }

  function getEffectiveTopPad(listH) {
    const count = visibleRows.length;
    if (count <= 0) return TOP_PAD;
    const totalSpan = (count - 1) * ROW_STRIDE;
    const centerLine = listH * 0.48;
    // 当曲目较少时，整组封票在选曲栏垂直居中显示
    if (totalSpan < Math.max(0, (centerLine - TOP_PAD) * 2)) {
      return Math.max(TOP_PAD, centerLine - totalSpan * 0.5);
    }
    return TOP_PAD;
  }

  // 根据当前滚动位置自动将最接近中央的封票设为选曲焦点（置于最上层、切换 active 图），不触发试听
  function syncSelectionFromScroll() {
    const list = $('track-list');
    if (!list || !visibleRows.length) return;
    const listH = list.clientHeight;
    if (listH <= 0) return;
    const spacer = list.firstElementChild;
    if (!spacer) return;
    const cards = spacer.children;

    const topPad = getEffectiveTopPad(listH);
    const centerLine = listH * 0.48;
    const topSpan = Math.max(1, centerLine - topPad);
    const k = Math.max(0, Math.min(1, scrollPos / topSpan));
    const focusY = topPad + k * (centerLine - topPad);
    const centerIdx = Math.max(0, Math.min(
      visibleRows.length - 1,
      Math.round((scrollPos + focusY - topPad) / ROW_STRIDE)
    ));
    const targetTrackIdx = visibleRows[centerIdx].idx;
    if (targetTrackIdx === selectedIndex && cards[centerIdx] && cards[centerIdx].classList.contains('selected')) {
      return;
    }

    selectedIndex = targetTrackIdx;
    $('stat-idx').textContent = `曲目  ${String(centerIdx + 1).padStart(2, '0')} / ${String(visibleRows.length).padStart(2, '0')}`;
    for (let i = 0; i < visibleRows.length && i < cards.length; i++) {
      const idx = visibleRows[i].idx;
      const isSelected = idx === selectedIndex;
      const isPlaying = activeSource === 'local' && state.playing && idx === state.trackIndex;
      const card = cards[i];
      card.classList.toggle('selected', isSelected);
      card.classList.toggle('playing', isPlaying);
      card.style.zIndex = String(500 - Math.abs(i - centerIdx));
      const img = card.querySelector('.card-img');
      if (img) {
        const want = cardArt(visibleRows[i].track, isSelected);
        if (img.getAttribute('src') !== want) img.setAttribute('src', want);
      }
    }
  }

  // 完全复刻弧形列表排版：每张封票等长，整体随弧线向右偏移（左侧中间往右缩，右侧同步外凸）
  function layoutArcCards(syncSelection) {
    const list = $('track-list');
    if (!list) return;
    const listH = list.clientHeight;
    if (listH <= 0) return;
    const spacer = list.firstElementChild;
    if (!spacer) return;
    if (syncSelection) syncSelectionFromScroll();
    const cards = spacer.children;

    const topPad = getEffectiveTopPad(listH);
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const selected = card.classList.contains('selected');
      const w = selected ? 922 : 900;
      const h = selected ? 148 : 134;
      const cy = topPad + i * ROW_STRIDE - scrollPos;
      const fade = Math.max(0, Math.min(1, Math.min(cy - 10, listH - cy - 10) / 72));
      if (fade <= 0.02) {
        if (card.style.display !== 'none') card.style.display = 'none';
        continue;
      }
      if (card.style.display !== 'block') card.style.display = 'block';
      const t = Math.max(0, Math.min(1, cy / listH));
      // 封票长度保持不变，整张卡片沿弧线向右偏移：中间向右侧凸出（左侧中间往右缩）
      const off = Math.round(86 * Math.sin(Math.PI * t));
      const x = 14 + off;
      const top = cy - h * 0.5;

      card.style.width = w + 'px';
      card.style.height = h + 'px';
      card.style.left = x.toFixed(1) + 'px';
      card.style.top = top.toFixed(1) + 'px';
      card.style.opacity = fade.toFixed(3);
    }

    const bar = $('arc-scrollbar');
    const thumb = $('arc-scroll-thumb');
    if (bar && thumb) {
      const maxS = maxScrollY();
      if (maxS <= 1) {
        bar.style.opacity = '0.2';
        thumb.style.height = '100%';
        thumb.style.top = '0px';
      } else {
        bar.style.opacity = '1';
        const barH = bar.clientHeight || 800;
        const th = Math.max(44, (listH / (maxS + listH)) * barH);
        const ratio = Math.max(0, Math.min(1, scrollPos / maxS));
        thumb.style.height = th.toFixed(1) + 'px';
        thumb.style.top = (ratio * (barH - th)).toFixed(1) + 'px';
      }
    }
  }

  function scheduleArcLayout() {
    if (arcRaf) return;
    arcRaf = requestAnimationFrame(() => {
      arcRaf = 0;
      layoutArcCards(false);
    });
  }

  
  function maxScrollY() {
    const list = $('track-list');
    const listH = (list && list.clientHeight) || 820;
    const topPad = getEffectiveTopPad(listH);
    return Math.max(0, topPad + Math.max(0, visibleRows.length - 1) * ROW_STRIDE - listH * 0.48);
  }

  function centerSelectedCard(smooth) {
    const list = $('track-list');
    if (!list) return;
    const listH = list.clientHeight || 820;
    const topPad = getEffectiveTopPad(listH);
    const visIdx = visibleRows.findIndex(r => r.idx === selectedIndex);
    const i = visIdx >= 0 ? visIdx : 0;
    const target = Math.max(0, Math.min(maxScrollY(), topPad + i * ROW_STRIDE - listH * 0.48));
    wheelTarget = target;
    if (smooth) {
      selectionLocked = true;
      if (!wheelRaf) wheelRaf = requestAnimationFrame(stepSmoothWheel);
    } else {
      selectionLocked = false;
      if (wheelRaf) {
        cancelAnimationFrame(wheelRaf);
        wheelRaf = 0;
      }
      scrollPos = target;
      layoutArcCards(false);
    }
  }

  function stepSmoothWheel() {
    const diff = wheelTarget - scrollPos;
    const sync = !selectionLocked;
    if (Math.abs(diff) < 0.6) {
      scrollPos = wheelTarget;
      wheelRaf = 0;
      selectionLocked = false;
      layoutArcCards(sync);
      return;
    }
    scrollPos += diff * 0.13;
    layoutArcCards(sync);
    wheelRaf = requestAnimationFrame(stepSmoothWheel);
  }

  let musicWheelCooldownUntil = 0;
  function stepMusicByWheel(dir) {
    if (!visibleRows.length) return;
    const now = performance.now();
    if (now < musicWheelCooldownUntil) return;
    musicWheelCooldownUntil = now + 28;
    const step = dir > 0 ? 1 : -1;
    let curVis = visibleRows.findIndex(r => r.idx === selectedIndex);
    if (curVis < 0) curVis = 0;
    const nextVis = Math.max(0, Math.min(visibleRows.length - 1, curVis + step));
    if (nextVis !== curVis) {
      selectedIndex = visibleRows[nextVis].idx;
      updateSelectionInPlace();
    }
    centerSelectedCard(true);
  }

  let ncmWheelCooldownUntil = 0;
  function stepNcmByWheel(dir) {
    if (!ncmViewTracks.length) return;
    const now = performance.now();
    if (now < ncmWheelCooldownUntil) return;
    ncmWheelCooldownUntil = now + 28;
    const step = dir > 0 ? 1 : -1;
    const list = $('ncm-card-list');
    let curIdx = ncmViewTracks.findIndex(t => t.id === ncmSelectedTrackId);
    if (curIdx >= 0 && list && list.clientHeight > 0) {
      const curRow = list.querySelector(`.ncm-card-item[data-id="${String(ncmSelectedTrackId).replace(/"/g, '')}"]`);
      if (curRow && Math.abs((curRow.offsetTop + 49 - ncmScrollPos) - list.clientHeight * 0.5) > list.clientHeight * 0.65) {
        curIdx = -1;
      }
    }
    if (curIdx < 0 && list && list.clientHeight > 0) {
      const midY = ncmScrollPos + list.clientHeight * 0.5;
      let bestDist = Infinity;
      const items = list.querySelectorAll('.ncm-card-item');
      for (let i = 0; i < items.length; i++) {
        const d = Math.abs(items[i].offsetTop + 49 - midY);
        if (d < bestDist) { bestDist = d; curIdx = i; }
      }
    }
    if (curIdx < 0) curIdx = 0;
    const nextIdx = Math.max(0, Math.min(ncmViewTracks.length - 1, curIdx + step));
    const targetTr = ncmViewTracks[nextIdx];
    if (!targetTr) return;
    if (targetTr.id !== ncmSelectedTrackId) {
      ncmSelectedTrackId = targetTr.id;
      updateNeteasePlayingRows();
    }
    if (ncmCenterTimer) { clearTimeout(ncmCenterTimer); ncmCenterTimer = 0; }
    const row = list && list.querySelector(`.ncm-card-item[data-id="${String(targetTr.id).replace(/"/g, '')}"]`);
    if (row && list.clientHeight > 0) {
      const card = row.firstElementChild;
      const cardH = (card && card.offsetHeight) || row.offsetHeight || 98;
      ncmScrollTo(row.offsetTop + cardH * 0.5 - list.clientHeight * 0.5, true);
    } else {
      ncmScrollToTrack(targetTr.id, true);
    }
  }

  // 封票+封面合成图路径（每章 idle / active 两张）
  function cardArt(track, active) {
    const m = /([^/\\]+)\.png$/i.exec(track && track.cover ? track.cover : '');
    const base = m ? m[1] : 'cover_act0';
    return 'assets/cards/' + base + (active ? '_active' : '_idle') + '.png';
  }

  // 局部更新选中态与播放态，不销毁 DOM，让卡片大小/金框/层次平滑过渡
  function updateSelectionInPlace() {
    const list = $('track-list');
    const spacer = list && list.firstElementChild;
    if (!spacer) { renderTrackList(); return; }
    const foundVisIdx = visibleRows.findIndex(r => r.idx === selectedIndex);
    const selVisIdx = foundVisIdx >= 0 ? foundVisIdx : 0;
    if (foundVisIdx >= 0) {
      $('stat-idx').textContent = `曲目  ${String(selVisIdx + 1).padStart(2, '0')} / ${String(visibleRows.length).padStart(2, '0')}`;
    }
    const cards = spacer.children;
    for (let i = 0; i < visibleRows.length && i < cards.length; i++) {
      const idx = visibleRows[i].idx;
      const isSelected = idx === selectedIndex;
      const isPlaying = activeSource === 'local' && state.playing && idx === state.trackIndex;
      const card = cards[i];
      card.classList.toggle('selected', isSelected);
      card.classList.toggle('playing', isPlaying);
      card.style.zIndex = String(500 - Math.abs(i - selVisIdx));
      const img = card.querySelector('.card-img');
      if (img) {
        const want = cardArt(visibleRows[i].track, isSelected);
        if (img.getAttribute('src') !== want) img.setAttribute('src', want);
      }
    }
    layoutArcCards(false);
  }

  function renderTrackList() {
    const list = $('track-list');
    list.innerHTML = '';
    visibleRows = getVisibleTracks();
    let selVisIdx = visibleRows.findIndex(r => r.idx === selectedIndex);
    if (selVisIdx < 0 && visibleRows.length) {
      selVisIdx = 0;
      selectedIndex = visibleRows[0].idx;
    }
    selVisIdx = Math.max(0, selVisIdx);
    $('stat-idx').textContent = `曲目  ${String(selVisIdx + 1).padStart(2, '0')} / ${String(visibleRows.length).padStart(2, '0')}`;
    $('stat-total').textContent = `${DATA.tracks.length} 曲 · ${DATA.chapters.length} 章`;

    const listH = list.clientHeight || 820;
    const totalH = Math.max(listH + 20, TOP_PAD + Math.max(0, visibleRows.length - 1) * ROW_STRIDE + listH * 0.55);
    const spacer = document.createElement('div');
    spacer.className = 'track-spacer';
    spacer.style.height = Math.round(totalH) + 'px';

    visibleRows.forEach(({ track, idx }, i) => {
      const isSelected = idx === selectedIndex;
      const isPlaying = activeSource === 'local' && state.playing && idx === state.trackIndex;
      const card = document.createElement('div');
      card.className =
        'track-card' +
        (isSelected ? ' selected' : '') +
        (isPlaying ? ' playing' : '') +
        (track.original ? ' is-original' : '');
      // 距离选中项越近层级越高，严格还原鉴赏器卡片叠压先后关系
      card.style.zIndex = String(500 - Math.abs(i - selVisIdx));
      const subText = (track.actZh && track.actZh !== track.actLabel) ? `${track.actLabel} · ${track.actZh}` : track.actLabel;
      card.innerHTML = `
        <img class="card-img" src="${cardArt(track, isSelected)}" alt="" draggable="false" />
        <div class="track-info">
          <div class="track-name">${escapeHtml(track.title)}</div>
          <div class="track-artist">${escapeHtml(track.artist)}</div>
          <div class="track-sub">${escapeHtml(subText)} &nbsp;&nbsp;&nbsp; ${fmtTime(track.duration)}</div>
        </div>
        <div class="track-orig-badge"></div>
        <span class="track-badge"><span class="eq-bars"><i></i><i></i><i></i></span>正在播放</span>
      `;
      const triggerPlayCard = () => {
        const now = performance.now();
        if (now - lastDblPlayAt < 260) return;
        lastDblPlayAt = now;
        lastCardClick = { idx: -1, time: 0 };
        playScopeChapter = state.chapter;
        selectedIndex = idx;
        selectionLocked = false;
        playTrackAt(idx, true, true);
      };
      card.onclick = () => {
        const now = performance.now();
        if (lastCardClick.idx === idx && (now - lastCardClick.time) < 250) {
          triggerPlayCard();
          return;
        }
        lastCardClick = { idx, time: now };
        selectedIndex = idx;
        centerSelectedCard(true);
        updateSelectionInPlace();
      };
      card.ondblclick = (e) => {
        e.preventDefault();
      };
      spacer.appendChild(card);
    });

    list.appendChild(spacer);
    centerSelectedCard(false);
    layoutArcCards(false);
    requestAnimationFrame(() => {
      centerSelectedCard(false);
      layoutArcCards(false);
    });
  }

  function renderWallpaperCats() {
    const wrap = $('wp-cats');
    if (!wrap) return;
    wrap.innerHTML = '';

    const validCats = new Set(['all', 'imported']);
    const counts = {};
    DATA.wallpapers.forEach(w => {
      if (w.act) {
        counts[w.act] = (counts[w.act] || 0) + 1;
        validCats.add(w.act);
      }
    });
    if (!validCats.has(state.wpCat)) state.wpCat = 'all';

    const addPill = (cat, label) => {
      const btn = document.createElement('button');
      btn.className = 'cat-pill' + (state.wpCat === cat ? ' active' : '');
      btn.dataset.cat = cat;
      btn.textContent = label;
      btn.onclick = () => {
        state.wpCat = cat;
        wrap.querySelectorAll('.cat-pill').forEach(p => p.classList.toggle('active', p.dataset.cat === cat));
        renderWallpaperCats();
        renderWallpaperGrid();
        saveState();
      };
      wrap.appendChild(btn);
    };

    addPill('all', `全部 (${DATA.wallpapers.length})`);
    DATA.chapters.forEach(ch => {
      if (counts[ch.code]) {
        addPill(ch.code, `${ch.label} (${counts[ch.code]})`);
      }
    });
    addPill('imported', counts.imported ? `导入 (${counts.imported})` : '导入');
  }

  function renderWallpaperGrid() {
    const grid = $('wp-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const items = DATA.wallpapers.filter(w => state.wpCat === 'all' || w.act === state.wpCat);
    if (state.wpCat === 'imported' && !items.length) {
      const emptyBox = document.createElement('div');
      emptyBox.className = 'wp-empty-import';
      emptyBox.innerHTML = `
        <div>还没有导入本地或 Wallpaper Engine 壁纸</div>
        <button type="button" class="warm-btn gold" id="btn-wp-empty-import">＋ 立即导入壁纸</button>
      `;
      const btnEmpty = emptyBox.querySelector('#btn-wp-empty-import');
      if (btnEmpty) btnEmpty.onclick = openWpImport;
      grid.appendChild(emptyBox);
      return;
    }
    items.forEach(wp => {
      const card = document.createElement('div');
      const isCurrent = wp.id === state.wallpaperId;
      const isVideo = wp.kind === 'video';
      const isImported = !!wp.imported;
      const unsupported = !!wp.unsupported;
      card.className = 'wp-card' + (isCurrent ? ' active' : '') + (unsupported ? ' unsupported' : '');
      if (unsupported) {
        card.title = wp.unsupportedReason === 'missing'
          ? '导入的源视频已被移动或删除，请重新导入或移除这条记录'
          : '该视频是 HEVC/H.265 或 MOV 等网页内核不支持的格式，请转成 H.264 MP4 或 WebM 后重新导入';
      }
      // 只有真正的多图层动态壁纸（spine）标“动态”，其余 CG 不显示任何角标
      const isDynamic = !!(wp.layers && wp.layers.length) || !!wp.spine;
      const thumbHtml = wp.thumb
        ? `<img src="${escapeHtml(wp.thumb)}" loading="lazy" alt="" />`
        : `<div class="wp-video-ph"><span class="wp-video-play">▶</span><span>视频</span></div>`;
      const badgeHtml = unsupported
        ? `<span class="wp-badge bad">${wp.unsupportedReason === 'missing' ? '文件缺失' : '编码不支持'}</span>`
        : (isVideo
          ? '<span class="wp-badge import">视频</span>'
          : (isImported ? '<span class="wp-badge import">静态</span>' : (isDynamic ? '<span class="wp-badge l2d">动态</span>' : '')));
      const cropBtnHtml = (isImported && !unsupported)
        ? `<button class="wp-crop-btn" type="button" title="调整桌面裁切范围">✂</button>`
        : '';
      const renameHtml = isImported
        ? `<button class="wp-rename" type="button" title="重命名壁纸">✎</button>`
        : '';
      const removeHtml = isImported
        ? `<button class="wp-remove" type="button" title="移除导入（不删除源文件）">✕</button>`
        : '';
      card.innerHTML = `
        <div class="wp-thumb-wrap">
          ${thumbHtml}
          ${badgeHtml}
          ${isCurrent ? '<span class="wp-badge current">当前壁纸</span>' : ''}
          ${cropBtnHtml}
          ${renameHtml}
          ${removeHtml}
        </div>
        <div class="wp-title">${escapeHtml(wp.title)}</div>
      `;
      if (wp.crop) {
        const thumbWrap = card.querySelector('.wp-thumb-wrap');
        const thumbImg = thumbWrap ? thumbWrap.querySelector('img') : null;
        if (thumbImg) {
          const syncThumbCrop = () => applyCropToImgEl(thumbImg, thumbWrap, wp.crop);
          if (thumbImg.complete && thumbImg.naturalWidth) requestAnimationFrame(syncThumbCrop);
          else thumbImg.addEventListener('load', syncThumbCrop, { once: true });
        }
      }
      card.onclick = () => { if (!unsupported) selectWallpaperById(wp.id); };
      if (isImported) {
        const crBtn = card.querySelector('.wp-crop-btn');
        if (crBtn) {
          crBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (unsupported) return;
            if (state.wallpaperId !== wp.id) selectWallpaperById(wp.id);
            openWpCropper(wp.id);
          };
        }
        const rn = card.querySelector('.wp-rename');
        if (rn) {
          rn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const titleEl = card.querySelector('.wp-title');
            if (!titleEl || titleEl.querySelector('input')) return;
            const origTitle = wp.title || '';
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.id = 'inp-wp-rename';
            inp.value = origTitle;
            inp.maxLength = 60;
            inp.style.cssText = 'width:100%;box-sizing:border-box;background:rgba(16,12,8,.94);border:1px solid #d6aa63;border-radius:4px;color:#fbe9c5;padding:2px 6px;font:inherit;outline:none;';
            inp.onclick = (ev) => ev.stopPropagation();
            inp.onmousedown = (ev) => ev.stopPropagation();
            let finished = false;
            const finishRename = async (save) => {
              if (finished) return;
              finished = true;
              const nextTitle = save ? inp.value.trim() : '';
              if (save && nextTitle && nextTitle !== origTitle) {
                try {
                  const r = await fetch(`${NCM_BASE}/api/wp/rename`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: wp.id, title: nextTitle })
                  });
                  const d = await r.json().catch(() => null);
                  if (d && d.ok) wp.title = nextTitle;
                } catch (_) {}
              }
              if (typeof notifyInputFocus === 'function') notifyInputFocus(false, inp);
              titleEl.textContent = wp.title;
            };
            inp.onkeydown = (ev) => {
              if (ev.key === 'Enter') { ev.preventDefault(); finishRename(true); }
              else if (ev.key === 'Escape') { ev.preventDefault(); finishRename(false); }
            };
            inp.onblur = () => finishRename(true);
            titleEl.innerHTML = '';
            titleEl.appendChild(inp);
            inp.focus();
            inp.select();
            if (typeof maybeOpenNativeInput === 'function') maybeOpenNativeInput(inp);
          };
        }
        const rm = card.querySelector('.wp-remove');
        if (rm) {
          rm.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const now = performance.now();
            if (wpRemoveArm.id !== wp.id || now - wpRemoveArm.time > 3000) {
              wpRemoveArm = { id: wp.id, time: now };
              rm.textContent = '确认';
              rm.classList.add('armed');
              rm.title = '再次点击确认移除（不删除源文件）';
              setTimeout(() => {
                if (wpRemoveArm.id === wp.id && performance.now() - wpRemoveArm.time >= 3000) {
                  wpRemoveArm.id = '';
                  rm.textContent = '✕';
                  rm.classList.remove('armed');
                  rm.title = '移除导入（不删除源文件）';
                }
              }, 3200);
              return;
            }
            wpRemoveArm.id = '';
            try {
              await fetch(`${NCM_BASE}/api/wp/remove`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: wp.id })
              });
            } catch (_) {}
            if (state.wpCrops && state.wpCrops[wp.id]) {
              delete state.wpCrops[wp.id];
              saveState();
            }
            await refreshImportedWallpapers();
          };
        }
      }
      grid.appendChild(card);
    });
  }

  function ensureAudioGraph() {
    // 禁用 createMediaElementSource 以免 Wallpaper Engine CEF 对本地 file:// 音频产生 CORS 静音
  }

  function fadeVolumeTo(target, ms, done) {
    if (fadeTimer) clearInterval(fadeTimer);
    const targetAudio = audio;
    if (!targetAudio) {
      fadeTimer = null;
      if (done) done();
      return;
    }
    const start = targetAudio.volume;
    const steps = Math.max(1, Math.round(ms / 16));
    let step = 0;
    fadeTimer = setInterval(() => {
      if (targetAudio !== audio) {
        clearInterval(fadeTimer);
        fadeTimer = null;
        return;
      }
      step++;
      const t = step / steps;
      const ease = t * t * (3 - 2 * t);
      targetAudio.volume = Math.max(0, Math.min(1, start + (target - start) * ease));
      if (step >= steps) {
        clearInterval(fadeTimer);
        fadeTimer = null;
        if (done) done();
      }
    }, 16);
  }

  function getCurrentTrack() {
    if (activeSource === 'ncm' && ncmPlayIndex >= 0 && ncmPlayQueue[ncmPlayIndex]) {
      return ncmPlayQueue[ncmPlayIndex];
    }
    return DATA.tracks[state.trackIndex] || null;
  }

  function updateDefaultTrackBtn() {
    const btn = $('btn-set-default');
    if (!btn) return;
    if (activeSource === 'ncm') {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    const isDef = Number.isInteger(state.defaultTrackIndex) && state.defaultTrackIndex === state.trackIndex;
    btn.classList.toggle('active', isDef);
    btn.textContent = isDef ? '★ 已设为默认' : '☆ 设为默认';
    btn.title = isDef ? '当前曲目已是启动默认播放' : '将当前曲目设为启动默认播放';
  }

  function updateTrackUi() {
    invalidateProgressUiCache();
    const tr = getCurrentTrack();
    if (!tr) return;
    const isNcm = activeSource === 'ncm';
    const coverSrc = tr.cover || 'assets/covers/cover_ending.png';
    let chTitle = '';
    let recMetaText = '';
    if (isNcm) {
      chTitle = `网易云 · ${tr.actZh || '在线播放'}`;
      recMetaText = `${chTitle}   ·   ${String(ncmPlayIndex + 1).padStart(2, '0')} / ${String(ncmPlayQueue.length).padStart(2, '0')}`;
    } else {
      const chRows = getChapterTracks(tr.act);
      const pos = Math.max(1, chRows.findIndex(x => x.idx === state.trackIndex) + 1);
      chTitle = (tr.actZh && tr.actZh !== tr.actLabel) ? `${tr.actLabel} · ${tr.actZh}` : tr.actLabel;
      recMetaText = `${chTitle}   ·   ${String(pos).padStart(2, '0')} / ${String(chRows.length).padStart(2, '0')}`;
    }

    $('cap-cover').src = coverSrc;
    $('cap-title').textContent = tr.title;
    $('cap-act').textContent = chTitle;

    $('vinyl-cover').src = coverSrc;
    $('rec-title').textContent = tr.title;
    $('rec-artist').textContent = tr.artist;
    $('rec-chapter').textContent = recMetaText;
    $('now-title').textContent = tr.title;
    $('now-badge').textContent = audioError || (state.playing ? (isNcm ? '网易云在线' : '正在播放') : '当前曲目');

    $('btn-play').textContent = state.playing ? '❚❚ 暂停' : '▶ 播放';
    $('btn-cap-play').textContent = state.playing ? '❚❚' : '▶';
    $('vinyl-disc').classList.toggle('playing', state.playing);
    $('cap-disc').classList.toggle('playing', state.playing);

    // 网易云视图：唱片中心 / 曲目信息只在网易云曲目占主导时更新
    if (isNcm) {
      const reqLabel = NCM_LEVEL_LABEL[state.ncmLevel] || '极高';
      const actLabel = NCM_LEVEL_LABEL[tr.ncmResolvedLevel] || reqLabel;
      const ncmLevelLabel = (tr.ncmResolvedLevel && tr.ncmResolvedLevel !== state.ncmLevel)
        ? `${actLabel}（${reqLabel}不可用）` : reqLabel;
      if ($('ncm-vinyl-cover')) $('ncm-vinyl-cover').src = coverSrc;
      if ($('ncm-rec-title')) $('ncm-rec-title').textContent = tr.title;
      if ($('ncm-rec-artist')) $('ncm-rec-artist').textContent = tr.artist || '未知艺术家';
      if ($('ncm-rec-chapter')) $('ncm-rec-chapter').textContent = recMetaText;
      if ($('ncm-now-title')) $('ncm-now-title').textContent = tr.title;
      if ($('ncm-now-badge')) $('ncm-now-badge').textContent = audioError || (state.playing ? `网易云 · ${ncmLevelLabel}` : `网易云 · ${ncmLevelLabel}（暂停）`);
    }
    if ($('btn-ncm-play')) $('btn-ncm-play').textContent = (isNcm && state.playing) ? '❚❚ 暂停' : '▶ 播放';
    if ($('ncm-vinyl-disc')) $('ncm-vinyl-disc').classList.toggle('playing', !!isNcm && state.playing);

    syncCardCover(coverSrc);
    syncCardDynamicState();
    if ($('cp-title')) $('cp-title').textContent = tr.title;
    if ($('cp-sub')) $('cp-sub').textContent = `${tr.artist} · ${chTitle}`;
    if ($('btn-cp-play')) $('btn-cp-play').textContent = state.playing ? '❚❚ 暂停' : '▶ 播放';
    renderCardPlayerDots();

    updateDefaultTrackBtn();
    if (typeof updateNeteasePlayingRows === 'function') updateNeteasePlayingRows();
    updateNcmLikeUi();
  }

  function bindAutoplayUnlock() {
    if (autoplayUnlockBound) return;
    autoplayUnlockBound = true;
    const unlock = () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      autoplayUnlockBound = false;
      if (audio && audio.paused && !state.playing) {
        audio.volume = 0;
        audio.play().then(() => {
          state.playing = true;
          audioError = '';
          fadeVolumeTo(state.volume, 420);
          updateTrackUi();
          updateSelectionInPlace();
        }).catch(() => {});
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  function playTrackAt(idx, autoplay, syncFocus) {
    if (!DATA.tracks.length) return;
    // 发布包可设置 window.NIENTUM_NO_LOCAL_MUSIC=true（不含 88 首本地歌曲时）
    if (window.NIENTUM_NO_LOCAL_MUSIC) {
      state.playing = false;
      audioError = '本地曲库未随包提供，请使用网易云在线播放';
      updateTrackUi();
      return;
    }
    activeSource = 'local';
    if (state.loopMode === 'daily') {
      state.loopMode = 'list';
      updateLoopUi();
      saveState();
    }
    updateDesktopLyric(0);
    idx = (idx + DATA.tracks.length) % DATA.tracks.length;
    state.trackIndex = idx;
    if (syncFocus) selectedIndex = idx;
    const tr = DATA.tracks[idx];
    syncWallpaperToAct(tr.act);
    updateTrackUi();

    const finishUi = (smooth) => {
      updateTrackUi();
      if (syncFocus && visibleRows.some(r => r.idx === idx)) {
        selectedIndex = idx;
        updateSelectionInPlace();
        centerSelectedCard(smooth);
      } else {
        updateSelectionInPlace();
      }
    };

    const startNew = () => {
      createAudioElement();
      syncAudioLoopAttr();
      autoEndedGuard = false;
      if (autoSkipTimer) { clearTimeout(autoSkipTimer); autoSkipTimer = 0; }
      const cands = resolveMusicCandidates(tr.src);
      localAudioRetryState = { cands, idx: 0, autoplay: !!autoplay, syncFocus: !!syncFocus };
      audio.src = encodeURI(cands[0]);
      if (autoplay) {
        ensureAudioGraph();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        audio.volume = 0;
        audio.play().then(() => {
          localAudioRetryState = null;
          autoSkipCount = 0;
          autoAdvancing = false;
          const m = /^(.*\/)(?:Act\d+|ActT|ActU|其他|未分类)\//i.exec(decodeURI(cands[0]));
          if (m) detectedMusicPrefix = m[1];
          state.playing = true;
          audioError = '';
          fadeVolumeTo(state.volume, 480);
          finishUi(!!syncFocus);
        }).catch((err) => {
          state.playing = false;
          if (err && err.name === 'NotAllowedError') {
            audioError = '';
            bindAutoplayUnlock();
            finishUi(false);
          } else if (localAudioRetryState && localAudioRetryState.idx + 1 < localAudioRetryState.cands.length) {
            tryNextMusicCandidate();
          } else {
            audioError = '未找到本地音乐文件（请放入 音乐/ 或 assets/music/）';
            finishUi(false);
            scheduleAutoSkip();
          }
        });
      } else {
        audio.volume = state.volume;
        state.playing = false;
        finishUi(false);
      }
      saveState();
    };

    function tryNextMusicCandidate() {
      if (!localAudioRetryState) return false;
      localAudioRetryState.idx++;
      if (localAudioRetryState.idx >= localAudioRetryState.cands.length) return false;
      const nextSrc = localAudioRetryState.cands[localAudioRetryState.idx];
      audio.src = encodeURI(nextSrc);
      audio.currentTime = 0;
      if (localAudioRetryState.autoplay) {
        audio.play().then(() => {
          const m = /^(.*\/)(?:Act\d+|ActT|ActU|其他|未分类)\//i.exec(decodeURI(nextSrc));
          if (m) detectedMusicPrefix = m[1];
          localAudioRetryState = null;
          state.playing = true;
          audioError = '';
          fadeVolumeTo(state.volume, 480);
          finishUi(!!syncFocus);
        }).catch(() => {
          if (!tryNextMusicCandidate()) {
            state.playing = false;
            audioError = '未找到本地音乐文件（请放入 音乐/ 或 assets/music/）';
            finishUi(false);
          }
        });
      }
      return true;
    }

    if (state.playing && !audio.paused) {
      fadeVolumeTo(0, 320, startNew);
    } else {
      startNew();
    }
  }

  function togglePlay() {
    if (!audio.src) {
      playTrackAt(state.trackIndex, true, true);
      return;
    }
    if (audio.paused) {
      ensureAudioGraph();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      audio.volume = 0;
      audio.play().then(() => {
        state.playing = true;
        audioError = '';
        fadeVolumeTo(state.volume, 420);
        updateTrackUi();
        updateSelectionInPlace();
      }).catch((err) => {
        state.playing = false;
        audioError = '音频加载失败';
        console.warn('[Nientum] resume failed:', err && err.name, err && err.message,
                     '| mediaError=', audio.error && audio.error.code, '| src=', audio.src);
        updateTrackUi();
        updateSelectionInPlace();
      });
    } else {
      fadeVolumeTo(0, 380, () => {
        audio.pause();
        state.playing = false;
        updateTrackUi();
        updateSelectionInPlace();
      });
    }
  }

  function getPlayQueue() {
    if (playScopeChapter && playScopeChapter !== 'ALL') {
      const chQueue = getChapterTracks(playScopeChapter).map(x => x.idx);
      if (chQueue.length && chQueue.includes(state.trackIndex)) return chQueue;
    }
    return DATA.tracks.map((_, i) => i);
  }

  function ncmStreamUrl(tr, forceRefresh, levelOverride) {
    const id = tr.ncmId || String(tr.id || '').replace(/^ncm_/, '');
    const cand = levelOverride || tr.ncmResolvedLevel || state.ncmLevel;
    const level = NCM_LEVELS.includes(cand) ? cand : 'exhigh';
    return `${NCM_BASE}/api/song/stream?id=${encodeURIComponent(id)}&level=${level}${forceRefresh ? '&refresh=1&_t=' + Date.now() : ''}`;
  }

  function parseLrc(text) {
    if (!text) return [];
    const lines = [];
    // 兼容网易云两种时间戳：[mm:ss.xx] 与 [mm:ss:xx]（冒号分隔百分秒），以及 [mm:ss.xx-1] 后缀
    const tagRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?(?:-\d+)?\]/g;
    for (const raw of String(text).split(/\r?\n/)) {
      const matches = [...raw.matchAll(tagRe)];
      if (!matches.length) continue;
      const content = raw.replace(tagRe, '').trim();
      if (!content) continue;
      for (const m of matches) {
        const min = Number(m[1]) || 0;
        const sec = Number(m[2]) || 0;
        const msStr = m[3] || '0';
        const ms = Number(msStr.padEnd(3, '0').slice(0, 3)) || 0;
        lines.push({ time: min * 60 + sec + ms / 1000, text: content });
      }
    }
    lines.sort((a, b) => a.time - b.time);
    return lines;
  }

  async function loadNeteaseLyric(tr) {
    const id = tr.ncmId || String(tr.id || '').replace(/^ncm_/, '');
    ncmLyricSongId = id;
    ncmLyricLines = [];
    ncmLyricActiveIdx = -2;
    updateDesktopLyric(0);
    if (!id) return;
    try {
      const res = await ncmApi(`/api/song/lyric?id=${encodeURIComponent(id)}`);
      if (ncmLyricSongId !== id) return;
      const orig = parseLrc(res && res.lrc);
      const trans = parseLrc(res && res.tlyric);
      if (orig.length && trans.length) {
        let j = 0;
        for (const line of orig) {
          while (j + 1 < trans.length && trans[j + 1].time <= line.time + 0.4) j++;
          if (trans[j] && Math.abs(trans[j].time - line.time) <= 0.45) {
            line.sub = trans[j].text;
          }
        }
      }
      ncmLyricLines = orig;
      ncmLyricActiveIdx = -2;
      updateDesktopLyric(audio ? (audio.currentTime || 0) : 0);
    } catch (_) {}
  }

  let lyricBoxEl = null, lyricMainEl = null, lyricSubEl = null;
  function updateDesktopLyric(curTime) {
    if (!lyricBoxEl) {
      lyricBoxEl = $('desktop-lyric-box');
      lyricMainEl = $('desktop-lyric-main');
      lyricSubEl = $('desktop-lyric-sub');
    }
    const box = lyricBoxEl, mainEl = lyricMainEl, subEl = lyricSubEl;
    if (!box || !mainEl || !subEl) return;
    if (activeSource !== 'ncm' || state.ncmLyricEnabled === false || !ncmLyricLines.length) {
      if (ncmLyricActiveIdx !== -2) {
        ncmLyricActiveIdx = -2;
        box.classList.remove('show');
        mainEl.textContent = '';
        subEl.textContent = '';
      }
      return;
    }
    let idx = -1;
    for (let i = 0; i < ncmLyricLines.length; i++) {
      if (ncmLyricLines[i].time <= curTime + 0.15) idx = i;
      else break;
    }
    if (idx < 0) {
      if (box.classList.contains('show')) box.classList.remove('show');
      return;
    }
    if (!box.classList.contains('show')) box.classList.add('show');
    if (idx !== ncmLyricActiveIdx) {
      ncmLyricActiveIdx = idx;
      mainEl.textContent = ncmLyricLines[idx].text || '';
      subEl.textContent = ncmLyricLines[idx].sub || '';
      fitDesktopLyric();
    }
  }

  // 大字号歌词遇到超长句时自动逐级缩到能完整放下，避免竖排被裁掉
  let lyricFitTimer = 0;
  function fitDesktopLyric() {
    const box = lyricBoxEl, mainEl = lyricMainEl, subEl = lyricSubEl;
    if (!box || !mainEl || !subEl || !box.classList.contains('show')) return;
    mainEl.style.fontSize = '';
    subEl.style.fontSize = '';
    const cs = getComputedStyle(box);
    const avail = box.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (avail <= 0) return;
    const gap = parseFloat(cs.columnGap || cs.gap) || 0;
    let size = parseFloat(getComputedStyle(mainEl).fontSize) || 34;
    const base = size;
    for (let i = 0; i < 30; i++) {
      const need = mainEl.scrollWidth + ((subEl.textContent || '').trim() ? subEl.scrollWidth + gap : 0);
      if (need <= avail + 1 || size <= 18) break;
      size -= 1;
      mainEl.style.fontSize = size + 'px';
      subEl.style.fontSize = Math.max(12, Math.round(size * 0.58)) + 'px';
    }
    if (size >= base) {
      mainEl.style.fontSize = '';
      subEl.style.fontSize = '';
    }
  }
  window.addEventListener('resize', () => {
    clearTimeout(lyricFitTimer);
    lyricFitTimer = setTimeout(fitDesktopLyric, 120);
  });

  function clearNcmReconnect() {
    if (ncmReconnectTimer) {
      clearTimeout(ncmReconnectTimer);
      ncmReconnectTimer = 0;
    }
    ncmStallRecovering = false;
  }

  function attemptNeteaseReconnect(reason) {
    if (ncmStallRecovering || activeSource !== 'ncm' || !ncmPlayQueue[ncmPlayIndex]) return;
    const tr = ncmPlayQueue[ncmPlayIndex];
    const targetId = tr.id;
    const targetLevel = tr.ncmResolvedLevel || ncmActiveLevel || state.ncmLevel;
    const resumeTime = (audio && isFinite(audio.currentTime) && audio.currentTime > 0.5)
      ? audio.currentTime
      : (ncmLastKnownTime > 0.5 ? ncmLastKnownTime : (ncmPendingSeek > 0.5 ? ncmPendingSeek : 0));
    if (resumeTime > 0.5) ncmLastKnownTime = resumeTime;

    if (ncmReconnectCount >= 4) {
      clearNcmReconnect();
      ncmReconnectCount = 0;
      ncmStallRetryCount = 0;
      state.playing = false;
      audioError = '网易云加载失败（已自动重连4次）';
      updateTrackUi();
      updateNeteasePlayingRows();
      if (autoAdvancing && autoSkipCount < 5) scheduleAutoSkip();
      return;
    }

    ncmReconnectCount++;
    ncmStallRetryCount = ncmReconnectCount;
    ncmStallRecovering = true;
    const delayMs = Math.min(2800, 550 * ncmReconnectCount);
    audioError = `连接中断，正在第 ${ncmReconnectCount} 次重连...`;
    updateTrackUi();

    if (ncmReconnectTimer) clearTimeout(ncmReconnectTimer);
    ncmReconnectTimer = setTimeout(() => {
      ncmReconnectTimer = 0;
      if (activeSource !== 'ncm' || !ncmPlayQueue[ncmPlayIndex] || ncmPlayQueue[ncmPlayIndex].id !== targetId) {
        ncmStallRecovering = false;
        return;
      }
      ncmPendingSeek = ncmLastKnownTime > 0.5 ? ncmLastKnownTime : 0;
      createAudioElement();
      syncAudioLoopAttr();
      autoEndedGuard = false;
      ncmLastTime = -1;
      ncmLastBufferedEnd = 0;
      ncmLastProgressAt = performance.now();
      audio.src = ncmStreamUrl(tr, true, targetLevel);
      ensureAudioGraph();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      audio.volume = state.volume;
      audio.play().then(() => {
        if (activeSource !== 'ncm' || !ncmPlayQueue[ncmPlayIndex] || ncmPlayQueue[ncmPlayIndex].id !== targetId) return;
        ncmStallRecovering = false;
        ncmReconnectCount = 0;
        ncmStallRetryCount = 0;
        ncmLastProgressAt = performance.now();
        autoSkipCount = 0;
        autoAdvancing = false;
        state.playing = true;
        audioError = '';
        updateTrackUi();
        updateNeteasePlayingRows();
      }).catch((err) => {
        ncmStallRecovering = false;
        ncmLastProgressAt = performance.now();
        if (err && err.name === 'NotAllowedError') {
          state.playing = false;
          audioError = '';
          bindAutoplayUnlock();
          updateTrackUi();
          return;
        }
        attemptNeteaseReconnect('retry_play_err');
      });
    }, delayMs);
  }

  function recoverNeteaseStall() {
    attemptNeteaseReconnect('stalled');
  }

  async function resolveNcmMeta(tr) {
    try {
      const req = state.ncmLevel;
      const id = tr.ncmId || String(tr.id || '').replace(/^ncm_/, '');
      const res = await ncmApi(`/api/song/resolve?id=${encodeURIComponent(id)}&level=${req}`);
      if (res && res.resolved && res.resolved.level) {
        tr.ncmResolvedLevel = res.resolved.level;
        if (activeSource === 'ncm' && ncmPlayQueue[ncmPlayIndex] && ncmPlayQueue[ncmPlayIndex].id === tr.id) {
          updateTrackUi();
        }
      }
    } catch (_) {}
  }

  function playNeteaseAt(idx, queueOverride) {
    if (queueOverride) {
      ncmPlayQueue = queueOverride.slice();
    }
    if (!ncmPlayQueue.length) return;
    if (ncmCenterTimer) { clearTimeout(ncmCenterTimer); ncmCenterTimer = 0; }
    activeSource = 'ncm';
    idx = (idx + ncmPlayQueue.length) % ncmPlayQueue.length;
    ncmPlayIndex = idx;
    const tr = ncmPlayQueue[idx];
    ncmSelectedTrackId = tr.id;
    clearNcmReconnect();
    ncmReconnectCount = 0;
    ncmStallRetryCount = 0;
    if (!ncmPendingSeek) ncmLastKnownTime = 0;
    ncmActiveLevel = state.ncmLevel;
    tr.ncmResolvedLevel = '';
    resolveNcmMeta(tr);
    loadNeteaseLyric(tr);
    audioError = '';
    updateTrackUi();
    updateSelectionInPlace();
    updateNeteasePlayingRows();
    ncmScrollToTrack(tr.id, true);
    loadNcmLiked();

    const startNew = () => {
      createAudioElement();
      syncAudioLoopAttr();
      autoEndedGuard = false;
      ncmLastTime = -1;
      ncmLastBufferedEnd = 0;
      ncmLastProgressAt = performance.now();
      ncmStallRetryCount = 0;
      ncmStallRecovering = false;
      if (autoSkipTimer) { clearTimeout(autoSkipTimer); autoSkipTimer = 0; }
      audio.src = ncmStreamUrl(tr, false, ncmActiveLevel);
      ensureAudioGraph();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      audio.volume = 0;
      audio.play().then(() => {
        ncmReconnectCount = 0;
        autoSkipCount = 0;
        autoAdvancing = false;
        state.playing = true;
        audioError = '';
        fadeVolumeTo(state.volume, 480);
        updateTrackUi();
        updateNeteasePlayingRows();
        ncmScrollToTrack(tr.id);
      }).catch((err) => {
        if (err && err.name === 'NotAllowedError') {
          state.playing = false;
          audioError = '';
          bindAutoplayUnlock();
          updateTrackUi();
          updateNeteasePlayingRows();
          return;
        }
        attemptNeteaseReconnect('initial_play_err');
      });
    };

    if (state.playing && !audio.paused) {
      fadeVolumeTo(0, 320, startNew);
    } else {
      startNew();
    }
  }

  // 与自由选曲相同：滚轮/定位只改目标值，再用 0.13 的缓动逐帧追过去。
  function ncmMaxScroll() {
    const list = $('ncm-card-list');
    if (!list) return 0;
    return Math.max(0, list.scrollHeight - list.clientHeight);
  }

  function ncmStopScroll() {
    if (ncmScrollRaf) {
      cancelAnimationFrame(ncmScrollRaf);
      ncmScrollRaf = 0;
    }
  }

  function stepNcmScroll() {
    const list = $('ncm-card-list');
    if (!list) { ncmScrollRaf = 0; return; }
    const diff = ncmScrollTarget - ncmScrollPos;
    if (Math.abs(diff) < 0.6) {
      ncmScrollPos = ncmScrollTarget;
      list.scrollTop = ncmScrollPos;
      ncmScrollRaf = 0;
      layoutNcmArc();
      return;
    }
    ncmScrollPos += diff * 0.13;
    list.scrollTop = ncmScrollPos;
    layoutNcmArc();
    ncmScrollRaf = requestAnimationFrame(stepNcmScroll);
  }

  function ncmScrollTo(value, smooth) {
    const list = $('ncm-card-list');
    if (!list) return;
    const top = Math.max(0, Math.min(ncmMaxScroll(), value));
    if (smooth === false) {
      ncmStopScroll();
      ncmScrollPos = ncmScrollTarget = top;
      list.scrollTop = top;
      layoutNcmArc();
      return;
    }
    ncmScrollTarget = top;
    if (!ncmScrollRaf) ncmScrollRaf = requestAnimationFrame(stepNcmScroll);
  }

  // 把当前歌曲的封票滚到列表垂直中线。单击选中、双击播放、切歌、打开网易云页都会调用。
  function ncmScrollToTrack(id, smooth) {
    const list = $('ncm-card-list');
    if (!list || !id) return;
    const row = list.querySelector(`.ncm-card-item[data-id="${String(id).replace(/"/g, '')}"]`);
    if (!row) return;

    if (ncmCenterRaf) cancelAnimationFrame(ncmCenterRaf);
    // 新渲染的列表要等两帧，确保 offsetHeight/滚动范围已经稳定
    ncmCenterRaf = requestAnimationFrame(() => {
      ncmCenterRaf = requestAnimationFrame(() => {
        ncmCenterRaf = 0;
        if (!row.isConnected) return;
        // 用布局单位（offsetTop/clientHeight），不要用 getBoundingClientRect：
        // 剧场外壳用了 Chromium 原生 zoom，rect 会被缩放，和 scrollTop 的单位不一致。
        const listH = list.clientHeight;
        if (listH <= 0) return;
        // 卡片实际高度 134/148，取卡片中线而不是 98px 的行中线
        const card = row.firstElementChild;
        const cardH = (card && card.offsetHeight) || row.offsetHeight || 98;
        ncmScrollTo(row.offsetTop + cardH * 0.5 - listH * 0.5, smooth !== false);
      });
    });
  }

  function scheduleAutoSkip() {
    if (!autoAdvancing || autoSkipCount >= 5) return;
    if (autoSkipTimer) return;
    autoSkipCount++;
    autoSkipTimer = setTimeout(() => {
      autoSkipTimer = 0;
      stepTrack(1, true);
    }, 200);
  }

  function stepTrack(delta, fromEnded) {
    if (fromEnded) {
      autoAdvancing = true;
    } else {
      autoAdvancing = false;
      autoSkipCount = 0;
    }
    if (activeSource === 'ncm' && ncmPlayQueue.length) {
      if (fromEnded && state.loopMode === 'single') {
        audio.currentTime = 0;
        audio.volume = 0;
        state.playing = true;
        audio.play().then(() => fadeVolumeTo(state.volume, 360)).catch(() => {});
        updateTrackUi();
        return;
      }
      if (state.loopMode === 'shuffle') {
        if (delta < 0 && ncmShuffleHistory.length) {
          const prev = ncmShuffleHistory.pop();
          if (prev >= 0 && prev < ncmPlayQueue.length) {
            playNeteaseAt(prev);
            return;
          }
        }
        if (ncmPlayQueue.length > 1) {
          let next = ncmPlayIndex;
          let guard = 0;
          while (next === ncmPlayIndex && guard++ < 20) {
            next = Math.floor(Math.random() * ncmPlayQueue.length);
          }
          if (delta > 0) {
            ncmShuffleHistory.push(ncmPlayIndex);
            if (ncmShuffleHistory.length > 50) ncmShuffleHistory.shift();
          }
          playNeteaseAt(next);
          return;
        }
      }
      const pos = Math.max(0, ncmPlayIndex);
      if (fromEnded && (state.loopMode === 'order' || state.loopMode === 'daily') && pos >= ncmPlayQueue.length - 1) {
        audio.pause();
        audio.currentTime = 0;
        state.playing = false;
        updateTrackUi();
        return;
      }
      const nextPos = (pos + delta + ncmPlayQueue.length) % ncmPlayQueue.length;
      playNeteaseAt(nextPos);
      return;
    }

    const queue = getPlayQueue();
    if (!queue.length) return;

    if (fromEnded && state.loopMode === 'single') {
      audio.currentTime = 0;
      audio.volume = 0;
      state.playing = true;
      audio.play().then(() => fadeVolumeTo(state.volume, 360)).catch(() => {});
      updateTrackUi();
      return;
    }

    if (state.loopMode === 'shuffle') {
      if (delta < 0 && shuffleHistory.length) {
        const prev = shuffleHistory.pop();
        if (prev >= 0 && prev < DATA.tracks.length) {
          playTrackAt(prev, true, true);
          return;
        }
      }
      if (queue.length > 1) {
        let next = state.trackIndex;
        let guard = 0;
        while (next === state.trackIndex && guard++ < 20) {
          next = queue[Math.floor(Math.random() * queue.length)];
        }
        if (delta > 0) {
          shuffleHistory.push(state.trackIndex);
          if (shuffleHistory.length > 50) shuffleHistory.shift();
        }
        playTrackAt(next, true, true);
        return;
      }
    }

    const pos = Math.max(0, queue.indexOf(state.trackIndex));
    if (fromEnded && state.loopMode === 'order' && pos >= queue.length - 1) {
      audio.pause();
      audio.currentTime = 0;
      state.playing = false;
      updateTrackUi();
      updateSelectionInPlace();
      return;
    }

    const nextPos = (pos + delta + queue.length) % queue.length;
    playTrackAt(queue[nextPos], true, !fromEnded || visibleRows.some(r => r.idx === queue[nextPos]));
  }

  function syncAudioLoopAttr() {
    if (audio) audio.loop = (state.loopMode === 'single');
  }

  function updateLoopUi() {
    syncAudioLoopAttr();
    const meta = LOOP_META[state.loopMode] || LOOP_META.list;
    if ($('btn-loop')) {
      $('btn-loop').innerHTML = `${meta.svg}<span>${meta.label}</span>`;
      $('btn-loop').title = `当前：${meta.label}（点击切换）`;
    }
    if ($('btn-cap-loop')) {
      $('btn-cap-loop').innerHTML = meta.svg;
      $('btn-cap-loop').title = `循环模式：${meta.label}（点击切换）`;
    }
    if ($('btn-cp-loop')) {
      $('btn-cp-loop').innerHTML = `${meta.svg}<span>${meta.label}</span>`;
      $('btn-cp-loop').title = `当前：${meta.label}（点击切换）`;
    }
    if ($('btn-ncm-loop')) {
      $('btn-ncm-loop').innerHTML = `${meta.svg}<span>${meta.label}</span>`;
      $('btn-ncm-loop').title = `当前：${meta.label}（点击切换）`;
    }
  }

  function cycleLoopMode() {
    const curIdx = LOOP_ORDER.indexOf(state.loopMode);
    state.loopMode = LOOP_ORDER[(curIdx + 1) % LOOP_ORDER.length];
    updateLoopUi();
    saveState();
  }

  function revertDailyMode(msg) {
    state.loopMode = 'list';
    updateLoopUi();
    saveState();
    if (msg) ncmListMessage(msg);
  }

  async function loadDailyRecommendations() {
    if (!ncmConnected) {
      revertDailyMode('每日推荐需要内置网易云代理已连接，请稍等或点「刷新状态」');
      return;
    }
    if (!ncmLoggedIn) {
      revertDailyMode('每日推荐需要先登录网易云；已切回列表循环');
      return;
    }
    ncmListMessage('正在获取每日推荐...');
    try {
      const res = await ncmApi('/api/recommend');
      const tracks = (res && Array.isArray(res.tracks)) ? res.tracks : [];
      if (!res || !res.ok || !tracks.length) {
        revertDailyMode((res && res.error) || '每日推荐为空，请稍后重试');
        return;
      }
      ncmActivePlaylistId = 'daily';
      renderNeteaseTracks('每日推荐', tracks);
      ncmSelectedTrackId = tracks[0].id;
      playNeteaseAt(0, tracks);
    } catch (_) {
      revertDailyMode('每日推荐获取失败：请确认已登录网易云并点「刷新状态」');
    }
  }

  function cycleNcmLoopMode() {
    const curIdx = NCM_LOOP_ORDER.indexOf(state.loopMode);
    state.loopMode = NCM_LOOP_ORDER[(curIdx + 1) % NCM_LOOP_ORDER.length];
    updateLoopUi();
    saveState();
    if (state.loopMode === 'daily') loadDailyRecommendations();
  }

  function cycleLoopForActiveSource() {
    if (activeSource === 'ncm') cycleNcmLoopMode();
    else cycleLoopMode();
  }

  function leaveDailyModeIfNeeded() {
    if (state.loopMode === 'daily') {
      state.loopMode = 'list';
      updateLoopUi();
      saveState();
    }
  }

  const HALO_N = 72;
  const HALO_SIN = new Float32Array(HALO_N);
  const HALO_COS = new Float32Array(HALO_N);
  const HALO_LEN = new Float32Array(HALO_N);
  const FOOT_N = 48;
  const FOOT_BH = new Float32Array(FOOT_N);
  for (let i = 0; i < HALO_N; i++) {
    const ang = (Math.PI * 2 * i) / HALO_N;
    HALO_SIN[i] = Math.sin(ang);
    HALO_COS[i] = -Math.cos(ang);
  }

  let progRefs = null;
  let lastProgSec = -1;
  let lastProgDur = -1;
  let lastProgPct = -1;
  let lastProgModeKey = '';
  let lastVinylScale = '';
  let vizCanvasEl = null;
  let vizCtx2d = null;
  let vizWasCleared = false;
  let lastVizDrawAt = 0;
  let cachedCpCenter = null;

  // ===== 桌面卡片动效：播放时在标准位置周期漂移 + 鼠标悬停轻微倾斜 =====
  // 漂移幅度 = 卡片左缘与左侧歌词栏间距的 1/4（四个方向相同），保证不会碰到歌词栏；
  // 暂停时冻结相位、包络平滑衰减到 0，使卡片沿直线缓缓回到标准位置。
  const CARD_TILT_MAX = 0.4;      // 悬停最大倾斜角（度）
  const CARD_FLOAT_PX = 9.0;      // 水平漂移周期（秒）
  const CARD_FLOAT_PY = 6.6;      // 垂直漂移周期（秒），与水平周期错开形成柔和的李萨如轨迹
  const cardMotion = {
    wrap: null, card: null, bound: false,
    amp: -1,                       // 漂移幅度 px（-1 = 待测量）
    env: 0,                        // 漂移包络：播放 → 1，暂停 → 0
    phase: 0,                      // 漂移相位时间，仅播放时推进
    ox: 0, oy: 0,                  // 当前漂移偏移 px
    rx: 0, ry: 0, trx: 0, try_: 0, // 当前 / 目标倾斜角
    gx: 32, gy: 16, tgx: 32, tgy: 16, // 玻璃高光位置（%）
    lastAt: 0, lastWrapT: null, lastCardT: null, lastGlare: ''
  };

  function measureCardFloatAmp() {
    const wrap = cardMotion.wrap;
    if (!wrap) return -1;
    const wr = wrap.getBoundingClientRect();
    if (!wr || wr.width <= 0) return -1;
    const baseLeft = wr.left - cardMotion.ox;  // 扣除当前偏移，得到标准位置左缘
    let gap = 14;                              // 与 CSS 中侧栏 right 公式的 14px 间距一致，作为兜底
    const side = $('desktop-side-panel');
    if (side) {
      const sr = side.getBoundingClientRect();
      if (sr && sr.width > 0) gap = baseLeft - sr.right;
    }
    return Math.max(0, gap * 0.25);  // 歌词栏间距的 1/4（原 1/2 再减半）
  }

  function getCardTiltFactor() {
    const v = Number(state.cardTilt);
    return Number.isFinite(v) ? Math.max(0, Math.min(5, v)) : 1;
  }

  function bindCardTilt() {
    const card = cardMotion.card;
    if (!card || cardMotion.bound) return;
    cardMotion.bound = true;
    card.addEventListener('mousemove', (e) => {
      const factor = getCardTiltFactor();
      if (factor <= 0) {
        cardMotion.trx = 0;
        cardMotion.try_ = 0;
        return;
      }
      // 使用布局尺寸 + 漂移偏移推算标准矩形，避免倾斜后的投影矩形导致抖动
      const r = card.getBoundingClientRect();
      const w = card.offsetWidth || r.width || 1;
      const h = card.offsetHeight || r.height || 1;
      const left = r.left + (r.width - w) * 0.5;
      const top = r.top + (r.height - h) * 0.5;
      const nx = Math.max(0, Math.min(1, (e.clientX - left) / w));
      const ny = Math.max(0, Math.min(1, (e.clientY - top) / h));
      // 鼠标所在一侧轻微“按下”远离视线
      const maxTilt = CARD_TILT_MAX * factor;
      cardMotion.trx = (0.5 - ny) * 2 * maxTilt;
      cardMotion.try_ = (nx - 0.5) * 2 * maxTilt;
    });
    card.addEventListener('mouseleave', () => {
      cardMotion.trx = 0;
      cardMotion.try_ = 0;
    });
  }

  function stepCardMotion(nowMs) {
    const now = nowMs || performance.now();
    const dt = cardMotion.lastAt ? Math.max(0, Math.min(0.1, (now - cardMotion.lastAt) / 1000)) : 0.016;
    cardMotion.lastAt = now;

    if (!cardMotion.wrap) {
      cardMotion.wrap = document.querySelector('#desktop-card-stage .cp-card-wrap');
      cardMotion.card = $('cp-card');
      bindCardTilt();
    }
    const wrap = cardMotion.wrap;
    const card = cardMotion.card;
    if (!wrap || !card) return;

    const active = document.body.classList.contains('desktop-card-mode') && state.uiMode !== 'theater';
    if (!active) {
      // 不在卡片模式：立即归位并停止写 DOM
      cardMotion.env = 0; cardMotion.ox = 0; cardMotion.oy = 0;
      cardMotion.rx = 0; cardMotion.ry = 0; cardMotion.trx = 0; cardMotion.try_ = 0;
      cardMotion.amp = -1;
      if (cardMotion.lastWrapT !== '') { wrap.style.transform = ''; cardMotion.lastWrapT = ''; }
      if (cardMotion.lastCardT !== '') { card.style.transform = ''; cardMotion.lastCardT = ''; }
      return;
    }

    const playing = !!(state.playing && audio && !audio.paused);
    // 包络：起播约 1.5s 渐入，暂停约 1.2s 平滑回到标准位置
    const kEnv = 1 - Math.exp(-dt / (playing ? 0.55 : 0.4));
    cardMotion.env += ((playing ? 1 : 0) - cardMotion.env) * kEnv;
    if (!playing && cardMotion.env < 0.002) cardMotion.env = 0;
    if (playing) cardMotion.phase += dt;

    if (cardMotion.amp < 0) cardMotion.amp = measureCardFloatAmp();
    const A = Math.max(0, cardMotion.amp) * cardMotion.env;
    const p = cardMotion.phase;
    cardMotion.ox = A * Math.sin(p * (Math.PI * 2 / CARD_FLOAT_PX));
    cardMotion.oy = A * Math.sin(p * (Math.PI * 2 / CARD_FLOAT_PY) + 0.9);

    if (getCardTiltFactor() <= 0) {
      cardMotion.trx = 0;
      cardMotion.try_ = 0;
    }

    const kT = 1 - Math.exp(-dt / 0.13);
    cardMotion.rx += (cardMotion.trx - cardMotion.rx) * kT;
    cardMotion.ry += (cardMotion.try_ - cardMotion.ry) * kT;
    if (cardMotion.trx === 0 && Math.abs(cardMotion.rx) < 0.01) cardMotion.rx = 0;
    if (cardMotion.try_ === 0 && Math.abs(cardMotion.ry) < 0.01) cardMotion.ry = 0;

    const wT = (Math.abs(cardMotion.ox) < 0.01 && Math.abs(cardMotion.oy) < 0.01)
      ? '' : `translate3d(${cardMotion.ox.toFixed(2)}px, ${cardMotion.oy.toFixed(2)}px, 0)`;
    if (wT !== cardMotion.lastWrapT) { wrap.style.transform = wT; cardMotion.lastWrapT = wT; }

    // 始终保留同一形式的 transform（角度为 0 时也写），避免在 none 与 3D 之间切换导致图层重建、画面闪糊
    const cT = `perspective(1400px) rotateX(${cardMotion.rx.toFixed(3)}deg) rotateY(${cardMotion.ry.toFixed(3)}deg)`;
    if (cT !== cardMotion.lastCardT) { card.style.transform = cT; cardMotion.lastCardT = cT; }

  }

  // ===== 壁纸选图网格：基于时间的平滑滚动（帧率无关，指数缓动） =====
  const wpScroll = { pos: 0, target: 0, raf: 0, lastAt: 0, idleTimer: 0 };
  function wpMaxScroll(g) { return Math.max(0, g.scrollHeight - g.clientHeight); }
  function wpMarkScrolling(g) {
    g.classList.add('is-scrolling');
    clearTimeout(wpScroll.idleTimer);
    wpScroll.idleTimer = setTimeout(() => g.classList.remove('is-scrolling'), 160);
  }
  function wpScrollStop() {
    if (wpScroll.raf) { cancelAnimationFrame(wpScroll.raf); wpScroll.raf = 0; }
  }
  function wpSmoothScrollBy(delta) {
    const g = $('wp-grid');
    if (!g) return;
    if (!wpScroll.raf) wpScroll.pos = g.scrollTop;
    wpScroll.target = Math.max(0, Math.min(wpMaxScroll(g), (wpScroll.raf ? wpScroll.target : g.scrollTop) + delta));
    wpMarkScrolling(g);
    if (!wpScroll.raf) {
      wpScroll.lastAt = performance.now();
      wpScroll.raf = requestAnimationFrame(wpScrollTick);
    }
  }
  function wpScrollTick(now) {
    const g = $('wp-grid');
    if (!g) { wpScroll.raf = 0; return; }
    const dt = Math.max(0, Math.min(0.05, (now - wpScroll.lastAt) / 1000));
    wpScroll.lastAt = now;
    const k = 1 - Math.exp(-dt / 0.085);        // 时间常数 85ms：跟手又不生硬
    const diff = wpScroll.target - wpScroll.pos;
    if (Math.abs(diff) < 0.5) {
      wpScroll.pos = wpScroll.target;
      g.scrollTop = wpScroll.pos;
      wpScroll.raf = 0;
      return;
    }
    wpScroll.pos += diff * k;
    g.scrollTop = wpScroll.pos;
    wpMarkScrolling(g);
    wpScroll.raf = requestAnimationFrame(wpScrollTick);
  }

  function invalidateCpCenterCache() { cachedCpCenter = null; cardMotion.amp = -1; }
  function invalidateProgressUiCache() {
    lastProgSec = -1;
    lastProgDur = -1;
    lastProgPct = -1;
  }

  function getProgRefs() {
    if (progRefs) return progRefs;
    progRefs = {
      nowTime: $('now-time'),
      capTime: $('cap-time'),
      nowFill: $('now-progress-fill'),
      nowThumb: $('now-progress-thumb'),
      capFill: $('cap-prog-fill'),
      capOrbProg: $('cap-orb-prog'),
      cpFill: $('cp-progress-fill'),
      cpThumb: $('cp-progress-thumb'),
      cpCur: $('cp-time-cur'),
      cpDur: $('cp-time-dur'),
      ncmTime: $('ncm-now-time'),
      ncmFill: $('ncm-now-progress-fill'),
      ncmThumb: $('ncm-now-progress-thumb'),
      vinylGlow: $('vinyl-glow'),
      cpCard: $('cp-card')
    };
    return progRefs;
  }

  function updateProgressLoop(nowMs) {
    requestAnimationFrame(updateProgressLoop);
    stepCardMotion(nowMs);
    if (!audio) return;
    const refs = getProgRefs();
    const curTr = getCurrentTrack();
    const dur = audio.duration || (curTr ? curTr.duration : 0) || 0;
    const cur = progressDrag.active ? (progressDrag.ratio * dur) : (audio.currentTime || 0);
    const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;

    const isTheater = state.uiMode === 'theater';
    const isCard = !isTheater && document.body.classList.contains('desktop-card-mode');
    const isCollapsedCap = !isTheater && !isCard && state.capsuleCollapsed && !capsuleHoverExpanded;
    const modeKey = isTheater ? 'T' : (isCard ? 'D' : (isCollapsedCap ? 'C' : 'B'));
    if (modeKey !== lastProgModeKey) {
      lastProgModeKey = modeKey;
      invalidateProgressUiCache();
    }

    const secFloor = Math.floor(cur);
    const durRound = Math.round(dur);
    if (secFloor !== lastProgSec || durRound !== lastProgDur || progressDrag.active) {
      lastProgSec = secFloor;
      lastProgDur = durRound;
      if (isTheater) {
        const tStr = `${fmtTime(cur)} / ${fmtTime(dur)}`;
        if (refs.nowTime) refs.nowTime.textContent = tStr;
        if (refs.ncmTime) refs.ncmTime.textContent = tStr;
      } else if (isCard) {
        if (refs.cpCur) refs.cpCur.textContent = fmtTime(cur);
        if (refs.cpDur) refs.cpDur.textContent = fmtTime(dur);
      } else if (!isCollapsedCap && refs.capTime) {
        refs.capTime.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
      }
    }

    if (Math.abs(pct - lastProgPct) >= 0.03 || progressDrag.active) {
      lastProgPct = pct;
      const pctCss = pct.toFixed(2) + '%';
      if (isTheater) {
        if (refs.nowFill) refs.nowFill.style.width = pctCss;
        if (refs.nowThumb) refs.nowThumb.style.left = pctCss;
        if (refs.ncmFill) refs.ncmFill.style.width = pctCss;
        if (refs.ncmThumb) refs.ncmThumb.style.left = pctCss;
      } else if (isCard) {
        if (refs.cpFill) refs.cpFill.style.width = pctCss;
        if (refs.cpThumb) refs.cpThumb.style.left = pctCss;
      } else if (isCollapsedCap) {
        if (refs.capOrbProg) refs.capOrbProg.style.strokeDashoffset = (100 - pct).toFixed(2);
      } else {
        if (refs.capFill) refs.capFill.style.width = pctCss;
      }
    }

    // 兜底：部分流媒体在播放结束时 ended 事件偶发未触发或被吞，检测到 audio.ended 主动切下一首
    if (state.playing && audio.ended && state.loopMode !== 'single' && !autoEndedGuard) {
      autoEndedGuard = true;
      setTimeout(() => stepTrack(1, true), 80);
      return;
    }

    updateDesktopLyric(cur);

    // 曲末自动渐弱：最后 1.8 秒平滑收尾，衔接下一首更自然
    if (state.playing && !audio.paused && !audio.ended && !progressDrag.active && !fadeTimer && state.loopMode !== 'single') {
      const totalDur = (isFinite(audio.duration) && audio.duration > 0) ? audio.duration : (curTr ? curTr.duration : 0);
      if (totalDur > 10) {
        const rem = totalDur - (audio.currentTime || 0);
        if (rem > 0 && rem <= 1.8) {
          audio.volume = state.volume * Math.max(0.06, rem / 1.8);
        } else if (Math.abs(audio.volume - state.volume) > 0.02) {
          audio.volume = state.volume;
        }
      }
    }

    // 网易云流卡顿看门狗：同时观察播放进度和已缓冲区间。
    // 刚起播/网络正在持续缓冲时不能重连——旧逻辑只看 currentTime，会把正常缓冲误杀成“卡顿”。
    if (activeSource === 'ncm' && state.playing && !audio.paused && !audio.ended && !progressDrag.active && !ncmStallRecovering) {
      const nowT = performance.now();
      const tCur = audio.currentTime || 0;
      let bufEnd = 0;
      try {
        if (audio.buffered && audio.buffered.length) {
          for (let i = 0; i < audio.buffered.length; i++) {
            if (audio.buffered.start(i) <= tCur + 0.25 && audio.buffered.end(i) >= tCur) { bufEnd = audio.buffered.end(i); break; }
          }
          if (!bufEnd) bufEnd = audio.buffered.end(audio.buffered.length - 1);
        }
      } catch (_) {}
      const progressed = Math.abs(tCur - ncmLastTime) > 0.05;
      const buffering = bufEnd > ncmLastBufferedEnd + 0.1;
      if (progressed || buffering) {
        if (progressed) ncmLastTime = tCur;
        if (buffering) ncmLastBufferedEnd = bufEnd;
        ncmLastProgressAt = nowT;
      } else if (ncmLastProgressAt > 0) {
        const initialBuffering = tCur < 1 && audio.readyState < 3;
        const idleLimit = initialBuffering ? 22000 : 12000;
        if ((nowT - ncmLastProgressAt) > idleLimit) {
          ncmLastProgressAt = nowT;
          recoverNeteaseStall();
        }
      }
    }

    // 按帧率上限节流可视化绘制（避免高刷屏空耗 CPU/GPU）
    // 帧率由全局帧闸门统一控制（index.html 的 NientumRender），这里不再单独节流
    lastVizDrawAt = nowMs || performance.now();

    // 优先使用 Wallpaper Engine 推送的真实频谱（需 project.json 中 supportsaudioprocessing=true）；
    // 未收到 WE 音频数据时（如浏览器预览），回退为基于播放进度的平滑伪能量。
    let energy = 0;
    const weLive = !!(weAudioData && (performance.now() - weAudioAt) < 800);
    if (weLive) {
      // WE 数组：0-63 左声道，64-127 右声道，低频在前。低频加权突出节拍，中频补充整体响度。
      let lowSum = 0, midSum = 0;
      for (let i = 0; i < 12; i++) {
        const l = weAudioData[i] || 0;
        const r = weAudioData[i + 64] !== undefined ? weAudioData[i + 64] : l;
        lowSum += (l + r) * 0.5;
      }
      for (let i = 12; i < 40; i++) {
        const l = weAudioData[i] || 0;
        const r = weAudioData[i + 64] !== undefined ? weAudioData[i + 64] : l;
        midSum += (l + r) * 0.5;
      }
      const gain = Number(state.vizGain) || 1;
      const raw = Math.min(1, ((lowSum / 12) * 1.25 + (midSum / 28) * 0.55) * gain);
      // 快起慢落，避免闪烁
      weEnergySmooth += (raw - weEnergySmooth) * (raw > weEnergySmooth ? 0.45 : 0.12);
      energy = Math.max(0, Math.min(1, weEnergySmooth));
    } else if (state.playing && !audio.paused) {
      const t = audio.currentTime || 0;
      energy = 0.35 + 0.22 * Math.sin(t * 6.2) + 0.14 * Math.sin(t * 9.9 + 1.1) + 0.08 * Math.sin(t * 17.3 + 2.2);
      energy = Math.max(0, Math.min(1, energy * (Number(state.vizGain) || 1)));
    }
    window.NientumStage.setAudioEnergy(energy);
    window.__nientumAudioEnergy = energy;
    if (isTheater && refs.vinylGlow) {
      const nextScale = energy > 0 ? `scale(${(1 + energy * 0.08).toFixed(3)})` : 'scale(1)';
      if (nextScale !== lastVinylScale) {
        lastVinylScale = nextScale;
        refs.vinylGlow.style.transform = nextScale;
      }
    }
    drawDesktopVisualizer(energy, refs);
  }

  function getGlowSprite() {
    if (glowSpriteCanvas) return glowSpriteCanvas;
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const gctx = c.getContext('2d');
    const g = gctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255, 240, 200, 0.95)');
    g.addColorStop(0.32, 'rgba(248, 200, 120, 0.52)');
    g.addColorStop(0.7, 'rgba(232, 162, 78, 0.14)');
    g.addColorStop(1, 'rgba(232, 162, 78, 0)');
    gctx.fillStyle = g;
    gctx.fillRect(0, 0, 64, 64);
    glowSpriteCanvas = c;
    return c;
  }

  function drawDesktopVisualizer(energy, refs) {
    if (!vizCanvasEl) vizCanvasEl = $('viz-canvas');
    const cv = vizCanvasEl;
    if (!cv) return;
    if (!vizCtx2d) vizCtx2d = cv.getContext('2d');
    const ctx = vizCtx2d;
    if (!ctx) return;

    if (state.uiMode === 'theater' || (!state.footlights && !state.halo)) {
      if (!vizWasCleared) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cv.width, cv.height);
        vizWasCleared = true;
      }
      return;
    }
    vizWasCleared = false;

    const dpr = window.NientumRender ? window.NientumRender.pixelRatio(2) : Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (cv.width !== cw || cv.height !== ch) {
      cv.width = cw;
      cv.height = ch;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const hasLiveWe = !!(weAudioData && (performance.now() - weAudioAt) < 800);
    const t = (audio && audio.currentTime) || (performance.now() * 0.001);
    const isActive = hasLiveWe || (state.playing && audio && !audio.paused);

    let bass = 0;
    for (let i = 0; i < 64; i++) {
      let target = 0;
      if (hasLiveWe) {
        const l = weAudioData[i] || 0;
        const r = weAudioData[i + 64] !== undefined ? weAudioData[i + 64] : l;
        target = Math.min(1, (l + r) * 0.85 * (Number(state.vizGain) || 1));
      } else if (isActive) {
        const f1 = Math.sin(t * 5.4 + i * 0.36);
        const f2 = Math.cos(t * 8.7 - i * 0.23);
        const f3 = Math.sin(t * 13.1 + i * 0.61);
        const env = 0.55 + 0.45 * Math.sin((i / 63) * Math.PI);
        target = Math.max(0.03, Math.min(1, energy * env * (0.48 + 0.28 * f1 + 0.16 * f2 + 0.08 * f3)));
      }
      vizBins[i] += (target - vizBins[i]) * (target > vizBins[i] ? 0.36 : 0.16);
      if (i < 10) bass += vizBins[i];
    }
    bass = Math.min(1, bass / 10);

    const alpha = isActive ? 0.96 : 0.45;
    const glow = getGlowSprite();

    // 1. 脚灯：按层合批绘制，将 240 次 stroke 降为 5 次合批 stroke
    if (state.footlights) {
      const lift = 45;
      const baseY = h - 2 - lift;
      const floorGrad = ctx.createLinearGradient(0, h - 220 - lift, 0, h);
      floorGrad.addColorStop(0.0, 'rgba(220, 150, 66, 0)');
      floorGrad.addColorStop(0.68, `rgba(232, 162, 78, ${(0.14 * alpha).toFixed(3)})`);
      floorGrad.addColorStop(1.0, `rgba(252, 206, 130, ${(0.28 * alpha).toFixed(3)})`);
      ctx.fillStyle = floorGrad;
      ctx.fillRect(0, h - 220 - lift, w, 220 + lift);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      const margin = 18;
      const span = Math.max(100, w - margin * 2);
      const step = span / (FOOT_N - 1);
      for (let i = 0; i < FOOT_N; i++) {
        const v = Math.max(0, Math.min(1, vizBins[i]));
        const vv = Math.pow(v, 1.18);
        const flicker = 0.94 + 0.06 * Math.sin(t * 19.0 + i * 1.7);
        FOOT_BH[i] = (16 + 160 * vv) * flicker;
      }

      const layers = [
        { wid: 22, a: 11 / 255 },
        { wid: 14, a: 20 / 255 },
        { wid: 8,  a: 38 / 255 },
        { wid: 4,  a: 92 / 255 }
      ];
      for (let l = 0; l < layers.length; l++) {
        ctx.strokeStyle = `rgba(246, 185, 94, ${(layers[l].a * alpha).toFixed(3)})`;
        ctx.lineWidth = layers[l].wid;
        ctx.beginPath();
        for (let i = 0; i < FOOT_N; i++) {
          const x = margin + i * step;
          ctx.moveTo(x, baseY);
          ctx.lineTo(x, baseY - FOOT_BH[i]);
        }
        ctx.stroke();
      }

      ctx.strokeStyle = `rgba(255, 236, 193, ${(0.82 * alpha).toFixed(3)})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < FOOT_N; i++) {
        const x = margin + i * step;
        ctx.moveTo(x, baseY);
        ctx.lineTo(x, baseY - Math.max(4, FOOT_BH[i] - 5));
      }
      ctx.stroke();

      ctx.fillStyle = `rgba(255, 238, 196, ${(0.75 * alpha).toFixed(3)})`;
      for (let i = 0; i < FOOT_N; i++) {
        const x = margin + i * step;
        const v = Math.max(0, Math.min(1, vizBins[i]));
        const r = (3.0 + 4.2 * v) * 3.2;
        ctx.globalAlpha = 0.72 * alpha;
        ctx.drawImage(glow, x - r, baseY - 2 - r, r * 2, r * 2);
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(x, baseY - 2, 2.4 + 1.8 * v, 0, Math.PI * 2);
        ctx.fill();
      }

      // 底部漂浮暖金余烬粒子
      for (let i = 0; i < vizParticles.length; i++) {
        const p = vizParticles[i];
        p.y -= (p.spd * 0.00055) * (0.55 + energy * 1.4);
        p.x += Math.sin(t * 0.35 + p.ph) * 0.00012;
        if (p.y < 0.36) {
          p.x = Math.random();
          p.y = 0.96 - Math.random() * 0.06;
        }
        const px = p.x * w;
        const py = p.y * h - lift;
        const aa = Math.min(0.62, p.alpha * (0.45 + energy * 0.9) * alpha);
        if (aa <= 0.01) continue;
        const hr = p.r * 3.5;
        ctx.globalAlpha = aa * 0.55;
        ctx.drawImage(glow, px - hr, py - hr, hr * 2, hr * 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(248, 214, 156, ${aa.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(px, py, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 2. 光环：预计算三角表 + 4 次合批 stroke（替代 288 次单条 stroke）
    if (state.halo) {
      let cx = w * 0.5;
      let cy = h * 0.48;
      if (document.body.classList.contains('desktop-card-mode')) {
        if (!cachedCpCenter && refs && refs.cpCard) {
          const cr = refs.cpCard.getBoundingClientRect();
          if (cr && cr.width > 0 && cr.height > 0) {
            // 缓存的是卡片“标准位置”的中心（扣除当前漂移偏移），绘制时再叠加实时偏移
            cachedCpCenter = { cx: cr.left + cr.width * 0.5 - cardMotion.ox, cy: cr.top + cr.height * 0.5 - cardMotion.oy };
          }
        }
        if (cachedCpCenter) {
          cx = cachedCpCenter.cx + cardMotion.ox;
          cy = cachedCpCenter.cy + cardMotion.oy;
        } else {
          cy = h * 0.43;
        }
      }
      const radius = Math.min(w, h) * 0.22;
      const pulse = radius + bass * 4.5;
      const rot = t * (3.0 * Math.PI / 180);

      for (let i = 0; i < HALO_N; i++) {
        let v = vizBins[i % 48];
        if (i & 1) v *= 0.62;
        HALO_LEN[i] = 22 + 94 * Math.pow(Math.max(0, Math.min(1, v)), 1.25);
      }

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.lineCap = 'round';

      const strokeHaloPass = (color, width) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        for (let i = 0; i < HALO_N; i++) {
          const sx = HALO_SIN[i];
          const sy = HALO_COS[i];
          const end = pulse + HALO_LEN[i];
          ctx.moveTo(sx * pulse, sy * pulse);
          ctx.lineTo(sx * end, sy * end);
        }
        ctx.stroke();
      };

      strokeHaloPass(`rgba(12, 8, 5, ${(0.20 * alpha).toFixed(3)})`, 11);
      ctx.globalCompositeOperation = 'lighter';
      const boost = Math.min(1, alpha * 1.35);
      strokeHaloPass(`rgba(229, 198, 135, ${((38 / 255) * boost).toFixed(3)})`, 10);
      strokeHaloPass(`rgba(229, 198, 135, ${((84 / 255) * boost).toFixed(3)})`, 6);
      strokeHaloPass(`rgba(255, 224, 168, ${((235 / 255) * boost).toFixed(3)})`, 2.6);
      ctx.restore();
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function bindEvents() {
    // 1. 滚轮滚动（对齐桌面封票架：每次滚轮步进 1 首并平滑居中）
    window.addEventListener('wheel', (e) => {
      if (state.uiMode !== 'theater') return;
      if (e.target && e.target.closest && e.target.closest('#settings-pop')) return;
      if ($('view-music').classList.contains('active')) {
        if (e.target && e.target.closest && e.target.closest('#chapter-strip')) return;
        if (e.clientX > window.innerWidth * 0.56) return;
        e.preventDefault();
        if (Math.abs(e.deltaY) < 1) return;
        stepMusicByWheel(e.deltaY > 0 ? 1 : -1);
      } else if ($('view-netease') && $('view-netease').classList.contains('active')) {
        if (e.target && e.target.closest && e.target.closest('#ncm-playlists')) return;
        if (e.clientX > window.innerWidth * 0.56) return;
        e.preventDefault();
        if (Math.abs(e.deltaY) < 1) return;
        stepNcmByWheel(e.deltaY > 0 ? 1 : -1);
      }
    }, { passive: false });

    // 记录鼠标位置，供列表边缘悬停自动滚动使用（WE 桌面能转发 mousemove，但不转发 wheel）
    // 失焦模糊：离开桌面、停在桌面图标/任务栏/其他窗口，或悬停在右上角音乐胶囊时均产生模糊
    const rootEl = document.documentElement;
    rootEl.addEventListener('mouseleave', () => {
      if (!bridgeFocusActive) document.body.classList.add('unfocused');
    });
    rootEl.addEventListener('mouseenter', () => {
      if (!bridgeFocusActive) document.body.classList.remove('unfocused');
    });
    window.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget && !bridgeFocusActive) document.body.classList.add('unfocused');
    });
    window.addEventListener('focus', () => {
      if (!bridgeFocusActive) document.body.classList.remove('unfocused');
    });

    const scheduleCapsuleLeave = () => {
      if (capsuleLeaveTimer) return;
      capsuleLeaveTimer = setTimeout(() => {
        capsuleLeaveTimer = 0;
        if (progressDrag.active) {
          scheduleCapsuleLeave();
          return;
        }
        capsuleHovered = false;
        document.body.classList.remove('capsule-hover');
        if (state.capsuleCollapsed) {
          capsuleHoverExpanded = false;
          syncCapsuleVisualState();
        } else {
          scheduleCapsuleAutoCollapse();
        }
      }, 200);
    };

    const capDock = $('capsule-dock');
    if (capDock) {
      capDock.addEventListener('mouseenter', () => {
        capsuleHovered = true;
        document.body.classList.add('capsule-hover');
        if (capsuleLeaveTimer) { clearTimeout(capsuleLeaveTimer); capsuleLeaveTimer = 0; }
        if (capsuleAutoTimer) { clearTimeout(capsuleAutoTimer); capsuleAutoTimer = 0; }
        if (state.capsuleCollapsed && !capsuleHoverExpanded && state.capsuleExpandMode !== 'click') {
          capsuleHoverExpanded = true;
          syncCapsuleVisualState();
        }
      });
      capDock.addEventListener('mouseleave', () => {
        if (performance.now() < ignoreCapsuleLeaveUntil) return;
        scheduleCapsuleLeave();
      });
    }

    window.addEventListener('mousemove', (e) => {
      // 桥接器焦点信号：鼠标离开桌面或停留在桌面图标/任务栏/其他窗口时触发模糊
      if (e.buttons === 2 && e.clientY > 0 && e.clientY <= 14 && e.clientX >= 250 && e.clientX <= 1000) {
        if (e.clientY > 3) ignoreCapsuleLeaveUntil = performance.now() + 240;
        bridgeFocusActive = true;
        document.body.classList.toggle('unfocused', e.clientY <= 3);
        return;
      }
      if (!bridgeFocusActive && e.buttons === 0 && document.body.classList.contains('unfocused')) {
        document.body.classList.remove('unfocused');
      }
      // 外部滚轮桥接信号：桥接器用“右键按下状态 + 左上角窄带坐标”发来合成 mousemove，
      // 因为 WE 不转发真实滚轮，这条通道是唯一能进页面的连续输入。
      if (e.buttons === 2 && e.clientY > 0 && e.clientY <= 14 && e.clientX >= 25 && e.clientX <= 240) {
        ignoreCapsuleLeaveUntil = performance.now() + 300;
        const n = Math.max(1, Math.min(6, Math.round((e.clientX - 30) / 30)));
        const dy = e.clientY <= 3 ? -1 : 1;
        if (state.uiMode === 'theater') {
          if ($('view-music').classList.contains('active')) {
            stepMusicByWheel(dy);
          } else if ($('view-wallpapers').classList.contains('active') && $('wp-grid')) {
            wpSmoothScrollBy(dy * 130 * n);
          } else if ($('view-netease') && $('view-netease').classList.contains('active')) {
            stepNcmByWheel(dy);
          }
        } else {
          window.dispatchEvent(new CustomEvent('nientum-bridge-wheel', { detail: { dy, n } }));
        }
        return;
      }
      if (e.buttons === 0) {
        lastPointerX = e.clientX;
        if (capsuleHovered && performance.now() >= ignoreCapsuleLeaveUntil && !(e.target && e.target.closest && e.target.closest('#capsule-dock'))) {
          scheduleCapsuleLeave();
        }
      }
      });

    // 壁纸库支持按住左键上下拖拽滚动（WE 桌面 100% 可用），松手后带惯性滑行
    const wpGrid = $('wp-grid');
    if (wpGrid) {
      let wpDrag = false, wpStartY = 0, wpStartScroll = 0, wpMoved = 0;
      let wpLastY = 0, wpLastT = 0, wpVel = 0;
      wpGrid.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        wpDrag = true;
        wpStartY = wpLastY = e.clientY;
        wpLastT = performance.now();
        wpVel = 0;
        wpScrollStop();
        wpStartScroll = wpGrid.scrollTop;
        wpMoved = 0;
        wpGrid.classList.add('dragging');
      });
      window.addEventListener('mousemove', (e) => {
        if (!wpDrag) return;
        const scale = window.innerWidth / 1920 || 1;
        const dy = (e.clientY - wpStartY) / scale;
        wpMoved = Math.max(wpMoved, Math.abs(dy));
        const now = performance.now();
        const dtm = Math.max(1, now - wpLastT);
        const v = -((e.clientY - wpLastY) / scale) / dtm; // px/ms（布局单位）
        wpVel = wpVel * 0.7 + v * 0.3;
        wpLastY = e.clientY; wpLastT = now;
        wpGrid.scrollTop = wpStartScroll - dy;
        wpScroll.pos = wpScroll.target = wpGrid.scrollTop;
      });
      window.addEventListener('mouseup', () => {
        if (!wpDrag) return;
        wpDrag = false;
        wpGrid.classList.remove('dragging');
        // 松手前 90ms 内仍在移动才给惯性，滑行距离约为速度 × 260ms
        if (performance.now() - wpLastT < 90 && Math.abs(wpVel) > 0.15) {
          wpSmoothScrollBy(Math.max(-1400, Math.min(1400, wpVel * 260)));
        }
      });
      wpGrid.addEventListener('click', (e) => {
        if (wpMoved > 6) {
          e.stopPropagation();
          e.preventDefault();
          wpMoved = 0;
        }
      }, true);
    }

    // 2. 鼠标左键按住上下拖拽列表（在 Wallpaper Engine 桌面壁纸中 100% 可用）
    let dragActive = false, dragStartY = 0, dragStartPos = 0, dragMoved = 0;
    const trackList = $('track-list');
    trackList.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragActive = true;
      dragStartY = e.clientY;
      dragStartPos = scrollPos;
      dragMoved = 0;
      trackList.classList.add('dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragActive) return;
      const scale = window.innerWidth / 1920 || 1;
      const dy = (e.clientY - dragStartY) / scale;
      dragMoved = Math.max(dragMoved, Math.abs(dy));
      selectionLocked = false;
      wheelTarget = Math.max(0, Math.min(maxScrollY(), dragStartPos - dy));
      scrollPos = wheelTarget;
      layoutArcCards(true);
    });
    window.addEventListener('mouseup', () => {
      if (!dragActive) return;
      dragActive = false;
      trackList.classList.remove('dragging');
    });
    // 若刚才进行了拖拽，拦截本次 click 避免误触切歌
    trackList.addEventListener('click', (e) => {
      if (dragMoved > 6) {
        e.stopPropagation();
        e.preventDefault();
        dragMoved = 0;
      }
    }, true);

    // 3. 右侧金色滚动条拖动/点击定位
    const bar = $('arc-scrollbar');
    if (bar) {
      let barDrag = false;
      const seekBar = (clientY) => {
        const rect = bar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
        selectionLocked = false;
        wheelTarget = ratio * maxScrollY();
        if (!wheelRaf) wheelRaf = requestAnimationFrame(stepSmoothWheel);
      };
      bar.addEventListener('mousedown', (e) => { e.preventDefault(); barDrag = true; seekBar(e.clientY); });
      window.addEventListener('mousemove', (e) => { if (barDrag) seekBar(e.clientY); });
      window.addEventListener('mouseup', () => { barDrag = false; });
    }
    const scrollByStep = (dy) => {
      selectionLocked = false;
      wheelTarget = Math.max(0, Math.min(maxScrollY(), wheelTarget + dy));
      if (!wheelRaf) wheelRaf = requestAnimationFrame(stepSmoothWheel);
    };
    if ($('btn-scroll-up')) $('btn-scroll-up').onclick = () => scrollByStep(-ROW_STRIDE * 4);
    if ($('btn-scroll-down')) $('btn-scroll-down').onclick = () => scrollByStep(ROW_STRIDE * 4);

    window.addEventListener('resize', () => {
      updateCanvasScale();
      invalidateCpCenterCache();
    });

    $('cat-prev').onclick = () => { $('chapter-strip').scrollBy({ left: -240, behavior: 'smooth' }); };
    $('cat-next').onclick = () => { $('chapter-strip').scrollBy({ left: 240, behavior: 'smooth' }); };

    // 曲目分类（章节条）支持鼠标左键横向按住拖动 + 滚轮横向滚动
    const chStrip = $('chapter-strip');
    if (chStrip) {
      let chDrag = false, chStartX = 0, chStartScroll = 0, chMoved = 0;
      chStrip.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        chDrag = true;
        chStartX = e.clientX;
        chStartScroll = chStrip.scrollLeft;
        chMoved = 0;
        chStrip.classList.add('dragging');
      });
      window.addEventListener('mousemove', (e) => {
        if (!chDrag) return;
        const scale = window.innerWidth / 1920 || 1;
        const dx = (e.clientX - chStartX) / scale;
        chMoved = Math.max(chMoved, Math.abs(dx));
        chStrip.scrollLeft = chStartScroll - dx;
      });
      window.addEventListener('mouseup', () => {
        if (!chDrag) return;
        chDrag = false;
        chStrip.classList.remove('dragging');
      });
      chStrip.addEventListener('click', (e) => {
        if (chMoved > 5) {
          e.stopPropagation();
          e.preventDefault();
          chMoved = 0;
        }
      }, true);
      chStrip.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          chStrip.scrollLeft += e.deltaY;
        }
      }, { passive: false });
    }

    syncCapsuleVisualState();
    scheduleCapsuleAutoCollapse();

    // 点击右上角半透明播放栏主体（非控制小按钮/进度条）时，执行放大飞跃动效展开选曲界面；若已缩为方形悬浮球则先展开胶囊
    const capBar = document.querySelector('.capsule-bar');
    if (capBar) {
      capBar.onclick = (e) => {
        if (Date.now() < blockCapsuleOpenUntil) return;
        if (state.capsuleCollapsed && !capsuleHoverExpanded) {
          if (state.capsuleExpandMode === 'click') {
            setCapsuleCollapsed(false, true);
          } else {
            capsuleHoverExpanded = true;
            syncCapsuleVisualState();
          }
          return;
        }
        if (e.target.closest('button') || e.target.closest('#cap-prog-track')) return;
        setUiMode('theater', true);
      };
    }
    if ($('btn-cap-collapse')) {
      $('btn-cap-collapse').onclick = (e) => {
        e.stopPropagation();
        setCapsuleCollapsed(true, true);
      };
    }
    $('btn-close-theater').onclick = () => {
      $('settings-pop').classList.remove('open');
      setUiMode('capsule');
    };
    $('theater-backdrop').onclick = () => {
      $('settings-pop').classList.remove('open');
      setUiMode('capsule');
    };
    $('btn-settings').onclick = (e) => {
      e.stopPropagation();
      const pop = $('settings-pop');
      pop.classList.toggle('open');
      pop.setAttribute('aria-hidden', pop.classList.contains('open') ? 'false' : 'true');
    };
    $('settings-pop').addEventListener('mousedown', (e) => e.stopPropagation());
    $('settings-pop').onclick = (e) => e.stopPropagation();

    if ($('btn-wp-import')) $('btn-wp-import').onclick = openWpImport;
    if ($('btn-wp-import-close')) $('btn-wp-import-close').onclick = closeWpImport;
    if ($('btn-wp-pick-local')) $('btn-wp-pick-local').onclick = importLocalWallpaper;
    if ($('btn-wp-we-refresh')) $('btn-wp-we-refresh').onclick = loadWeImportList;
    if ($('inp-we-search')) $('inp-we-search').addEventListener('input', applyWeImportFilter);
    if ($('sel-we-resolution')) {
      $('sel-we-resolution').querySelectorAll('[data-res]').forEach(btn => {
        btn.onclick = () => {
          $('sel-we-resolution').querySelectorAll('[data-res]').forEach(b => b.classList.toggle('active', b === btn));
          applyWeImportFilter();
        };
      });
    }
    if ($('sel-we-loop')) {
      $('sel-we-loop').querySelectorAll('[data-loop]').forEach(btn => {
        btn.onclick = () => {
          $('sel-we-loop').querySelectorAll('[data-loop]').forEach(b => b.classList.toggle('active', b === btn));
          applyWeImportFilter();
        };
      });
    }
    if ($('sel-we-duration')) {
      $('sel-we-duration').querySelectorAll('[data-dur]').forEach(btn => {
        btn.onclick = () => {
          $('sel-we-duration').querySelectorAll('[data-dur]').forEach(b => b.classList.toggle('active', b === btn));
          if ($('inp-we-duration')) $('inp-we-duration').value = String(btn.dataset.dur || 15);
          applyWeImportFilter();
        };
      });
    }
    if ($('inp-we-duration')) {
      const syncDurInput = (clamp) => {
        const inp = $('inp-we-duration');
        let n = Math.round(Number(inp.value));
        if (!Number.isFinite(n)) n = 15;
        if (clamp) {
          n = Math.max(5, Math.min(300, n));
          inp.value = String(n);
        }
        if ($('sel-we-duration')) {
          $('sel-we-duration').querySelectorAll('[data-dur]').forEach(b => {
            b.classList.toggle('active', Number(b.dataset.dur) === n);
          });
        }
        applyWeImportFilter();
      };
      $('inp-we-duration').addEventListener('input', () => syncDurInput(false));
      $('inp-we-duration').addEventListener('change', () => syncDurInput(true));
    }
    if ($('wp-we-pills')) {
      $('wp-we-pills').querySelectorAll('[data-we-filter]').forEach(pill => {
        pill.onclick = () => {
          weFilterMode = pill.dataset.weFilter || 'all';
          $('wp-we-pills').querySelectorAll('[data-we-filter]').forEach(p => p.classList.toggle('active', p === pill));
          applyWeImportFilter();
        };
      });
    }
    const wpImportPop = $('wp-import-pop');
    if (wpImportPop) {
      const mask = wpImportPop.querySelector('.wp-import-mask');
      if (mask) mask.onclick = closeWpImport;
      const card = wpImportPop.querySelector('.wp-import-card');
      if (card) card.onclick = (e) => e.stopPropagation();
    }
    if ($('btn-wp-crop-close')) $('btn-wp-crop-close').onclick = closeWpCropper;
    if ($('btn-wp-crop-skip')) $('btn-wp-crop-skip').onclick = closeWpCropper;
    if ($('btn-wp-crop-apply')) $('btn-wp-crop-apply').onclick = saveWpCropper;
    const wpCropPop = $('wp-crop-pop');
    if (wpCropPop) {
      const mask = wpCropPop.querySelector('.wp-crop-mask');
      if (mask) mask.onclick = closeWpCropper;
      const card = wpCropPop.querySelector('.wp-crop-card');
      if (card) card.onclick = (e) => e.stopPropagation();
      card && card.querySelectorAll('[data-crop-preset]').forEach(btn => {
        btn.onclick = () => {
          const p = btn.dataset.cropPreset;
          if (p === 'top') wpCropState.y = 0;
          else if (p === 'bottom') wpCropState.y = 1;
          else if (p === 'left') wpCropState.x = 0;
          else if (p === 'right') wpCropState.x = 1;
          else if (p === 'center') { wpCropState.x = 0.5; wpCropState.y = 0.5; }
          else if (p === 'reset') { wpCropState.x = 0.5; wpCropState.y = 0.5; wpCropState.zoom = 1; }
          layoutCropPreview();
        };
      });
    }
    bindGoldSlider($('sl-wp-crop-zoom'), (val) => {
      zoomCropAnchored(val / 100);
    });
    const wpCropStage = $('wp-crop-stage');
    if (wpCropStage) {
      let dragCrop = null;
      wpCropStage.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const iw = wpCropState.iw || 16;
        const ih = wpCropState.ih || 9;
        const cw = wpCropState.cw || wpCropStage.clientWidth || 16;
        const ch = wpCropState.ch || wpCropStage.clientHeight || 9;
        const coverScale = Math.max(cw / iw, ch / ih);
        const dw = iw * coverScale * wpCropState.zoom;
        const dh = ih * coverScale * wpCropState.zoom;
        dragCrop = {
          sx: e.clientX, sy: e.clientY,
          x0: wpCropState.x, y0: wpCropState.y,
          slackX: cw - dw, slackY: ch - dh
        };
        wpCropStage.classList.add('dragging');
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragCrop) return;
        const dx = e.clientX - dragCrop.sx;
        const dy = e.clientY - dragCrop.sy;
        wpCropState.x = Math.abs(dragCrop.slackX) > 1
          ? Math.max(0, Math.min(1, dragCrop.x0 + dx / dragCrop.slackX))
          : 0.5;
        wpCropState.y = Math.abs(dragCrop.slackY) > 1
          ? Math.max(0, Math.min(1, dragCrop.y0 + dy / dragCrop.slackY))
          : 0.5;
        layoutCropPreview();
      });
      window.addEventListener('mouseup', () => {
        if (!dragCrop) return;
        dragCrop = null;
        wpCropStage.classList.remove('dragging');
      });
      wpCropStage.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const step = e.deltaY < 0 ? 0.1 : -0.1;
        zoomCropAnchored(wpCropState.zoom + step);
      }, { passive: false });
      window.addEventListener('resize', () => {
        const pop = $('wp-crop-pop');
        if (pop && pop.classList.contains('open')) {
          updateCropStageAspect();
          layoutCropPreview();
        }
      });
    }
    $('theater-shell').addEventListener('click', () => {
      const pop = $('settings-pop');
      if (pop && pop.classList.contains('open')) {
        pop.classList.remove('open');
        pop.setAttribute('aria-hidden', 'true');
      }
    });
    document.querySelectorAll('#opt-res .sp-chip').forEach(btn => {
      btn.onclick = () => {
        state.resScale = Number(btn.dataset.res) || 1.0;
        applyVisualSettings();
        saveState();
      };
    });

    const applyFpsValue = (raw, syncInput) => {
      let v = parseInt(String(raw).replace(/[^\d]/g, ''), 10);
      if (Number.isNaN(v) || v < 0) v = 0;
      if (v > 240) v = 240;
      state.fpsLimit = v;
      if (syncInput && $('inp-fps')) $('inp-fps').value = String(v);
      applyVisualSettings();
      saveState();
    };
    if ($('inp-fps')) {
      $('inp-fps').addEventListener('input', (e) => {
        const cleaned = e.target.value.replace(/[^\d]/g, '');
        if (e.target.value !== cleaned) e.target.value = cleaned;
        if (cleaned !== '') applyFpsValue(cleaned, false);
      });
      $('inp-fps').addEventListener('change', (e) => applyFpsValue(e.target.value, true));
      $('inp-fps').addEventListener('blur', (e) => applyFpsValue(e.target.value, true));
      $('inp-fps').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          applyFpsValue(e.target.value, true);
          e.target.blur();
        }
      });
    }
    if ($('btn-fps-dec')) {
      $('btn-fps-dec').onclick = () => applyFpsValue(Math.max(0, (Number(state.fpsLimit) || 0) - 10), true);
    }
    if ($('btn-fps-inc')) {
      $('btn-fps-inc').onclick = () => applyFpsValue(Math.min(240, (Number(state.fpsLimit) || 0) + 10), true);
    }
    document.querySelectorAll('#opt-fps-presets .sp-chip').forEach(btn => {
      btn.onclick = () => applyFpsValue(btn.dataset.fps, true);
    });

    // 帧率输入框内置虚拟数字小键盘（不依赖桌面键盘焦点）
    const fpsKeypad = $('fps-keypad');
    let fpsKpFirstClick = true;
    if ($('inp-fps') && fpsKeypad) {
      const openKp = () => {
        if (nativeInputBridgeReady) return;
        fpsKpFirstClick = true;
        fpsKeypad.classList.add('open');
        fpsKeypad.setAttribute('aria-hidden', 'false');
      };
      $('inp-fps').addEventListener('click', (e) => { e.stopPropagation(); openKp(); });
      $('inp-fps').addEventListener('focus', openKp);
      fpsKeypad.querySelectorAll('.fps-kp-btn').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const k = btn.dataset.k;
          const inp = $('inp-fps');
          if (!inp) return;
          if (k === 'clear') {
            inp.value = '0';
            fpsKpFirstClick = true;
            applyFpsValue('0', true);
            return;
          }
          if (k === 'back') {
            fpsKpFirstClick = false;
            const next = inp.value.slice(0, -1) || '0';
            inp.value = next;
            applyFpsValue(next, true);
            return;
          }
          const cur = fpsKpFirstClick ? '' : (inp.value === '0' ? '' : inp.value);
          fpsKpFirstClick = false;
          const next = (cur + k).slice(0, 3);
          inp.value = next;
          applyFpsValue(next, true);
        };
      });
      if ($('btn-fps-kp-done')) {
        $('btn-fps-kp-done').onclick = (e) => {
          e.stopPropagation();
          fpsKeypad.classList.remove('open');
          fpsKeypad.setAttribute('aria-hidden', 'true');
        };
      }
    }
    if ($('btn-save-settings')) {
      let saveHintTimer = 0;
      $('btn-save-settings').onclick = () => {
        if ($('inp-fps')) applyFpsValue($('inp-fps').value, true);
        if ($('chk-footlights')) state.footlights = $('chk-footlights').checked;
        if ($('chk-halo')) state.halo = $('chk-halo').checked;
        if ($('chk-defocus-blur')) state.defocusBlur = $('chk-defocus-blur').checked;
        if ($('chk-card-glass')) state.cardGlass = $('chk-card-glass').checked;
        if ($('chk-ui-glass')) state.uiGlass = $('chk-ui-glass').checked;
        if ($('chk-font-wave')) state.fontWaveEnabled = $('chk-font-wave').checked;
        if ($('inp-font-wave-hex') && /^#[0-9a-f]{6}$/i.test(String($('inp-font-wave-hex').value || ''))) {
          state.fontWaveColor = $('inp-font-wave-hex').value;
        }
        if ($('chk-side-clock')) state.showSideClock = $('chk-side-clock').checked;
        if ($('chk-side-drawer')) state.showSideDrawer = $('chk-side-drawer').checked;
        if ($('chk-dock-enabled')) state.dockEnabled = $('chk-dock-enabled').checked;
        if ($('chk-sync-cg-set')) state.autoSyncCg = $('chk-sync-cg-set').checked;
        applyVisualSettings();
        updateTrackUi();
        updateDesktopLyric(audio ? (audio.currentTime || 0) : 0);
        saveState();
        const hint = $('sp-save-hint');
        if (hint) {
          hint.textContent = '✓ 已保存';
          hint.classList.add('show');
          clearTimeout(saveHintTimer);
          saveHintTimer = setTimeout(() => hint.classList.remove('show'), 1800);
        }
      };
    }

    if ($('btn-close-settings')) {
      $('btn-close-settings').onclick = () => {
        $('settings-pop').classList.remove('open');
        $('settings-pop').setAttribute('aria-hidden', 'true');
      };
    }

    (function setupGithubUpdater() {
      const btnCheck = $('btn-check-update');
      const btnOpen = $('btn-open-release');
      const btnDl = $('btn-download-update');
      const btnDlPatch = $('btn-download-patch');
      const statusEl = $('sp-update-status');
      const notesEl = $('sp-update-notes');
      const verEl = $('sp-update-ver');
      if (!btnCheck || !statusEl) return;

      let latestReleaseUrl = 'https://github.com/Chengxhen/nientum-wallpaper/releases';
      let latestFullAsset = null;
      let latestPatchAsset = null;
      let dlPollTimer = 0;

      const setUpdStatus = (msg, cls) => {
        statusEl.textContent = msg || '';
        statusEl.className = 'sp-update-status' + (cls ? ' ' + cls : '');
      };

      const stopDlPoll = () => {
        if (dlPollTimer) { clearInterval(dlPollTimer); dlPollTimer = 0; }
      };

      btnCheck.onclick = async () => {
        btnCheck.disabled = true;
        setUpdStatus('正在连接 GitHub 检测更新...', '');
        if (notesEl) { notesEl.textContent = ''; notesEl.classList.remove('show'); }
        if (btnDl) btnDl.style.display = 'none';
        if (btnDlPatch) btnDlPatch.style.display = 'none';
        try {
          const resp = await fetch(`${NCM_BASE}/api/update/check?t=${Date.now()}`, { cache: 'no-store' });
          const j = await resp.json();
          if (!j || !j.ok) {
            setUpdStatus((j && j.error) || '检测失败，请确认本地桥接服务已启动', 'err');
            return;
          }
          if (verEl && j.currentVersion) verEl.textContent = '当前版本 ' + j.currentVersion;
          if (j.htmlUrl) latestReleaseUrl = j.htmlUrl;
          const assets = Array.isArray(j.assets) ? j.assets : [];
          const isZip = (a) => /\.(zip|rar|7z|exe)$/i.test(String(a && a.name || ''));
          const isPatch = (a) => /_patch\.zip$/i.test(String(a && a.name || ''));
          latestFullAsset = assets.find(a => isZip(a) && !isPatch(a)) || null;
          latestPatchAsset = assets.find(a => isPatch(a)) || null;
          if (!j.latestTag) {
            setUpdStatus('仓库暂无已发布版本', '');
          } else if (j.hasUpdate) {
            setUpdStatus(`发现新版本 ${j.latestTag}！`, 'has-new');
            if (notesEl && j.body) {
              notesEl.textContent = j.body;
              notesEl.classList.add('show');
            }
            if (btnDl && latestFullAsset && latestFullAsset.downloadUrl) {
              btnDl.textContent = '⬇ 完整包';
              btnDl.title = latestFullAsset.name || '';
              btnDl.style.display = '';
            }
            if (btnDlPatch && latestPatchAsset && latestPatchAsset.downloadUrl) {
              btnDlPatch.textContent = '⬆ 增量包（只含变化）';
              btnDlPatch.title = (latestPatchAsset.name || '') + ' · 需已安装上一版本，跨版本请用完整包';
              btnDlPatch.style.display = '';
            }
          } else if (j.isAhead) {
            setUpdStatus(`当前版本领先于 GitHub (${j.latestTag})`, '');
          } else {
            setUpdStatus(`已是最新版本 (${j.latestTag})`, '');
            if (notesEl && j.body) {
              notesEl.textContent = j.body;
              notesEl.classList.add('show');
            }
          }
        } catch (_) {
          setUpdStatus('无法连接本地桥接服务（127.0.0.1:17988）', 'err');
        } finally {
          btnCheck.disabled = false;
        }
      };

      if (btnOpen) {
        btnOpen.onclick = () => {
          fetch(`${NCM_BASE}/api/update/open-page`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: latestReleaseUrl })
          }).catch(() => {});
        };
      }

      const startDownload = async (asset, btn) => {
        if (!asset || !asset.downloadUrl) return;
        btn.disabled = true;
        setUpdStatus('正在启动下载...', '');
        try {
          const resp = await fetch(`${NCM_BASE}/api/update/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadUrl: asset.downloadUrl, fileName: asset.name || '' })
          });
          const j = await resp.json();
          if (!j || !j.ok) {
            setUpdStatus((j && j.error) || '下载启动失败', 'err');
            btn.disabled = false;
            return;
          }
          stopDlPoll();
          dlPollTimer = setInterval(async () => {
            try {
              const pr = await fetch(`${NCM_BASE}/api/update/progress?t=${Date.now()}`, { cache: 'no-store' });
              const pj = await pr.json();
              if (!pj) return;
              if (pj.error) {
                stopDlPoll();
                setUpdStatus(pj.message || pj.error, 'err');
                btn.disabled = false;
                return;
              }
              if (pj.message) setUpdStatus(pj.message, pj.active ? '' : 'has-new');
              if (!pj.active) {
                stopDlPoll();
                btn.disabled = false;
              }
            } catch (_) {}
          }, 500);
        } catch (_) {
          setUpdStatus('下载请求失败', 'err');
          btn.disabled = false;
        }
      };

      if (btnDl) btnDl.onclick = () => startDownload(latestFullAsset, btnDl);
      if (btnDlPatch) btnDlPatch.onclick = () => startDownload(latestPatchAsset, btnDlPatch);
    })();

    if ($('btn-reset-settings')) {
      $('btn-reset-settings').onclick = () => {
        state.resScale = 1.0;
        state.fpsLimit = 60;
        state.spineSpeed = 1.0;
        state.particles = 0.8;
        state.uiOpacity = 0.96;
        state.lyricScale = 1;
        state.footlights = true;
        state.halo = true;
        state.defocusBlur = true;
        state.vizGain = 1;
        state.cardGlass = false;
        state.cardTilt = 1;
        state.uiGlass = true;
        state.fontWaveEnabled = false;
        state.fontWaveColor = '#6ec6ff';
        state.showSideClock = true;
        state.showSideDrawer = true;
        state.dockEnabled = true;
        state.dockMotion = 'soft';
        state.capsuleAutoCollapseSec = 30;
        state.capsuleExpandMode = 'hover';
        state.autoSyncCg = false;
        state.localCoverToCard = false;
        state.ncmLyricEnabled = true;
        state.ncmCoverToCard = false;
        applyVisualSettings();
        fitDesktopLyric();
        scheduleCapsuleAutoCollapse();
        updateTrackUi();
        updateDesktopLyric(audio ? (audio.currentTime || 0) : 0);
        saveState();
        const hint = $('sp-save-hint');
        if (hint) {
          hint.textContent = '已恢复默认';
          hint.classList.add('show');
          setTimeout(() => hint.classList.remove('show'), 1800);
        }
      };
    }

    bindGoldSlider($('sl-lyric-size'), (val) => {
      state.lyricScale = Math.max(0.7, Math.min(1.6, val / 100));
      applyVisualSettings();
      fitDesktopLyric();
      saveState();
    });

    bindGoldSlider($('sl-viz-gain'), (val) => {
      state.vizGain = Math.max(0.3, Math.min(2, val / 100));
      applyVisualSettings();
      saveState();
    });

    bindGoldSlider($('sl-spine-speed'), (val) => {
      state.spineSpeed = Math.max(0.2, Math.min(2, val / 100));
      applyVisualSettings();
      saveState();
    });

    if ($('chk-ui-glass')) {
      $('chk-ui-glass').onchange = (e) => {
        state.uiGlass = !!e.target.checked;
        applyVisualSettings();
        saveState();
      };
    }

    if ($('chk-font-wave')) {
      $('chk-font-wave').onchange = (e) => {
        state.fontWaveEnabled = !!e.target.checked;
        applyVisualSettings();
        saveState();
      };
    }

    (function setupFreeColorPalette() {
      const btn = $('btn-font-wave-palette');
      const pop = $('font-palette-pop');
      const svBox = $('font-palette-sv');
      const svCursor = $('font-palette-cursor');
      const hueBox = $('font-palette-hue');
      const hueThumb = $('font-palette-hue-thumb');
      const hexInp = $('inp-font-wave-hex');
      const doneBtn = $('btn-font-palette-done');
      if (!btn || !pop || !svBox || !hueBox) return;

      let hsv = { h: 204, s: 0.57, v: 1 };
      const hexToRgb = (hex) => {
        const m = String(hex || '').match(/^#([0-9a-f]{6})$/i);
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
      };
      const rgbToHsv = (r, g, b) => {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        let h = 0;
        if (d !== 0) {
          if (max === r) h = ((g - b) / d) % 6;
          else if (max === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          h = Math.round(h * 60);
          if (h < 0) h += 360;
        }
        return { h, s: max === 0 ? 0 : d / max, v: max };
      };
      const hsvToHex = (h, s, v) => {
        const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
        let r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; }
        else if (h < 120) { r = x; g = c; }
        else if (h < 180) { g = c; b = x; }
        else if (h < 240) { g = x; b = c; }
        else if (h < 300) { r = x; b = c; }
        else { r = c; b = x; }
        const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
      };

      const renderPaletteUi = () => {
        svBox.style.background = `hsl(${hsv.h}, 100%, 50%)`;
        if (svCursor) {
          svCursor.style.left = (hsv.s * 100).toFixed(1) + '%';
          svCursor.style.top = ((1 - hsv.v) * 100).toFixed(1) + '%';
        }
        if (hueThumb) {
          hueThumb.style.left = ((hsv.h / 360) * 100).toFixed(1) + '%';
        }
      };

      const applyHsvColor = () => {
        const hex = hsvToHex(hsv.h, hsv.s, hsv.v);
        state.fontWaveColor = hex;
        state.fontWaveEnabled = true;
        applyVisualSettings();
        renderPaletteUi();
      };

      const syncFromState = () => {
        const rgb = hexToRgb(state.fontWaveColor);
        if (rgb) hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        renderPaletteUi();
      };

      btn.onclick = (e) => {
        e.stopPropagation();
        const open = !pop.classList.contains('open');
        if (open) syncFromState();
        pop.classList.toggle('open', open);
        pop.setAttribute('aria-hidden', open ? 'false' : 'true');
      };
      if (doneBtn) {
        doneBtn.onclick = (e) => {
          e.stopPropagation();
          pop.classList.remove('open');
          pop.setAttribute('aria-hidden', 'true');
          saveState();
        };
      }
      pop.onclick = (e) => e.stopPropagation();

      const bindDrag = (el, onMove) => {
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          onMove(e);
          const mm = (ev) => onMove(ev);
          const mu = () => {
            window.removeEventListener('mousemove', mm);
            window.removeEventListener('mouseup', mu);
            saveState();
          };
          window.addEventListener('mousemove', mm);
          window.addEventListener('mouseup', mu);
        });
      };

      bindDrag(svBox, (e) => {
        const rect = svBox.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        hsv.s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        hsv.v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
        applyHsvColor();
      });

      bindDrag(hueBox, (e) => {
        const rect = hueBox.getBoundingClientRect();
        if (!rect.width) return;
        hsv.h = Math.max(0, Math.min(359, Math.round(((e.clientX - rect.left) / rect.width) * 360)));
        applyHsvColor();
      });

      if (hexInp) {
        hexInp.addEventListener('input', () => {
          const val = hexInp.value.trim();
          if (/^#[0-9a-f]{6}$/i.test(val)) {
            state.fontWaveColor = val;
            state.fontWaveEnabled = true;
            applyVisualSettings();
            syncFromState();
            saveState();
          }
        });
      }
    })();

    if ($('opt-font-wave-swatches')) {
      $('opt-font-wave-swatches').onclick = (e) => {
        const sw = e.target.closest('.sp-swatch');
        if (!sw || !sw.dataset.color) return;
        state.fontWaveColor = sw.dataset.color;
        state.fontWaveEnabled = true;
        applyVisualSettings();
        saveState();
      };
    }

    if ($('chk-card-glass')) {
      $('chk-card-glass').onchange = (e) => {
        state.cardGlass = !!e.target.checked;
        applyVisualSettings();
        saveState();
      };
    }

    bindGoldSlider($('sl-card-tilt'), (val) => {
      state.cardTilt = Math.max(0, Math.min(5, val / 100));
      applyVisualSettings();
      saveState();
    });

    bindGoldSlider($('sl-ui-alpha'), (val) => {
      state.uiOpacity = Math.max(0.6, Math.min(1, val / 100));
      applyVisualSettings();
      saveState();
    });

    if ($('opt-dock-motion')) {
      $('opt-dock-motion').onclick = (e) => {
        const chip = e.target.closest('.sp-chip');
        if (!chip || !chip.dataset.motion) return;
        state.dockMotion = chip.dataset.motion;
        applyVisualSettings();
        saveState();
      };
    }

    if ($('opt-capsule-auto')) {
      $('opt-capsule-auto').onclick = (e) => {
        const chip = e.target.closest('.sp-chip');
        if (!chip || chip.dataset.sec === undefined) return;
        state.capsuleAutoCollapseSec = Math.max(0, Number(chip.dataset.sec) || 0);
        applyVisualSettings();
        scheduleCapsuleAutoCollapse();
        saveState();
      };
    }

    if ($('opt-capsule-expand')) {
      $('opt-capsule-expand').onclick = (e) => {
        const chip = e.target.closest('.sp-chip');
        if (!chip || !chip.dataset.mode) return;
        state.capsuleExpandMode = chip.dataset.mode === 'click' ? 'click' : 'hover';
        capsuleHoverExpanded = false;
        applyVisualSettings();
        saveState();
      };
    }

    if ($('chk-defocus-blur')) {
      $('chk-defocus-blur').onchange = (e) => {
        state.defocusBlur = !!e.target.checked;
        applyVisualSettings();
        evalDefocus();
        saveState();
      };
    }
    if ($('chk-side-clock')) {
      $('chk-side-clock').onchange = (e) => {
        state.showSideClock = !!e.target.checked;
        applyVisualSettings();
        saveState();
      };
    }
    if ($('chk-side-drawer')) {
      $('chk-side-drawer').onchange = (e) => {
        state.showSideDrawer = !!e.target.checked;
        applyVisualSettings();
        saveState();
      };
    }
    if ($('chk-dock-enabled')) {
      $('chk-dock-enabled').onchange = (e) => {
        state.dockEnabled = !!e.target.checked;
        applyVisualSettings();
        saveState();
      };
    }
    if ($('chk-sync-cg-set')) {
      $('chk-sync-cg-set').onchange = (e) => {
        state.autoSyncCg = !!e.target.checked;
        applyVisualSettings();
        if (state.autoSyncCg && activeSource === 'local') {
          const tr = DATA.tracks[state.trackIndex];
          if (tr) syncWallpaperToAct(tr.act);
        }
        saveState();
      };
    }

    bindGoldSlider($('sl-particles-set'), (val) => {
      state.particles = val / 100;
      applyVisualSettings();
      saveState();
    });
    bindGoldSlider($('sl-particles'), (val) => {
      state.particles = val / 100;
      applyVisualSettings();
      saveState();
    });
    if ($('chk-footlights')) {
      $('chk-footlights').onchange = (e) => {
        state.footlights = e.target.checked;
        applyVisualSettings();
        saveState();
      };
    }
    if ($('chk-halo')) {
      $('chk-halo').onchange = (e) => {
        state.halo = e.target.checked;
        applyVisualSettings();
        saveState();
      };
    }
    $('vinyl-stage').onclick = togglePlay;

    $('btn-play').onclick = togglePlay;
    $('btn-cap-play').onclick = togglePlay;
    $('btn-prev').onclick = () => stepTrack(-1, false);
    $('btn-cap-prev').onclick = () => stepTrack(-1, false);
    $('btn-next').onclick = () => stepTrack(1, false);
    $('btn-cap-next').onclick = () => stepTrack(1, false);
    $('btn-loop').onclick = cycleLoopForActiveSource;
    if ($('btn-cap-loop')) {
      $('btn-cap-loop').onclick = (e) => { e.stopPropagation(); cycleLoopForActiveSource(); };
    }

    const bindProgressSeek = (el, isCapsule) => {
      if (!el) return;
      let dragging = false;
      const calcRatio = (clientX) => {
        const rect = el.getBoundingClientRect();
        return Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      };
      const applySeek = (ratio, commitAudio) => {
        progressDrag.ratio = ratio;
        const curTr = getCurrentTrack();
        const dur = (audio && audio.duration) || (curTr ? curTr.duration : 0) || 0;
        const pct = ratio * 100;
        $('now-progress-fill').style.width = pct + '%';
        if ($('now-progress-thumb')) $('now-progress-thumb').style.left = pct + '%';
        $('cap-prog-fill').style.width = pct + '%';
        if ($('cap-orb-prog')) $('cap-orb-prog').style.strokeDashoffset = (100 - pct).toFixed(3);
        const tStr = `${fmtTime(ratio * dur)} / ${fmtTime(dur)}`;
        $('now-time').textContent = tStr;
        $('cap-time').textContent = tStr;
        if (commitAudio && audio && isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = ratio * audio.duration;
        }
      };
      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        progressDrag.active = true;
        el.classList.add('dragging');
        if (isCapsule) blockCapsuleOpenUntil = Date.now() + 400;
        applySeek(calcRatio(e.clientX), false);
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        if (isCapsule) blockCapsuleOpenUntil = Date.now() + 400;
        applySeek(calcRatio(e.clientX), false);
      });
      window.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        dragging = false;
        progressDrag.active = false;
        el.classList.remove('dragging');
        if (isCapsule) blockCapsuleOpenUntil = Date.now() + 400;
        applySeek(calcRatio(e.clientX), true);
      });
    };
    bindProgressSeek($('now-progress'), false);
    bindProgressSeek($('cap-prog-track'), true);
    bindProgressSeek($('cp-progress'), false);

    if ($('cp-card')) $('cp-card').onclick = togglePlay;
    if ($('btn-cp-play')) $('btn-cp-play').onclick = togglePlay;
    if ($('btn-cp-bar-prev')) $('btn-cp-bar-prev').onclick = () => stepTrack(-1, false);
    if ($('btn-cp-bar-next')) $('btn-cp-bar-next').onclick = () => stepTrack(1, false);
    if ($('btn-cp-loop')) $('btn-cp-loop').onclick = cycleLoopForActiveSource;
    if ($('btn-cp-theater')) {
      $('btn-cp-theater').onclick = (e) => {
        if (e) e.stopPropagation();
        setUiMode('theater', true);
      };
    }

    const applyDesktopFormat = (fmt) => {
      const mode = fmt === 'card' ? 'card' : 'wallpaper';
      document.body.classList.toggle('desktop-card-mode', mode === 'card');
      localStorage.setItem('nientum_desktop_format', mode);
      document.querySelectorAll('#opt-desktop-format .sp-chip').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.format === mode);
      });
      notifyUiMode(state.uiMode);
      syncCardDynamicState();
      invalidateCpCenterCache();
      invalidateProgressUiCache();
      if (mode === 'card') {
        clearCapsuleTimers();
      } else {
        scheduleCapsuleAutoCollapse();
      }
    };
    applyDesktopFormat(localStorage.getItem('nientum_desktop_format') || 'wallpaper');
    if ($('opt-desktop-format')) {
      $('opt-desktop-format').onclick = (e) => {
        const btn = e.target.closest('.sp-chip');
        if (!btn) return;
        applyDesktopFormat(btn.dataset.format);
      };
    }

    const volPct = Math.round(state.volume * 100);
    setGoldSliderValue($('vol-slider'), volPct);
    $('vol-val').textContent = volPct + '%';
    setGoldSliderValue($('cp-vol-slider'), volPct);
    if ($('cp-vol-val')) $('cp-vol-val').textContent = volPct + '%';
    const onVolumeChange = (val) => {
      state.volume = val / 100;
      setGoldSliderValue($('vol-slider'), val);
      setGoldSliderValue($('cp-vol-slider'), val);
      $('vol-val').textContent = val + '%';
      if ($('cp-vol-val')) $('cp-vol-val').textContent = val + '%';
      if ($('ncm-vol-slider')) setGoldSliderValue($('ncm-vol-slider'), val);
      if ($('ncm-vol-val')) $('ncm-vol-val').textContent = val + '%';
      if (audio) audio.volume = state.volume;
      saveState();
    };
    bindGoldSlider($('vol-slider'), onVolumeChange);
    bindGoldSlider($('cp-vol-slider'), onVolumeChange);

    if ($('btn-set-default')) {
      $('btn-set-default').onclick = () => {
        state.defaultTrackIndex = state.trackIndex;
        saveState();
        updateDefaultTrackBtn();
      };
    }

    if ($('chk-sync-cg')) {
      $('chk-sync-cg').checked = state.autoSyncCg;
      $('chk-sync-cg').onchange = (e) => {
        state.autoSyncCg = !!e.target.checked;
        applyVisualSettings();
        if (state.autoSyncCg && activeSource === 'local') {
          const tr = DATA.tracks[state.trackIndex];
          if (tr) syncWallpaperToAct(tr.act);
        }
        saveState();
      };
    }

    if ($('chk-sync-cg-local')) {
      $('chk-sync-cg-local').checked = !!state.autoSyncCg;
      $('chk-sync-cg-local').onchange = (e) => {
        state.autoSyncCg = !!e.target.checked;
        applyVisualSettings();
        if (state.autoSyncCg && activeSource === 'local') {
          const tr = DATA.tracks[state.trackIndex];
          if (tr) syncWallpaperToAct(tr.act);
        }
        saveState();
      };
    }

    if ($('chk-local-cover-card')) {
      $('chk-local-cover-card').checked = !!state.localCoverToCard;
      $('chk-local-cover-card').onchange = (e) => {
        state.localCoverToCard = !!e.target.checked;
        saveState();
        updateTrackUi();
      };
    }

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.theater-view').forEach(v => v.classList.remove('active'));
        btn.classList.add('active');
        $('view-' + btn.dataset.view).classList.add('active');
        if (btn.dataset.view === 'music') {
          requestAnimationFrame(() => {
            focusPlayingTrackInList(false);
          });
        } else if (btn.dataset.view === 'netease') {
          if (typeof refreshNeteaseStatus === 'function') refreshNeteaseStatus();
          if (typeof renderNcmQuality === 'function') renderNcmQuality();
          if (typeof updateNeteasePlayingRows === 'function') updateNeteasePlayingRows();
          const ncmListNow = $('ncm-card-list');
          if (ncmListNow) ncmScrollPos = ncmScrollTarget = ncmListNow.scrollTop;
          requestAnimationFrame(() => {
            layoutNcmArc();
            const focusId = (activeSource === 'ncm' && ncmPlayQueue[ncmPlayIndex])
              ? ncmPlayQueue[ncmPlayIndex].id
              : ncmSelectedTrackId;
            if (focusId) ncmScrollToTrack(focusId, false);
          });
        }
      };
    });

    document.querySelectorAll('.cat-pill').forEach(pill => {
      pill.onclick = () => {
        document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.wpCat = pill.dataset.cat;
        renderWallpaperCats();
    renderWallpaperGrid();
      };
    });

    window.addEventListener('keydown', (e) => {
      const wpImport = $('wp-import-pop');
      if (wpImport && wpImport.classList.contains('open')) {
        if (e.code === 'Escape') { e.preventDefault(); closeWpImport(); }
        return;
      }
      const ae = document.activeElement;
      const inInput = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT');
      if (inInput) {
        if (e.code === 'Escape') ae.blur();
        return;
      }
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.code === 'ArrowRight') stepTrack(1, false);
      else if (e.code === 'ArrowLeft') stepTrack(-1, false);
      else if (e.code === 'Tab') { e.preventDefault(); setUiMode(state.uiMode === 'theater' ? 'capsule' : 'theater'); }
      else if (e.code === 'Escape' && state.uiMode === 'theater') setUiMode('capsule');
    });

    window.wallpaperPropertyListener = {
      applyUserProperties(props) {
        const firstCall = (lastWeProps === null);
        if (!lastWeProps) lastWeProps = {};
        const changed = (key, val) => {
          const prev = lastWeProps[key];
          lastWeProps[key] = val;
          if (firstCall && hasSavedSettings) return false;
          return prev !== val;
        };

        if (props.ui_mode && changed('ui_mode', props.ui_mode.value)) {
          setUiMode(props.ui_mode.value);
        }
        if (props.ui_opacity && changed('ui_opacity', props.ui_opacity.value)) {
          state.uiOpacity = Number(props.ui_opacity.value) / 100;
        }
        if (props.auto_sync_cg && changed('auto_sync_cg', !!props.auto_sync_cg.value)) {
          state.autoSyncCg = !!props.auto_sync_cg.value;
          if ($('chk-sync-cg')) $('chk-sync-cg').checked = state.autoSyncCg;
          if ($('chk-sync-cg-local')) $('chk-sync-cg-local').checked = state.autoSyncCg;
          if ($('chk-sync-cg-set')) $('chk-sync-cg-set').checked = state.autoSyncCg;
        }
        if (props.particle_density && changed('particle_density', props.particle_density.value)) {
          state.particles = Number(props.particle_density.value) / 100;
        }
        if (props.res_scale && changed('res_scale', props.res_scale.value)) {
          state.resScale = Number(props.res_scale.value);
        }
        if (props.audio_volume && changed('audio_volume', props.audio_volume.value)) {
          state.volume = Number(props.audio_volume.value) / 100;
          const pct = Math.round(state.volume * 100);
          setGoldSliderValue($('vol-slider'), pct);
          $('vol-val').textContent = pct + '%';
          if ($('ncm-vol-slider')) setGoldSliderValue($('ncm-vol-slider'), pct);
          if ($('ncm-vol-val')) $('ncm-vol-val').textContent = pct + '%';
          if (audio) audio.volume = state.volume;
        }
        if (props.fps_limit && changed('fps_limit', props.fps_limit.value)) {
          state.fpsLimit = Number(props.fps_limit.value);
        }
        applyVisualSettings();
        if (!firstCall) saveState();
      },
      setPaused(isPaused) {
        window.NientumStage.setPaused(isPaused);
      }
    };
  }

  function createAudioElement() {
    if (audio) {
      try { audio.pause(); } catch (_) {}
      try { audio.removeAttribute('src'); audio.load(); } catch (_) {}
    }
    const el = new Audio();
    el.preload = (activeSource === 'ncm') ? 'auto' : 'metadata';
    el.loop = (state.loopMode === 'single');
    el.volume = state.volume;
    el.addEventListener('error', () => {
      if (el !== audio) return;
      if (activeSource === 'local' && localAudioRetryState && localAudioRetryState.idx + 1 < localAudioRetryState.cands.length) {
        return;
      }
      // 部分 FLAC/音频在结尾最后几百毫秒读到尾帧/元数据帧时，CEF 会触发 PIPELINE_ERROR_DECODE (3) 而非 ended；
      // 此时曲目已实际播完，直接视为正常结束并切下一首，不报加载失败。
      const curTime = el.currentTime || 0;
      const curTr = getCurrentTrack();
      const curDur = (isFinite(el.duration) && el.duration > 0) ? el.duration : ((curTr && curTr.duration) || 0);
      if (curDur > 5 && curTime >= curDur - 2.5) {
        audioError = '';
        if (!autoEndedGuard) {
          autoEndedGuard = true;
          setTimeout(() => stepTrack(1, true), 80);
        }
        return;
      }
      const code = el.error ? el.error.code : 0;
      console.warn('[Nientum] media error', code, '| src=', el.src);
      if (activeSource === 'ncm') {
        attemptNeteaseReconnect(`media_error_${code || 0}`);
        return;
      }
      audioError = code ? `音频加载失败 (${code})` : '音频加载失败';
      state.playing = false;
      updateTrackUi();
      scheduleAutoSkip();
    });
    el.addEventListener('ended', () => {
      if (el !== audio) return;
      if (autoEndedGuard) return;
      autoEndedGuard = true;
      setTimeout(() => stepTrack(1, true), 80);
    });
    el.addEventListener('timeupdate', () => {
      if (el !== audio || activeSource !== 'ncm') return;
      if (isFinite(el.currentTime) && el.currentTime > 0.5 && ncmPendingSeek <= 0) {
        ncmLastKnownTime = el.currentTime;
      }
    });
    const applyPendingSeek = () => {
      if (el !== audio || ncmPendingSeek <= 0) return;
      const target = ncmPendingSeek;
      try {
        const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
        const clamped = dur > 1 ? Math.min(target, Math.max(0, dur - 0.5)) : target;
        el.currentTime = clamped;
        if (Math.abs((el.currentTime || 0) - clamped) < 2 || el.readyState >= 2) {
          ncmPendingSeek = 0;
        }
      } catch (_) {}
    };
    el.addEventListener('loadedmetadata', applyPendingSeek);
    el.addEventListener('canplay', applyPendingSeek);
    audio = el;
    return el;
  }

  function init() {
    loadSaved();
    if (!LOOP_ORDER.includes(state.loopMode)) state.loopMode = 'list';
    const urlMode = new URLSearchParams(window.location.search).get('mode');
    if (urlMode === 'theater' || urlMode === 'capsule') {
      state.uiMode = urlMode;
    } else if (state.uiMode === 'pure' || urlMode === 'pure') {
      state.uiMode = 'capsule';
    }

    createAudioElement();

    if (typeof window.wallpaperRegisterAudioListener === 'function') {
      try {
        window.wallpaperRegisterAudioListener((arr) => {
          if (arr && arr.length) {
            weAudioData = arr;
            weAudioAt = performance.now();
          }
        });
      } catch (_) {}
    }
    window.NientumStage.init();
    applyVisualSettings();
    updateCanvasScale();
    bindEvents();
    updateLoopUi();

    const rawTrackParam = new URLSearchParams(window.location.search).get('track');
    if (rawTrackParam !== null && rawTrackParam !== '') {
      const urlTrack = Number(rawTrackParam);
      if (!Number.isNaN(urlTrack) && urlTrack >= 0) state.trackIndex = urlTrack;
    } else if (Number.isInteger(state.defaultTrackIndex) && state.defaultTrackIndex >= 0 && state.defaultTrackIndex < DATA.tracks.length) {
      state.trackIndex = state.defaultTrackIndex;
    }
    if (!Number.isInteger(state.trackIndex) || state.trackIndex < 0 || state.trackIndex >= DATA.tracks.length) {
      state.trackIndex = 0;
    }
    selectedIndex = state.trackIndex;
    playScopeChapter = state.chapter;

    setUiMode(state.uiMode);
    selectWallpaperById(state.wallpaperId);
    loadImportedWallpapers().then(() => {
      const cur = DATA.wallpapers.find(w => w.id === state.wallpaperId);
      if (!cur || cur.unsupported) {
        const first = DATA.wallpapers.find(w => !w.unsupported);
        if (first) selectWallpaperById(first.id);
      } else if (String(state.wallpaperId).startsWith('imp_')) {
        selectWallpaperById(state.wallpaperId);
      }
      renderWallpaperCats();
      renderWallpaperGrid();
    });
    renderChapters();
    renderTrackList();
    // 预加载封票合成图（每章 idle/active 各一张），避免切换选中时闪烁
    DATA.chapters.forEach(ch => {
      ['idle', 'active'].forEach(kind => {
        const im = new Image();
        im.src = cardArt({ cover: ch.cover }, kind === 'active');
      });
    });
    ['assets/cards/blank_idle.png', 'assets/cards/blank_active.png'].forEach(src => {
      const im = new Image();
      im.src = src;
    });

    // 默认自动播放当前曲目（发布包不含本地歌曲时只刷新界面，不尝试加载）
    if (window.NIENTUM_NO_LOCAL_MUSIC) {
      updateTrackUi();
    } else {
      playTrackAt(state.trackIndex, true, true);
    }
    requestAnimationFrame(updateProgressLoop);
    bindNeteaseEvents();
    renderNcmQuality();
    // 剧场/桌面卡片模式心跳：让桥接器持续获知有效交互模式（20 秒未更新自动回到胶囊，避免误吞桌面点击）
    setInterval(() => {
      if (state.uiMode === 'theater' || document.body.classList.contains('desktop-card-mode') || window.__nientumDockHovered || window.__nientumPanelActive) {
        notifyUiMode(state.uiMode);
      }
    }, 5000);
    if ($('ncm-card-list') && !$('ncm-card-list').children.length) {
      ncmListMessage('内置网易云代理随壁纸引擎启动；登录或搜索后在这里显示封票列表。');
    }
  }

  async function ncmApi(path) {
    const resp = await fetch(`${NCM_BASE}${path}`, { cache: 'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }

  function currentNcmSongId() {
    if (activeSource !== 'ncm') return '';
    const tr = ncmPlayQueue[ncmPlayIndex] || null;
    if (!tr) return '';
    return String(tr.ncmId || String(tr.id || '').replace(/^ncm_/, ''));
  }

  function flashNcmLikeStatus(msg) {
    const el = $('ncm-now-badge');
    if (!el) return;
    el.textContent = msg;
    if (ncmLikeStatusTimer) clearTimeout(ncmLikeStatusTimer);
    ncmLikeStatusTimer = setTimeout(() => {
      ncmLikeStatusTimer = 0;
      if (el.textContent === msg) updateTrackUi();
    }, 1800);
  }

  function updateNcmLikeUi() {
    const id = currentNcmSongId();
    const show = activeSource === 'ncm' && !!id;
    const liked = !!id && ncmLikedIds.has(id);
    const title = liked ? '取消收藏' : '收藏当前歌曲';
    const glyph = liked ? '♥' : '♡';
    const heart = $('btn-ncm-like');
    if (heart) {
      heart.style.display = show ? 'grid' : 'none';
      heart.classList.toggle('liked', liked);
      heart.classList.toggle('busy', ncmLikeBusy);
      heart.textContent = glyph;
      heart.title = title;
      heart.setAttribute('aria-label', title);
    }
    const capLike = $('btn-cap-like');
    if (capLike) {
      capLike.style.display = show ? 'grid' : 'none';
      capLike.classList.toggle('liked', liked);
      capLike.classList.toggle('busy', ncmLikeBusy);
      capLike.textContent = glyph;
      capLike.title = title;
    }
  }

  async function loadNcmLiked(force) {
    if (!ncmLoggedIn) {
      ncmLikedIds.clear();
      ncmLikedAt = 0;
      updateNcmLikeUi();
      return;
    }
    const now = Date.now();
    if (!force && ncmLikedAt && now - ncmLikedAt < 60000) {
      updateNcmLikeUi();
      return;
    }
    try {
      const res = await ncmApi('/api/liked');
      if (res && res.ok && Array.isArray(res.ids)) {
        ncmLikedIds = new Set(res.ids.map((x) => String(x)));
        ncmLikedAt = Date.now();
      }
    } catch (_) {}
    updateNcmLikeUi();
  }

  async function toggleNcmLike() {
    const id = currentNcmSongId();
    if (!id) return;
    if (!ncmLoggedIn) {
      flashNcmLikeStatus('请先登录网易云');
      return;
    }
    if (ncmLikeBusy) return;
    const next = !ncmLikedIds.has(id);
    ncmLikeBusy = true;
    updateNcmLikeUi();
    try {
      const resp = await fetch(`${NCM_BASE}/api/song/like?id=${encodeURIComponent(id)}&like=${next ? '1' : '0'}`, {
        method: 'POST',
        cache: 'no-store'
      });
      const data = await resp.json();
      if (data && data.ok) {
        if (next) ncmLikedIds.add(id); else ncmLikedIds.delete(id);
        ncmLikedAt = Date.now();
        flashNcmLikeStatus(next ? '已收藏到网易云' : '已取消收藏');
      } else {
        flashNcmLikeStatus((data && data.error) || '收藏失败');
      }
    } catch (_) {
      flashNcmLikeStatus('收藏失败：本地代理未连接');
    } finally {
      ncmLikeBusy = false;
      updateNcmLikeUi();
    }
  }

  // 网易云卡纸用自由选曲同款成品封票底图（画框内为空白纸面，不放章节 CG）
  function ncmPaperSrc(selected) {
    return selected ? 'assets/cards/blank_active.png' : 'assets/cards/blank_idle.png';
  }

  function ncmCoverOf(tr) {
    return (tr && tr.cover) ? tr.cover : 'assets/covers/cover_ending.png';
  }

  let ncmArcRaf = 0;

  // 复刻自由选曲的弧形列表：左侧边界固定，中部卡片整张向右偏移 86px
  function layoutNcmArc() {
    const list = $('ncm-card-list');
    if (!list) return;
    const listH = list.clientHeight;
    if (listH <= 0) return;
    const scrollTop = ncmScrollPos;
    const items = list.querySelectorAll('.ncm-card-item');
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const card = item.firstElementChild;
      if (!card) continue;
      const cy = item.offsetTop + item.offsetHeight * 0.5 - scrollTop;
      const t = Math.max(0, Math.min(1, cy / listH));
      const off = Math.round(86 * Math.sin(Math.PI * t));
      card.style.left = (14 + off).toFixed(1) + 'px';
      const fadeCy = cy + 40;
      const fade = Math.max(0, Math.min(1, Math.min(fadeCy - 10, listH - fadeCy - 10) / 72));
      card.style.opacity = fade.toFixed(3);
    }
  }

  function scheduleNcmArc() {
    if (ncmArcRaf) return;
    ncmArcRaf = requestAnimationFrame(() => {
      ncmArcRaf = 0;
      layoutNcmArc();
    });
  }

  function renderNcmQuality() {
    if (!NCM_LEVELS.includes(state.ncmLevel)) state.ncmLevel = 'exhigh';
    const btn = $('ncm-quality-btn');
    const menu = $('ncm-quality-menu');
    const label = NCM_LEVEL_LABEL[state.ncmLevel] || '极高';
    if (menu) {
      if (!menu.children.length) {
        menu.innerHTML = NCM_LEVELS.map(l => `<button type="button" class="ncm-q-item" data-level="${l}">${NCM_LEVEL_LABEL[l] || l}</button>`).join('');
        menu.querySelectorAll('.ncm-q-item').forEach(item => {
          item.onclick = (e) => {
            e.stopPropagation();
            setNcmLevel(item.dataset.level);
            menu.classList.remove('open');
          };
        });
      }
      menu.querySelectorAll('.ncm-q-item').forEach(item => {
        item.classList.toggle('active', item.dataset.level === state.ncmLevel);
      });
    }
    if (btn) btn.innerHTML = `${label} <span class="ncm-q-caret">▾</span>`;
  }

  function setNcmLevel(level) {
    if (!NCM_LEVELS.includes(level)) return;
    if (state.ncmLevel === level) return;
    state.ncmLevel = level;
    renderNcmQuality();
    saveState();
    if (activeSource === 'ncm' && ncmPlayIndex >= 0 && ncmPlayQueue[ncmPlayIndex]) {
      const wasPlaying = state.playing && !audio.paused;
      if (wasPlaying) {
        ncmPendingSeek = audio.currentTime || 0;
        playNeteaseAt(ncmPlayIndex);
      } else if (audio.src) {
        // 暂停中换音质：只替换音源并保持暂停，下次播放即用新档位
        ncmPendingSeek = audio.currentTime || 0;
        ncmPlayQueue[ncmPlayIndex].ncmResolvedLevel = '';
        resolveNcmMeta(ncmPlayQueue[ncmPlayIndex]);
        audio.src = ncmStreamUrl(ncmPlayQueue[ncmPlayIndex]);
        try { audio.load(); } catch (_) {}
      }
    }
    if ($('ncm-now-badge') && activeSource === 'ncm') {
      const label = NCM_LEVEL_LABEL[state.ncmLevel] || '极高';
      $('ncm-now-badge').textContent = `网易云 · ${label}`;
    }
  }

  function updateNeteasePlayingRows() {
    const list = $('ncm-card-list');
    if (!list) return;
    const playingId = (activeSource === 'ncm' && ncmPlayQueue[ncmPlayIndex]) ? ncmPlayQueue[ncmPlayIndex].id : null;
    const selIdx = Math.max(0, ncmViewTracks.findIndex(t => t.id === ncmSelectedTrackId));
    list.querySelectorAll('.ncm-card-item').forEach((item, i) => {
      const id = item.dataset.id;
      const card = item.firstElementChild;
      item.style.zIndex = String(500 - Math.abs(i - selIdx));
      if (!card) return;
      const selected = !!(ncmSelectedTrackId && id === ncmSelectedTrackId);
      const playing = !!(state.playing && playingId && id === playingId);
      card.classList.toggle('selected', selected);
      card.classList.toggle('playing', playing);
      item.classList.toggle('playing', playing);
      const frame = card.querySelector('.card-img');
      if (frame) {
        const want = ncmPaperSrc(selected);
        if (frame.getAttribute('src') !== want) frame.setAttribute('src', want);
      }
    });
    scheduleNcmArc();
  }

  function renderNeteasePlaylists() {
    const wrap = $('ncm-playlists');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!ncmPlaylists.length) {
      wrap.innerHTML = '<div class="ncm-empty" style="padding:8px 10px;font-size:13px">暂无歌单，登录后自动显示</div>';
      return;
    }
    ncmPlaylists.forEach(pl => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'ncm-pl-chip' + (pl.id === ncmActivePlaylistId ? ' active' : '');
      el.title = `${pl.name} · ${pl.trackCount} 首`;
      el.innerHTML = `<span class="ncm-pl-name">${escapeHtml(pl.name)}</span><span class="ncm-pl-num">${pl.trackCount}</span>`;
      el.onclick = () => {
        ncmActivePlaylistId = pl.id;
        renderNeteasePlaylists();
        loadNeteasePlaylistTracks(pl.id, pl.name);
      };
      wrap.appendChild(el);
    });
  }

  function renderNeteaseTracks(title, tracks) {
    ncmViewTracks = tracks || [];
    if ($('ncm-list-title')) $('ncm-list-title').textContent = title || '曲目列表';
    if ($('ncm-list-count')) {
      $('ncm-list-count').textContent = ncmViewTracks.length
        ? `共 ${ncmViewTracks.length} 首 · 单击选中 / 双击播放`
        : '';
    }
    const list = $('ncm-card-list');
    if (!list) return;
    ncmStopScroll();
    list.innerHTML = '';
    list.scrollTop = 0;
    ncmScrollPos = ncmScrollTarget = 0;
    if (!ncmViewTracks.length) {
      const msg = ncmConnected
        ? '当前列表为空。可以在上方搜索歌曲，或选择一个歌单。'
        : '内置网易云代理正在启动，稍等几秒后点「刷新状态」。';
      list.innerHTML = `<div class="ncm-empty">${msg}</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    let lastClick = { id: '', time: 0 };
    ncmViewTracks.forEach((tr, i) => {
      const selected = ncmSelectedTrackId === tr.id;
      const item = document.createElement('div');
      item.className = 'ncm-card-item';
      item.dataset.id = tr.id;
      item.dataset.index = String(i);
      const sub = [tr.album, fmtTime(tr.duration)].filter(Boolean).join(' · ');
      item.innerHTML = `
        <div class="track-card ncm-track-card${selected ? ' selected' : ''}">
          <img class="card-img" src="${ncmPaperSrc(selected)}" alt="" draggable="false" />
          <div class="ncm-cover"><img src="${escapeHtml(ncmCoverOf(tr))}" loading="lazy" alt="" draggable="false" /></div>
          <div class="ncm-thumb-mark"></div>
          <div class="track-info">
            <div class="track-name">${escapeHtml(tr.title)}</div>
            <div class="track-artist">${escapeHtml(tr.artist || '未知艺术家')}</div>
            <div class="track-sub">${escapeHtml(sub)}</div>
          </div>
          <span class="track-badge"><span class="eq-bars"><i></i><i></i><i></i></span>正在播放</span>
        </div>
      `;
      const card = item.firstElementChild;
      const triggerPlay = () => {
        ncmSelectedTrackId = tr.id;
        playNeteaseAt(i, ncmViewTracks);
      };
      card.onclick = () => {
        const now = performance.now();
        if (lastClick.id === tr.id && (now - lastClick.time) < 250) {
          lastClick = { id: '', time: 0 };
          if (ncmCenterTimer) { clearTimeout(ncmCenterTimer); ncmCenterTimer = 0; }
          triggerPlay();
          return;
        }
        lastClick = { id: tr.id, time: now };
        ncmSelectedTrackId = tr.id;
        updateNeteasePlayingRows();
        // 单击选中也居中，但延后到双击判定之后再滚，避免第一次点击把卡片移走导致双击落空
        if (ncmCenterTimer) clearTimeout(ncmCenterTimer);
        ncmCenterTimer = setTimeout(() => {
          ncmCenterTimer = 0;
          ncmScrollToTrack(tr.id, true);
        }, 260);
      };
      card.ondblclick = (e) => {
        e.preventDefault();
      };
      frag.appendChild(item);
    });
    list.appendChild(frag);
    updateNeteasePlayingRows();
    requestAnimationFrame(() => {
      layoutNcmArc();
      const focusId = (activeSource === 'ncm' && ncmPlayQueue[ncmPlayIndex])
        ? ncmPlayQueue[ncmPlayIndex].id
        : ncmSelectedTrackId;
      if (focusId) ncmScrollToTrack(focusId, false);
    });
  }

  async function loadNeteasePlaylistTracks(id, name) {
    leaveDailyModeIfNeeded();
    if ($('ncm-card-list')) $('ncm-card-list').innerHTML = '<div class="ncm-empty">正在加载歌单曲目...</div>';
    try {
      const res = await ncmApi(`/api/playlist/tracks?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name || '')}`);
      renderNeteaseTracks(name || '歌单曲目', res.tracks || []);
    } catch (_) {
      if ($('ncm-card-list')) $('ncm-card-list').innerHTML = '<div class="ncm-empty">加载歌单失败，请点右上角「刷新状态」或检查登录</div>';
    }
  }

  async function loadNeteasePlaylists() {
    try {
      const res = await ncmApi('/api/playlists');
      ncmPlaylists = res.playlists || [];
      if (ncmPlaylists.length && !ncmActivePlaylistId) {
        ncmActivePlaylistId = ncmPlaylists[0].id;
        renderNeteasePlaylists();
        loadNeteasePlaylistTracks(ncmPlaylists[0].id, ncmPlaylists[0].name);
      } else {
        renderNeteasePlaylists();
      }
    } catch (_) {}
  }

  function stopNeteaseQrPoll() {
    if (ncmQrTimer) {
      clearInterval(ncmQrTimer);
      ncmQrTimer = 0;
    }
  }

  async function startNeteaseQrLogin() {
    stopNeteaseQrPoll();
    const overlay = $('ncm-login-overlay');
    const img = $('ncm-qr-img');
    const ph = $('ncm-qr-placeholder');
    const st = $('ncm-login-status');
    if (overlay) overlay.classList.add('show');
    if (img) img.classList.remove('ready');
    if (ph) { ph.style.display = 'block'; ph.textContent = '正在获取二维码...'; }
    if (st) st.textContent = '请求中...';

    try {
      const res = await ncmApi('/api/qr/create');
      if (!res.ok || !res.qrimg) throw new Error('qr error');
      ncmQrKey = res.key;
      if (img) {
        img.src = res.qrimg;
        img.classList.add('ready');
      }
      if (ph) ph.style.display = 'none';
      if (st) st.textContent = '请使用网易云音乐 App 扫码';

      ncmQrTimer = setInterval(async () => {
        if (!$('view-netease') || !$('view-netease').classList.contains('active')) return;
        try {
          const chk = await ncmApi(`/api/qr/check?key=${encodeURIComponent(ncmQrKey)}`);
          if (chk.code === 800) {
            stopNeteaseQrPoll();
            if (st) st.textContent = '二维码已过期，请点击刷新';
          } else if (chk.code === 801) {
            if (st) st.textContent = '等待扫码...';
          } else if (chk.code === 802) {
            if (st) st.textContent = '已扫码，请在手机上确认登录';
          } else if (chk.code === 803) {
            stopNeteaseQrPoll();
            if (st) st.textContent = '登录成功，正在载入歌单...';
            await refreshNeteaseStatus();
          }
        } catch (_) {}
      }, 2000);
    } catch (_) {
      if (ph) { ph.style.display = 'block'; ph.textContent = '内置网易云代理还没有就绪'; }
      if (st) st.textContent = '代理启动中，几秒后会自动重试';
    }
  }

  async function refreshNeteaseStatus() {
    const nameEl = $('ncm-user-name');
    const subEl = $('ncm-user-sub');
    const avEl = $('ncm-avatar');
    const loginBtn = $('btn-ncm-login');
    const logoutBtn = $('btn-ncm-logout');
    const overlay = $('ncm-login-overlay');
    try {
      const res = await ncmApi('/api/status');
      ncmConnected = true;
      ncmRetryCount = 0;
      notifyUiMode(state.uiMode);
      if (ncmRetryTimer) { clearTimeout(ncmRetryTimer); ncmRetryTimer = 0; }
      ncmLoggedIn = !!(res.loggedIn && res.profile);
      if (ncmLoggedIn) {
        stopNeteaseQrPoll();
        if (overlay) overlay.classList.remove('show');
        if (nameEl) nameEl.textContent = res.profile.nickname || '网易云用户';
        if (subEl) subEl.textContent = res.profile.vipType > 0 ? '黑胶 VIP · 内置代理已连接' : '账号已连接 · 内置代理';
        if (avEl && res.profile.avatarUrl) avEl.src = res.profile.avatarUrl;
        if (loginBtn) loginBtn.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = '';
        await loadNeteasePlaylists();
        loadNcmLiked(true);
      } else {
        if (nameEl) nameEl.textContent = '未登录网易云账号';
        if (subEl) subEl.textContent = '内置代理已连接，请扫码登录';
        if (avEl) avEl.src = 'assets/covers/cover_ending.png';
        if (loginBtn) loginBtn.style.display = '';
        if (logoutBtn) logoutBtn.style.display = 'none';
        ncmLikedIds.clear();
        ncmLikedAt = 0;
        updateNcmLikeUi();
        startNeteaseQrLogin();
      }
    } catch (_) {
      ncmConnected = false;
      ncmLoggedIn = false;
      if (nameEl) nameEl.textContent = '内置网易云代理启动中…';
      if (subEl) subEl.textContent = '随 Wallpaper Engine 自动启动，无需手动开服务';
      if (loginBtn) loginBtn.style.display = '';
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (overlay) overlay.classList.add('show');
      if ($('ncm-qr-img')) $('ncm-qr-img').classList.remove('ready');
      if ($('ncm-qr-placeholder')) {
        $('ncm-qr-placeholder').style.display = 'block';
        $('ncm-qr-placeholder').textContent = '正在等待内置代理就绪…';
      }
      if ($('ncm-login-status')) $('ncm-login-status').textContent = '代理启动中，几秒后自动重试';
      if (ncmRetryCount < 10) {
        ncmRetryCount++;
        if (ncmRetryTimer) clearTimeout(ncmRetryTimer);
        ncmRetryTimer = setTimeout(() => { refreshNeteaseStatus(); }, 2500);
      }
    }
  }

  function bindVerticalDragScroll(el) {
    if (!el) return;
    let dragging = false, startY = 0, startScroll = 0, moved = 0;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (el.id === 'ncm-card-list') {
        if (ncmCenterTimer) { clearTimeout(ncmCenterTimer); ncmCenterTimer = 0; }
        ncmStopScroll();
        ncmScrollPos = ncmScrollTarget = el.scrollTop;
      }
      dragging = true;
      startY = e.clientY;
      startScroll = el.scrollTop;
      moved = 0;
      el.classList.add('dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const scale = window.innerWidth / 1920 || 1;
      const dy = (e.clientY - startY) / scale;
      moved = Math.max(moved, Math.abs(dy));
      el.scrollTop = startScroll - dy;
      if (el.id === 'ncm-card-list') {
        ncmScrollPos = ncmScrollTarget = el.scrollTop;
        layoutNcmArc();
      }
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
    });
    el.addEventListener('click', (e) => {
      if (moved > 6) {
        e.stopPropagation();
        e.preventDefault();
        moved = 0;
      }
    }, true);
  }

  function ncmListMessage(msg) {
    const list = $('ncm-card-list');
    if (list) list.innerHTML = `<div class="ncm-empty">${msg}</div>`;
  }

  function playSelectedNetease() {
    if (activeSource === 'ncm' && audio.src) { togglePlay(); return; }
    if (!ncmViewTracks.length) { ncmListMessage('请先选择一个歌单或搜索歌曲'); return; }
    let idx = ncmViewTracks.findIndex(t => t.id === ncmSelectedTrackId);
    if (idx < 0) idx = 0;
    ncmSelectedTrackId = ncmViewTracks[idx].id;
    playNeteaseAt(idx, ncmViewTracks);
  }

  function bindNcmProgressSeek() {
    const el = $('ncm-now-progress');
    if (!el) return;
    let dragging = false;
    const calcRatio = (clientX) => {
      const rect = el.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    };
    const apply = (ratio, commitAudio) => {
      progressDrag.ratio = ratio;
      const curTr = getCurrentTrack();
      const dur = (audio && audio.duration) || (curTr ? curTr.duration : 0) || 0;
      const pct = ratio * 100;
      if ($('ncm-now-progress-fill')) $('ncm-now-progress-fill').style.width = pct + '%';
      if ($('ncm-now-progress-thumb')) $('ncm-now-progress-thumb').style.left = pct + '%';
      if ($('ncm-now-time')) $('ncm-now-time').textContent = `${fmtTime(ratio * dur)} / ${fmtTime(dur)}`;
      if (commitAudio && audio && isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = ratio * audio.duration;
      }
    };
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      progressDrag.active = true;
      el.classList.add('dragging');
      apply(calcRatio(e.clientX), false);
    });
    window.addEventListener('mousemove', (e) => {
      if (dragging) apply(calcRatio(e.clientX), false);
    });
    window.addEventListener('mouseup', (e) => {
      if (!dragging) return;
      dragging = false;
      progressDrag.active = false;
      el.classList.remove('dragging');
      apply(calcRatio(e.clientX), true);
    });
  }

  function bindNeteaseEvents() {
    bindVerticalDragScroll($('ncm-playlists'));
    bindVerticalDragScroll($('ncm-card-list'));
    bindNcmProgressSeek();
    if ($('ncm-card-list')) $('ncm-card-list').addEventListener('scroll', () => {
      const list = $('ncm-card-list');
      if (!list) return;
      if (ncmCenterTimer) { clearTimeout(ncmCenterTimer); ncmCenterTimer = 0; }
      // 动画期间以 ncmScrollPos 为准；用户拖原生滚动条时数值会明显偏离，立即接管
      if (ncmScrollRaf) {
        if (Math.abs(list.scrollTop - ncmScrollPos) > 4) {
          ncmStopScroll();
          ncmScrollPos = ncmScrollTarget = list.scrollTop;
        }
      } else {
        ncmScrollPos = ncmScrollTarget = list.scrollTop;
      }
      scheduleNcmArc();
    }, { passive: true });
    window.addEventListener('resize', scheduleNcmArc);

    if ($('btn-ncm-retry')) $('btn-ncm-retry').onclick = () => { ncmRetryCount = 0; refreshNeteaseStatus(); };
    if ($('btn-ncm-login')) $('btn-ncm-login').onclick = startNeteaseQrLogin;
    if ($('btn-ncm-qr-refresh')) $('btn-ncm-qr-refresh').onclick = startNeteaseQrLogin;
    if ($('btn-ncm-guest-search')) {
      $('btn-ncm-guest-search').onclick = () => {
        if ($('ncm-login-overlay')) $('ncm-login-overlay').classList.remove('show');
        if ($('ncm-search-inp')) $('ncm-search-inp').focus();
      };
    }
    if ($('btn-ncm-logout')) {
      $('btn-ncm-logout').onclick = async () => {
        try { await ncmApi('/api/logout'); } catch (_) {}
        ncmLikedIds.clear();
        ncmLikedAt = 0;
        updateNcmLikeUi();
        ncmPlaylists = [];
        ncmActivePlaylistId = null;
        renderNeteasePlaylists();
        renderNeteaseTracks('曲目列表', []);
        refreshNeteaseStatus();
      };
    }

    // 播放控制
    if ($('btn-ncm-play')) $('btn-ncm-play').onclick = playSelectedNetease;
    if ($('btn-ncm-prev')) $('btn-ncm-prev').onclick = () => {
      if (activeSource === 'ncm' && ncmPlayQueue.length) { stepTrack(-1, false); return; }
      if (ncmViewTracks.length) { ncmSelectedTrackId = ncmViewTracks[0].id; playNeteaseAt(0, ncmViewTracks); }
    };
    if ($('btn-ncm-next')) $('btn-ncm-next').onclick = () => {
      if (activeSource === 'ncm' && ncmPlayQueue.length) { stepTrack(1, false); return; }
      if (ncmViewTracks.length) { ncmSelectedTrackId = ncmViewTracks[0].id; playNeteaseAt(0, ncmViewTracks); }
    };
    if ($('btn-ncm-loop')) $('btn-ncm-loop').onclick = cycleNcmLoopMode;
    if ($('btn-ncm-like')) $('btn-ncm-like').onclick = toggleNcmLike;
    if ($('btn-cap-like')) $('btn-cap-like').onclick = toggleNcmLike;
    if ($('ncm-vinyl-stage')) $('ncm-vinyl-stage').onclick = playSelectedNetease;
    if ($('chk-ncm-cover-card')) {
      $('chk-ncm-cover-card').checked = !!state.ncmCoverToCard;
      $('chk-ncm-cover-card').onchange = (e) => {
        state.ncmCoverToCard = !!e.target.checked;
        saveState();
        updateTrackUi();
      };
    }
    if ($('chk-ncm-lyric')) {
      $('chk-ncm-lyric').checked = state.ncmLyricEnabled !== false;
      $('chk-ncm-lyric').onchange = (e) => {
        state.ncmLyricEnabled = !!e.target.checked;
        saveState();
        updateDesktopLyric(audio ? (audio.currentTime || 0) : 0);
      };
    }

    // 音量（与自由选曲共用同一个音量状态）
    const ncmVolPct = Math.round(state.volume * 100);
    setGoldSliderValue($('ncm-vol-slider'), ncmVolPct);
    if ($('ncm-vol-val')) $('ncm-vol-val').textContent = ncmVolPct + '%';
    bindGoldSlider($('ncm-vol-slider'), (val) => {
      state.volume = val / 100;
      if (audio) audio.volume = state.volume;
      setGoldSliderValue($('vol-slider'), val);
      if ($('vol-val')) $('vol-val').textContent = val + '%';
      if ($('ncm-vol-val')) $('ncm-vol-val').textContent = val + '%';
      saveState();
    });

    // 音质
    renderNcmQuality();
    if ($('ncm-quality-btn') && $('ncm-quality-menu')) {
      $('ncm-quality-btn').onclick = (e) => {
        e.stopPropagation();
        $('ncm-quality-menu').classList.toggle('open');
      };
      document.addEventListener('click', (e) => {
        const menu = $('ncm-quality-menu');
        if (menu && !e.target.closest('#ncm-quality-box')) menu.classList.remove('open');
      });
    }

    const NCM_HIST_KEY = 'nientum_ncm_search_history_v1';
    const defaultTags = ['Nientum', 'Liora', 'QueseraGames', 'Memory', 'Prelude', '纯音乐', '钢琴'];
    const loadSearchHistory = () => {
      try {
        const arr = JSON.parse(localStorage.getItem(NCM_HIST_KEY) || '[]');
        return Array.isArray(arr) ? arr : [];
      } catch (_) { return []; }
    };
    const saveSearchHistory = (kw) => {
      try {
        const list = [kw, ...loadSearchHistory().filter(x => x !== kw)].slice(0, 8);
        localStorage.setItem(NCM_HIST_KEY, JSON.stringify(list));
      } catch (_) {}
    };

    const kbdPop = $('ncm-kbd-pop');
    const renderNcmTags = () => {
      const wrap = $('ncm-kbd-tags');
      if (!wrap) return;
      const merged = Array.from(new Set([...loadSearchHistory(), ...defaultTags])).slice(0, 10);
      wrap.innerHTML = '';
      merged.forEach(word => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ncm-kbd-tag';
        b.textContent = word;
        b.onclick = () => {
          if ($('ncm-search-inp')) $('ncm-search-inp').value = word;
          doSearch();
        };
        wrap.appendChild(b);
      });
    };

    const renderNcmKeyboard = () => {
      const box = $('ncm-kbd-rows');
      if (!box || box.childElementCount) return;
      const rows = [
        ['1','2','3','4','5','6','7','8','9','0','⌫'],
        ['q','w','e','r','t','y','u','i','o','p'],
        ['a','s','d','f','g','h','j','k','l'],
        ['z','x','c','v','b','n','m','清空','空格','搜索']
      ];
      rows.forEach(r => {
        const rowEl = document.createElement('div');
        rowEl.className = 'ncm-kbd-row';
        r.forEach(ch => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = ch;
          btn.className = 'ncm-key' +
            (ch === '空格' ? ' space' : (ch === '搜索' ? ' go' : (ch.length > 1 ? ' wide' : '')));
          btn.onclick = (e) => {
            e.stopPropagation();
            const inp = $('ncm-search-inp');
            if (!inp) return;
            if (ch === '⌫') inp.value = inp.value.slice(0, -1);
            else if (ch === '清空') inp.value = '';
            else if (ch === '空格') inp.value += ' ';
            else if (ch === '搜索') { doSearch(); return; }
            else inp.value += ch;
          };
          rowEl.appendChild(btn);
        });
        box.appendChild(rowEl);
      });
    };

    const toggleNcmKbd = (forceOpen) => {
      if (!kbdPop) return;
      const next = (typeof forceOpen === 'boolean') ? forceOpen : !kbdPop.classList.contains('open');
      if (next) {
        renderNcmTags();
        renderNcmKeyboard();
      }
      kbdPop.classList.toggle('open', next);
      kbdPop.setAttribute('aria-hidden', next ? 'false' : 'true');
    };

    const doSearch = async () => {
      const kw = ($('ncm-search-inp') ? $('ncm-search-inp').value : '').trim();
      if (!kw) return;
      leaveDailyModeIfNeeded();
      saveSearchHistory(kw);
      toggleNcmKbd(false);
      if ($('ncm-login-overlay')) $('ncm-login-overlay').classList.remove('show');
      ncmListMessage('正在搜索...');
      try {
        const res = await ncmApi(`/api/search?keywords=${encodeURIComponent(kw)}`);
        ncmSelectedTrackId = null;
        renderNeteaseTracks(`搜索：${kw}`, res.tracks || []);
      } catch (_) {
        ncmListMessage('搜索失败，请点「刷新状态」确认内置代理已启动');
      }
    };
    if ($('btn-ncm-search')) $('btn-ncm-search').onclick = doSearch;
    if ($('btn-ncm-kbd')) $('btn-ncm-kbd').onclick = (e) => { e.stopPropagation(); toggleNcmKbd(); };
    if ($('btn-ncm-kbd-close')) $('btn-ncm-kbd-close').onclick = (e) => { e.stopPropagation(); toggleNcmKbd(false); };
    if ($('btn-ncm-native-box')) {
      $('btn-ncm-native-box').onclick = (e) => {
        e.stopPropagation();
        toggleNcmKbd(false);
        if ($('ncm-search-inp')) notifyInputFocus(true, $('ncm-search-inp'));
      };
    }
    if ($('btn-ncm-paste')) {
      $('btn-ncm-paste').onclick = async (e) => {
        e.stopPropagation();
        let clipText = '';
        try {
          const r = await ncmApi('/api/clipboard');
          clipText = (r && r.text) ? String(r.text).trim() : '';
        } catch (_) {}
        if (!clipText && navigator.clipboard && navigator.clipboard.readText) {
          try { clipText = (await navigator.clipboard.readText() || '').trim(); } catch (_) {}
        }
        if (clipText && $('ncm-search-inp')) {
          $('ncm-search-inp').value = clipText;
          doSearch();
        } else {
          ncmListMessage('剪贴板为空，请先复制歌名后再点击「📋 粘贴」');
        }
      };
    }
    if ($('ncm-search-inp')) {
      $('ncm-search-inp').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!nativeInputBridgeReady) toggleNcmKbd(true);
      });
      $('ncm-search-inp').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doSearch();
        }
      });
    }
    document.addEventListener('click', (e) => {
      if (kbdPop && kbdPop.classList.contains('open') && !e.target.closest('.ncm-search-box')) {
        toggleNcmKbd(false);
      }
    });
  }

  function renderCardPlayerDots() {
    const wrap = $('cp-dots');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (activeSource === 'ncm') {
      wrap.style.display = 'none';
      return;
    }
    const curTr = DATA.tracks[state.trackIndex];
    const chRows = curTr ? getChapterTracks(curTr.act) : [];
    if (!chRows.length) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'flex';
    chRows.forEach((row, i) => {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'cp-dot' + (row.idx === state.trackIndex ? ' active' : '');
      d.title = `${i + 1}. ${row.track ? row.track.title : ''}`;
      d.onclick = () => playTrackAt(row.idx, true, true);
      wrap.appendChild(d);
    });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
