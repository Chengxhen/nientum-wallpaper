(() => {
  'use strict';

  const API_BASE = 'http://127.0.0.1:17988';
  const LOCAL_SLOTS_KEY = 'nientum_dock_slots_v1';
  const ROW_STRIDE = 114;
  const MOTION_PRESETS = {
    snappy: { durMs: 280, lerp: 0.22 },
    normal: { durMs: 440, lerp: 0.14 },
    soft:   { durMs: 640, lerp: 0.095 },
    silk:   { durMs: 880, lerp: 0.065 }
  };

  const CARD_THEMES = [
    { id: 'cover_act0', label: '序章' },
    { id: 'cover_act1', label: '第一章' },
    { id: 'cover_act2', label: '第二章' },
    { id: 'cover_act3', label: '第三章' },
    { id: 'cover_act4', label: '第四章' },
    { id: 'cover_act5', label: '第五章' },
    { id: 'cover_act6', label: '第六章' },
    { id: 'cover_act7', label: '第七章' },
    { id: 'cover_act8', label: '第八章' },
    { id: 'cover_act9', label: '第九章' },
    { id: 'cover_actu', label: '番外' },
    { id: 'cover_ending', label: '终章' },
    { id: 'cover_other', label: '其他' },
    { id: 'cover_unclassified', label: '未分类' },
    { id: 'blank', label: '空白票根' }
  ];

  const DEFAULT_SLOTS = [
    { id: 'slot_desktop', title: '桌面', path: '@desktop', card: 'cover_act0' },
    { id: 'slot_downloads', title: '下载', path: '@downloads', card: 'cover_act1' },
    { id: 'slot_documents', title: '文档', path: '@documents', card: 'cover_act2' },
    { id: 'slot_pictures', title: '图片', path: '@pictures', card: 'cover_act3' }
  ];

  let slots = DEFAULT_SLOTS.slice();
  let selectedIndex = 0; // 当前居中选中的索引（包含末尾「＋ 添加封票」票根）
  let editingSlotId = null;
  let popoverMode = ''; // 'icon' | 'rename' | ''
  let drawerSlotId = null;
  let drawerDir = '';
  let drawerParent = '';
  let drawerItems = [];
  let drawerFilter = '';
  let cgDwellTimer = 0;
  let cgDwellCard = null;
  let dockHovered = false;
  let dockEnabled = true;
  let dockMotion = 'soft';
  let hoverLeaveTimer = 0;
  let lastCardClick = { idx: -1, time: 0 };
  let lastDrawerClick = { idx: -1, time: 0, x: 0, y: 0 };
  let lastOpenAt = 0;
  let ignoreMouseOutUntil = 0;
  let wheelStepCooldownUntil = 0;
  let lastMouseClientX = 0;
  let lastMouseClientY = 0;
  let lastMouseInDrawer = false;
  let lastMouseInPopover = false;
  let toastTimer = 0;
  let suppressTicketClickUntil = 0;
  let suppressDrawerClickUntil = 0;
  let drawerDragActive = false;

  const LONG_PRESS_MS = 320;
  const PRESS_MOVE_TOLERANCE = 12;
  const dragState = {
    mouseDown: false,
    timer: 0,
    active: false,
    slotId: null,
    origIdx: -1,
    curIdx: -1,
    cardEl: null,
    startClientX: 0,
    startClientY: 0,
    lastClientY: 0,
    startCy: 0,
    autoScrollRaf: 0
  };

  // 纯状态驱动弧形滚动（对齐 player.js 的自由选曲选中居中逻辑）
  let scrollPos = 0;
  let scrollTarget = 0;
  let scrollRaf = 0;               // 兼容旧引用，已不再单独使用
  let scrollVel = 0;
  // 弹出程度 0 = 收起，1 = 展开；与滚动位置在同一个帧循环里用临界阻尼弹簧驱动，
  // 这样滚动途中移开鼠标也有完整的收回动画，且滚动收尾干脆、不拖泥带水。
  let exposeT = 0;
  let exposeVel = 0;
  let dockAnimRaf = 0;
  let dockAnimLastAt = 0;
  let dockAnimSyncSel = false;
  const DOCK_SMOOTH = { snappy: 0.06, normal: 0.085, soft: 0.11, silk: 0.15 };
  let snapTimer = 0;

  const _elCache = Object.create(null);
  const $ = (id) => _elCache[id] || (_elCache[id] = document.getElementById(id));

  function isCustomCard(cardBase) {
    return typeof cardBase === 'string' && cardBase.startsWith('custom:');
  }

  function cardImgSrc(cardBase, active) {
    const base = cardBase || 'cover_act0';
    if (isCustomCard(base)) {
      const file = base.slice(7);
      return `${API_BASE}/api/fs/custom-card?file=${encodeURIComponent(file)}`;
    }
    return `assets/cards/${base}${active ? '_active' : '_idle'}.png`;
  }

  function getMotionPreset() {
    return MOTION_PRESETS[dockMotion] || MOTION_PRESETS.soft;
  }

  function updateDockScale() {
    const dock = $('desktop-ticket-dock');
    if (!dock) return;
    const scale = window.innerWidth / 1920;
    dock.style.zoom = scale.toFixed(6);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(msg) {
    const el = $('dock-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      toastTimer = 0;
    }, 3200);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function apiGet(path, retries = 2) {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
        if (!res.ok && res.status !== 404) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (err) {
        lastErr = err;
        if (i < retries) await sleep(400 + i * 400);
      }
    }
    throw lastErr || new Error('连接失败');
  }

  async function apiPost(path, data, retries = 2) {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(`${API_BASE}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data || {})
        });
        if (res.status === 404) {
          return { ok: false, status: 404, error: '本地服务版本较旧，请重启 NientumBridge / 壁纸' };
        }
        if (!res.ok && res.status >= 500) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (err) {
        lastErr = err;
        if (i < retries) await sleep(400 + i * 400);
      }
    }
    throw lastErr || new Error('连接失败');
  }

  function totalItemCount() {
    return slots.length + 1; // 末尾含一张「＋ 添加封票」空白票根
  }

  function maxScroll() {
    return Math.max(0, (totalItemCount() - 1) * ROW_STRIDE);
  }

  function formatSize(bytes) {
    if (!bytes || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function itemIcon(item) {
    if (item.isDir) return '📁';
    const ext = (item.ext || '').toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'].includes(ext)) return '🖼';
    if (['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a'].includes(ext)) return '🎵';
    if (['.mp4', '.mkv', '.avi', '.mov', '.webm'].includes(ext)) return '🎬';
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) return '📦';
    if (['.exe', '.msi', '.lnk', '.bat', '.cmd'].includes(ext)) return '⚡';
    if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md'].includes(ext)) return '📄';
    return '📃';
  }

  function isDockExpanded() {
    return dockHovered || !!editingSlotId || !!drawerSlotId;
  }

  function smoothDamp(cur, target, vel, st, dt) {
    if (dt <= 0) return [cur, vel];
    const omega = 2 / st;
    const x = omega * dt;
    const ex = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = cur - target;
    const temp = (vel + omega * change) * dt;
    let nv = (vel - omega * temp) * ex;
    let out = target + (change + temp) * ex;
    if ((target - cur > 0) === (out > target)) { out = target; nv = 0; } // 不过冲
    return [out, nv];
  }

  function ensureDockAnim(syncSel) {
    if (syncSel) dockAnimSyncSel = true;
    if (dockAnimRaf) return;
    const dock = $('desktop-ticket-dock');
    if (dock) dock.classList.add('dock-js-anim');
    dockAnimLastAt = performance.now();
    dockAnimRaf = requestAnimationFrame(dockAnimTick);
  }

  function dockAnimTick(now) {
    const t = now || performance.now();
    const dt = Math.max(0, Math.min(0.05, (t - dockAnimLastAt) / 1000));
    dockAnimLastAt = t;
    const st = DOCK_SMOOTH[dockMotion] || DOCK_SMOOTH.soft;

    let doneS = Math.abs(scrollTarget - scrollPos) < 0.3 && Math.abs(scrollVel) < 6;
    if (doneS) { scrollPos = scrollTarget; scrollVel = 0; }
    else { const r = smoothDamp(scrollPos, scrollTarget, scrollVel, st, dt); scrollPos = r[0]; scrollVel = r[1]; }

    const eTarget = isDockExpanded() ? 1 : 0;
    let doneE = Math.abs(eTarget - exposeT) < 0.002 && Math.abs(exposeVel) < 0.04;
    if (doneE) { exposeT = eTarget; exposeVel = 0; }
    else { const r = smoothDamp(exposeT, eTarget, exposeVel, st * 1.15, dt); exposeT = r[0]; exposeVel = r[1]; }

    layoutDockCards(dockAnimSyncSel);
    if (doneS && doneE) {
      dockAnimRaf = 0;
      dockAnimSyncSel = false;
      const dock = $('desktop-ticket-dock');
      if (dock) dock.classList.remove('dock-js-anim');
      return;
    }
    dockAnimRaf = requestAnimationFrame(dockAnimTick);
  }

  function syncDockOpenClass() {
    const dock = $('desktop-ticket-dock');
    const expanded = isDockExpanded();
    if (Math.abs((expanded ? 1 : 0) - exposeT) > 0.001) ensureDockAnim(false);
    if (dock) {
      dock.style.setProperty('--dock-dur', getMotionPreset().durMs + 'ms');
      dock.classList.toggle('dock-open', expanded);
      dock.classList.toggle('dock-hidden', !dockEnabled);
    }
    if (window.__nientumBridge && typeof window.__nientumBridge.setDockActive === 'function') {
      window.__nientumBridge.setDockActive(dockEnabled && expanded);
    }
    if (window.__nientumBridge && typeof window.__nientumBridge.setUiHover === 'function') {
      window.__nientumBridge.setUiHover('dock', dockEnabled && expanded);
    }
  }

  function applyDockSettings(cfg) {
    if (!cfg) return;
    dockEnabled = cfg.dockEnabled !== false;
    dockMotion = MOTION_PRESETS[cfg.dockMotion] ? cfg.dockMotion : 'soft';
    if (!dockEnabled) {
      dockHovered = false;
      editingSlotId = null;
      popoverMode = '';
      closeDrawer(true);
      if ($('dock-popover')) $('dock-popover').classList.remove('open');
    }
    syncDockOpenClass();
    layoutDockCards(false);
  }

  function syncSelectionFromScroll() {
    const list = $('dock-tickets');
    if (!list) return;
    const count = totalItemCount();
    if (!count) return;
    const centerIdx = Math.max(0, Math.min(count - 1, Math.round(scrollPos / ROW_STRIDE)));
    if (centerIdx === selectedIndex && list.children[centerIdx]?.classList.contains('selected')) {
      return;
    }
    selectedIndex = centerIdx;
    updateCardSelectionClasses();
  }

  // 预加载并解码封票的选中/未选中两张图，滚动切换选中项时直接命中缓存
  const _cardImgWarm = new Set();
  function warmCardImages(cardBase) {
    [true, false].forEach((active) => {
      const src = cardImgSrc(cardBase, active);
      if (_cardImgWarm.has(src)) return;
      _cardImgWarm.add(src);
      const im = new Image();
      im.decoding = 'async';
      im.src = src;
      if (im.decode) im.decode().catch(() => {});
    });
  }

  function updateCardSelectionClasses() {
    const list = $('dock-tickets');
    if (!list) return;
    const cards = list.children;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const isSelected = i === selectedIndex;
      const cardBase = card.dataset.card || 'cover_act0';
      warmCardImages(cardBase);
      if (card.classList.contains('selected') !== isSelected) card.classList.toggle('selected', isSelected);
      const z = String(500 - Math.abs(i - selectedIndex));
      if (card.style.zIndex !== z) card.style.zIndex = z;
      const img = card.querySelector('.dock-ticket-bg');
      if (img) {
        const want = cardImgSrc(cardBase, isSelected);
        if (img.getAttribute('src') !== want) img.setAttribute('src', want);
      }
    }
  }

  // 核心：镜像复刻自由选曲的弧线排版与选中居中
  function layoutDockCards(syncSelection) {
    const vp = $('dock-scroll-viewport');
    const list = $('dock-tickets');
    if (!vp || !list) return;
    const listH = vp.clientHeight || 840;
    const centerY = listH * 0.5;
    if (syncSelection) syncSelectionFromScroll();

    const cards = list.children;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (dragState.active && card === dragState.cardEl) continue;
      const selected = i === selectedIndex;
      const w = selected ? 922 : 900;
      const h = selected ? 148 : 134;
      const cy = centerY + i * ROW_STRIDE - scrollPos;
      const fade = Math.max(0, Math.min(1, Math.min(cy - 18, listH - cy - 18) / 86));
      if (fade <= 0.02) {
        if (card.style.display !== 'none') { card.style.display = 'none'; card._dkOp = card._dkTf = ''; }
        continue;
      }
      if (card.style.display !== 'block') card.style.display = 'block';

      const t = Math.max(0, Math.min(1, cy / listH));
      const arcCurve = Math.sin(Math.PI * t);

      // 收起时仅在屏幕最右侧露边；悬停展开时按弧线向左弹出，居中选中项弹出 492px，未选中项弹出 356~438px 以完整展示标题文字
      const openPx = selected ? 492 : (356 + Math.round(82 * arcCurve));
      const closedPx = selected ? 76 : (48 + Math.round(22 * arcCurve));
      const exposePx = closedPx + (openPx - closedPx) * exposeT;

      const tx = w - exposePx;
      const top = cy - h * 0.5;
      const op = fade >= 0.995 ? '1' : fade.toFixed(2);
      if (card._dkOp !== op) { card._dkOp = op; card.style.opacity = op; }
      const tf = `translate3d(${tx.toFixed(1)}px, ${top.toFixed(1)}px, 0)`;
      if (card._dkTf !== tf) { card._dkTf = tf; card.style.transform = tf; }
    }
  }

  function centerSelectedCard(smooth) {
    const count = totalItemCount();
    if (!count) return;
    selectedIndex = Math.max(0, Math.min(count - 1, selectedIndex));
    updateCardSelectionClasses();
    const target = Math.max(0, Math.min(maxScroll(), selectedIndex * ROW_STRIDE));
    if (!smooth) {
      scrollVel = 0;
      scrollPos = scrollTarget = target;
      layoutDockCards(false);
      return;
    }
    scrollTarget = target;
    startScrollAnim(false);
  }

  function startScrollAnim(syncSel) {
    ensureDockAnim(syncSel);
  }

  async function loadSlots() {
    try {
      const localRaw = localStorage.getItem(LOCAL_SLOTS_KEY);
      if (localRaw) {
        const parsed = JSON.parse(localRaw);
        if (Array.isArray(parsed) && parsed.length) slots = parsed;
      }
    } catch (_) {}
    selectedIndex = Math.floor(Math.max(0, totalItemCount() - 1) / 2);
    renderTickets();
    try {
      const res = await apiGet('/api/fs/slots');
      if (res && res.ok && Array.isArray(res.slots) && res.slots.length) {
        slots = res.slots;
        try { localStorage.setItem(LOCAL_SLOTS_KEY, JSON.stringify(slots)); } catch (_) {}
        selectedIndex = Math.floor(Math.max(0, totalItemCount() - 1) / 2);
        renderTickets();
      }
    } catch (_) {}
  }

  async function saveSlots() {
    try { localStorage.setItem(LOCAL_SLOTS_KEY, JSON.stringify(slots)); } catch (_) {}
    try {
      await apiPost('/api/fs/slots', { slots });
    } catch (_) {}
  }

  function getEditingSlot() {
    return slots.find(s => s.id === editingSlotId) || null;
  }

  function openWindowsFolder(slot) {
    if (!slot) return;
    const now = performance.now();
    if (now - lastOpenAt < 350) return;
    lastOpenAt = now;
    apiPost('/api/fs/open', { path: slot.path, reveal: false })
      .then((res) => {
        if (res && !res.ok && res.error) showToast(res.error);
      })
      .catch(() => {
        showToast('未连接本地桌面服务，请重启 NientumBridge / 壁纸');
      });
  }

  async function pickAndBindFolder(slot) {
    try {
      const res = await apiPost('/api/fs/pick-folder', {});
      if (!res || !res.ok || !res.path) return;
      slot.path = res.path;
      if (res.name) slot.title = res.name;
      await saveSlots();
      renderTickets();
      showToast(`已定位到：${slot.path}`);
    } catch (_) {
      showToast('未连接本地桥接服务，请先运行「Nientum_Bridge\\NientumBridge.exe」');
    }
  }

  async function handleAddFolder() {
    try {
      const res = await apiPost('/api/fs/pick-folder', {});
      if (!res || !res.ok || !res.path) return;
      const theme = CARD_THEMES[slots.length % CARD_THEMES.length];
      const newSlot = {
        id: 'slot_' + Date.now(),
        title: res.name || '文件夹',
        path: res.path,
        card: theme.id
      };
      slots.push(newSlot);
      selectedIndex = slots.length - 1;
      await saveSlots();
      renderTickets();
      centerSelectedCard(true);
    } catch (_) {
      showToast('未连接本地桥接服务，请先运行「Nientum_Bridge\\NientumBridge.exe」');
    }
  }

  function clearCgDwell() {
    if (cgDwellTimer) {
      clearTimeout(cgDwellTimer);
      cgDwellTimer = 0;
    }
    if (cgDwellCard) {
      cgDwellCard.classList.remove('cg-dwelling');
      cgDwellCard = null;
    }
  }

  function closeDrawer(silent) {
    drawerSlotId = null;
    const dr = $('dock-drawer');
    if (dr) dr.classList.remove('open');
    if (!silent) {
      syncDockOpenClass();
      layoutDockCards(false);
    }
  }

  async function openDrawerForSlot(slot) {
    if (!slot) return;
    if (editingSlotId) closePopover();
    drawerSlotId = slot.id;
    drawerFilter = '';
    if ($('dock-search')) $('dock-search').value = '';
    syncDockOpenClass();
    layoutDockCards(false);
    await loadDrawerDir(slot.path, slot.title);
  }

  async function loadDrawerDir(targetPath, titleHint) {
    const dr = $('dock-drawer');
    const itemsEl = $('dock-drawer-items');
    if (!dr || !itemsEl) return;
    dr.classList.add('open');
    if ($('dock-drawer-title')) $('dock-drawer-title').textContent = titleHint || targetPath;
    if ($('dock-drawer-path')) $('dock-drawer-path').textContent = '正在读取...';
    itemsEl.innerHTML = '<div class="dock-empty">正在读取目录...</div>';

    try {
      const res = await apiGet(`/api/fs/list?path=${encodeURIComponent(targetPath)}`);
      if (!res || !res.ok) {
        if ($('dock-drawer-path')) $('dock-drawer-path').textContent = (res && res.path) || targetPath;
        itemsEl.innerHTML = `<div class="dock-empty">${escapeHtml((res && res.error) || '目录读取失败')}</div>`;
        return;
      }
      drawerDir = res.path;
      drawerParent = res.parent || '';
      drawerItems = res.items || [];
      if ($('dock-drawer-path')) $('dock-drawer-path').textContent = drawerDir;
      if ($('btn-dock-up')) $('btn-dock-up').disabled = !drawerParent;
      renderDrawerItems();
    } catch (_) {
      if ($('dock-drawer-path')) $('dock-drawer-path').textContent = '127.0.0.1:17988 未连接';
      itemsEl.innerHTML = '<div class="dock-empty">未连接本地桌面服务，请重启 NientumBridge / 壁纸</div>';
    }
  }

  function renderDrawerItems() {
    const itemsEl = $('dock-drawer-items');
    if (!itemsEl) return;
    const kw = drawerFilter.trim().toLowerCase();
    const list = kw ? drawerItems.filter(it => it.name.toLowerCase().includes(kw)) : drawerItems;
    if (!list.length) {
      itemsEl.innerHTML = `<div class="dock-empty">${kw ? '没有匹配的项目' : '此文件夹为空'}</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    list.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'dock-item' + (item.isDir ? ' is-dir' : '');
      row.title = item.isDir ? `双击进入文件夹：${item.path}` : `双击打开：${item.path}`;
      row.innerHTML = `
        <span class="dock-item-icon">${itemIcon(item)}</span>
        <div class="dock-item-info">
          <div class="dock-item-name">${escapeHtml(item.name)}</div>
          <div class="dock-item-meta">${item.isDir ? '文件夹' : (formatSize(item.size) || item.ext || '文件')}</div>
        </div>
        <button type="button" class="dock-item-reveal" title="在资源管理器中定位">↗</button>
      `;
      row.onclick = (e) => {
        if (performance.now() < suppressDrawerClickUntil) return;
        const prev = itemsEl.querySelector('.dock-item.selected');
        if (prev && prev !== row) prev.classList.remove('selected');
        row.classList.add('selected');

        const now = performance.now();
        const dist = Math.hypot((e.clientX || 0) - (lastDrawerClick.x || 0), (e.clientY || 0) - (lastDrawerClick.y || 0));
        if (lastDrawerClick.idx === idx && (now - lastDrawerClick.time) < 280 && dist <= 18) {
          lastDrawerClick = { idx: -1, time: 0, x: 0, y: 0 };
          if (item.isDir) {
            loadDrawerDir(item.path, item.name);
          } else {
            apiPost('/api/fs/open', { path: item.path, reveal: false }).catch(() => {});
          }
          return;
        }
        lastDrawerClick = { idx, time: now, x: e.clientX || 0, y: e.clientY || 0 };
      };
      row.ondblclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      const revBtn = row.querySelector('.dock-item-reveal');
      if (revBtn) {
        revBtn.onclick = (e) => {
          e.stopPropagation();
          apiPost('/api/fs/open', { path: item.path, reveal: true }).catch(() => {});
        };
      }
      frag.appendChild(row);
    });
    itemsEl.innerHTML = '';
    itemsEl.appendChild(frag);
  }

  function openPopover(slot, mode) {
    clearCgDwell();
    if (drawerSlotId) closeDrawer(true);
    if (editingSlotId === slot.id && popoverMode === mode) {
      closePopover();
      return;
    }
    editingSlotId = slot.id;
    popoverMode = mode;
    syncDockOpenClass();
    layoutDockCards(false);
    renderPopover();
  }

  function closePopover() {
    editingSlotId = null;
    popoverMode = '';
    const pop = $('dock-popover');
    if (pop) pop.classList.remove('open');
    syncDockOpenClass();
    layoutDockCards(false);
  }

  function renderPopover() {
    const pop = $('dock-popover');
    const titleEl = $('dock-pop-title');
    const renameRow = $('dock-rename-row');
    const pickImgBtn = $('btn-dock-pick-img');
    const picker = $('dock-card-picker');
    const inp = $('dock-rename-input');
    const slot = getEditingSlot();

    if (!pop || !slot || !popoverMode) {
      if (pop) pop.classList.remove('open');
      if (pickImgBtn) pickImgBtn.classList.remove('open');
      return;
    }
    pop.classList.add('open');

    if (popoverMode === 'rename') {
      if (titleEl) titleEl.textContent = '重命名封票';
      if (renameRow) renameRow.classList.add('open');
      if (pickImgBtn) pickImgBtn.classList.remove('open');
      if (picker) picker.classList.remove('open');
      if (inp) {
        inp.value = slot.title || '';
        inp.focus();
        inp.select();
      }
    } else if (popoverMode === 'icon') {
      if (titleEl) titleEl.textContent = `更换「${slot.title}」封票样式`;
      if (renameRow) renameRow.classList.remove('open');
      if (pickImgBtn) pickImgBtn.classList.add('open');
      if (picker) {
        picker.classList.add('open');
        picker.innerHTML = '';
        CARD_THEMES.forEach((th) => {
          const opt = document.createElement('div');
          opt.className = 'dock-card-opt' + (slot.card === th.id ? ' active' : '');
          opt.title = th.label;
          opt.innerHTML = `<img src="${cardImgSrc(th.id, true)}" alt="" draggable="false" /><span>${escapeHtml(th.label)}</span>`;
          opt.onclick = async () => {
            slot.card = th.id;
            await saveSlots();
            renderTickets();
            renderPopover();
          };
          picker.appendChild(opt);
        });
      }
    }
  }

  function renderTickets() {
    const list = $('dock-tickets');
    if (!list) return;
    list.innerHTML = '';

    slots.forEach((slot, idx) => {
      const isSelected = idx === selectedIndex;
      const custom = isCustomCard(slot.card);
      const cardEl = document.createElement('div');
      cardEl.className = 'dock-ticket' + (isSelected ? ' selected' : '') + (custom ? ' is-custom' : '');
      cardEl.dataset.id = slot.id;
      cardEl.dataset.idx = String(idx);
      cardEl.dataset.card = slot.card || 'cover_act0';
      cardEl.style.zIndex = String(500 - Math.abs(idx - selectedIndex));
      cardEl.title = `单击居中选中 · 长按拖动调整顺序 · 双击打开文件夹：${slot.path}`;
      cardEl.innerHTML = `
        <img class="dock-ticket-bg" src="${cardImgSrc(slot.card, isSelected)}" alt="" draggable="false" />
        <div class="dock-ticket-cg-zone" title="悬停 0.5 秒展开文件夹内容预览 · 长按拖动调序 · 双击打开文件夹"></div>
        <div class="dock-ticket-peek-tag">${escapeHtml(slot.title)}</div>
        <div class="dock-ticket-info">
          <div>
            <div class="dock-ticket-title">${escapeHtml(slot.title)}</div>
            <div class="dock-ticket-path">${escapeHtml(slot.path)}</div>
          </div>
          <div class="dock-ticket-bottom">
            <span class="dock-ticket-hint">长按拖动 · 双击打开</span>
            <div class="dock-ticket-actions">
              <button type="button" class="dock-mini-btn rebind" title="选择定位文件夹">📁</button>
              <button type="button" class="dock-mini-btn icon" title="更换封票图案">🎨</button>
              <button type="button" class="dock-mini-btn rename" title="重命名">✎</button>
              <button type="button" class="dock-mini-btn del" title="移除此封票">✕</button>
            </div>
          </div>
        </div>
      `;

      const cgZone = cardEl.querySelector('.dock-ticket-cg-zone');
      if (cgZone) {
        cgZone.addEventListener('mouseenter', () => {
          if (!dockEnabled || dragState.active || dragState.mouseDown) return;
          clearCgDwell();
          cgDwellCard = cardEl;
          cardEl.classList.add('cg-dwelling');
          cgDwellTimer = setTimeout(() => {
            cgDwellTimer = 0;
            if (cgDwellCard) cgDwellCard.classList.remove('cg-dwelling');
            cgDwellCard = null;
            if (!dockEnabled || dragState.active || document.body.classList.contains('mode-theater')) return;
            openDrawerForSlot(slot);
          }, 500);
        });
        cgZone.addEventListener('mouseleave', () => {
          if (cgDwellCard === cardEl) clearCgDwell();
        });
      }

      cardEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !dockEnabled || document.body.classList.contains('mode-theater')) return;
        if (e.target && e.target.closest && e.target.closest('.dock-mini-btn')) return;
        if (slots.length < 2) return;
        const curIdx = slots.indexOf(slot);
        if (curIdx < 0) return;
        beginTicketLongPress(e, slot, cardEl, curIdx);
      });

      cardEl.querySelector('.rebind').onclick = (e) => {
        e.stopPropagation();
        const curIdx = slots.indexOf(slot);
        if (curIdx >= 0) selectedIndex = curIdx;
        centerSelectedCard(true);
        pickAndBindFolder(slot);
      };
      cardEl.querySelector('.icon').onclick = (e) => {
        e.stopPropagation();
        const curIdx = slots.indexOf(slot);
        if (curIdx >= 0) selectedIndex = curIdx;
        centerSelectedCard(true);
        openPopover(slot, 'icon');
      };
      cardEl.querySelector('.rename').onclick = (e) => {
        e.stopPropagation();
        const curIdx = slots.indexOf(slot);
        if (curIdx >= 0) selectedIndex = curIdx;
        centerSelectedCard(true);
        openPopover(slot, 'rename');
      };
      cardEl.querySelector('.del').onclick = async (e) => {
        e.stopPropagation();
        slots = slots.filter(s => s.id !== slot.id);
        if (editingSlotId === slot.id) closePopover();
        selectedIndex = Math.min(selectedIndex, Math.max(0, totalItemCount() - 1));
        await saveSlots();
        renderTickets();
        centerSelectedCard(true);
      };

      // 单击：平滑选中并居中到正中间；禁用原生 dblclick 绕过，仅由 250ms 手动连击且同位判定触发
      cardEl.onclick = (e) => {
        if (performance.now() < suppressTicketClickUntil) return;
        const curIdx = slots.indexOf(slot);
        if (curIdx < 0) return;
        const now = performance.now();
        const dist = Math.hypot((e.clientX || 0) - (lastCardClick.x || 0), (e.clientY || 0) - (lastCardClick.y || 0));
        if (lastCardClick.idx === curIdx && (now - lastCardClick.time) < 250 && dist <= 18) {
          lastCardClick = { idx: -1, time: 0, x: 0, y: 0 };
          openWindowsFolder(slot);
          return;
        }
        lastCardClick = { idx: curIdx, time: now, x: e.clientX || 0, y: e.clientY || 0 };
        if (selectedIndex !== curIdx) {
          selectedIndex = curIdx;
          centerSelectedCard(true);
        }
      };

      cardEl.ondblclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };

      list.appendChild(cardEl);
    });

    // 列表末尾：同款空白票根「＋ 添加封票」
    const addIdx = slots.length;
    const addSelected = addIdx === selectedIndex;
    const addEl = document.createElement('div');
    addEl.className = 'dock-ticket dock-ticket-add' + (addSelected ? ' selected' : '');
    addEl.dataset.idx = String(addIdx);
    addEl.dataset.card = 'blank';
    addEl.style.zIndex = String(500 - Math.abs(addIdx - selectedIndex));
    addEl.title = '单击添加新的本地文件夹封票';
    addEl.innerHTML = `
      <img class="dock-ticket-bg" src="${cardImgSrc('blank', addSelected)}" alt="" draggable="false" />
      <div class="dock-ticket-peek-tag">＋添加</div>
      <div class="dock-ticket-add-label">＋ 选择本地文件夹</div>
      <div class="dock-ticket-info">
        <div>
          <div class="dock-ticket-title">添加新封票</div>
          <div class="dock-ticket-path">点击选择任意本地文件夹</div>
        </div>
        <div class="dock-ticket-bottom">
          <span class="dock-ticket-hint">单击添加</span>
        </div>
      </div>
    `;
    addEl.onclick = () => {
      if (performance.now() < suppressTicketClickUntil) return;
      const curAddIdx = slots.length;
      if (selectedIndex !== curAddIdx) {
        selectedIndex = curAddIdx;
        centerSelectedCard(true);
      } else {
        handleAddFolder();
      }
    };
    list.appendChild(addEl);

    centerSelectedCard(false);
  }

  function syncTicketDomIndices() {
    const list = $('dock-tickets');
    if (!list) return;
    const cards = list.children;
    for (let i = 0; i < cards.length; i++) {
      cards[i].dataset.idx = String(i);
    }
  }

  function cancelPendingLongPress() {
    if (dragState.timer) {
      clearTimeout(dragState.timer);
      dragState.timer = 0;
    }
  }

  function stopDragAutoScroll() {
    if (dragState.autoScrollRaf) {
      cancelAnimationFrame(dragState.autoScrollRaf);
      dragState.autoScrollRaf = 0;
    }
  }

  function updateDraggedCardAndReorder(clientY) {
    if (!dragState.active || !dragState.cardEl) return;
    const vp = $('dock-scroll-viewport');
    const list = $('dock-tickets');
    if (!vp || !list) return;
    const listH = vp.clientHeight || 840;
    const centerY = listH * 0.5;
    const scale = window.innerWidth / 1920 || 1;
    const dyLocal = (clientY - dragState.startClientY) / scale;
    const dragCy = Math.max(46, Math.min(listH - 46, dragState.startCy + dyLocal));

    const w = 922;
    const exposePx = 508;
    const tx = w - exposePx;
    dragState.cardEl.style.transform = `translate3d(${tx.toFixed(1)}px, ${(dragCy - 74).toFixed(1)}px, 0) scale(1.015)`;
    dragState.cardEl.style.opacity = '1';
    dragState.cardEl._dkTf = dragState.cardEl._dkOp = '';  // 拖动直接改了样式，让下一次排版强制重写
    dragState.cardEl.style.zIndex = '900';

    const rawIdx = Math.round((dragCy + scrollPos - centerY) / ROW_STRIDE);
    const targetIdx = Math.max(0, Math.min(slots.length - 1, rawIdx));
    if (targetIdx !== dragState.curIdx) {
      const [moved] = slots.splice(dragState.curIdx, 1);
      slots.splice(targetIdx, 0, moved);
      if (dragState.cardEl.parentNode === list) {
        list.removeChild(dragState.cardEl);
        const refNode = list.children[targetIdx] || list.querySelector('.dock-ticket-add');
        list.insertBefore(dragState.cardEl, refNode);
      }
      dragState.curIdx = targetIdx;
      selectedIndex = targetIdx;
      syncTicketDomIndices();
      updateCardSelectionClasses();
      dragState.cardEl.style.zIndex = '900';
      layoutDockCards(false);
    }
  }

  function stepDragAutoScroll() {
    if (!dragState.active) {
      dragState.autoScrollRaf = 0;
      return;
    }
    const vp = $('dock-scroll-viewport');
    const listH = (vp && vp.clientHeight) || 840;
    const scale = window.innerWidth / 1920 || 1;
    const dyLocal = (dragState.lastClientY - dragState.startClientY) / scale;
    const dragCy = Math.max(46, Math.min(listH - 46, dragState.startCy + dyLocal));
    const maxSlotScroll = Math.max(0, (slots.length - 1) * ROW_STRIDE);
    let delta = 0;
    if (dragCy < 115 && scrollPos > 0) {
      delta = -Math.max(2, (115 - dragCy) * 0.12);
    } else if (dragCy > listH - 115 && scrollPos < maxSlotScroll) {
      delta = Math.max(2, (dragCy - (listH - 115)) * 0.12);
    }
    if (delta !== 0) {
      scrollPos = Math.max(0, Math.min(maxSlotScroll, scrollPos + delta));
      scrollTarget = scrollPos;
      layoutDockCards(false);
      updateDraggedCardAndReorder(dragState.lastClientY);
    }
    dragState.autoScrollRaf = requestAnimationFrame(stepDragAutoScroll);
  }

  function activateDragReorder() {
    dragState.timer = 0;
    if (!dragState.mouseDown || !dragState.cardEl) return;
    dragState.active = true;
    clearCgDwell();
    if (drawerSlotId) closeDrawer(true);
    if (editingSlotId) closePopover();
    if (hoverLeaveTimer) { clearTimeout(hoverLeaveTimer); hoverLeaveTimer = 0; }
    dockHovered = true;
    scrollTarget = scrollPos; scrollVel = 0;   // 开始拖动：停住滚动，弹出动画照常

    selectedIndex = dragState.curIdx;
    syncDockOpenClass();
    updateCardSelectionClasses();

    const dock = $('desktop-ticket-dock');
    if (dock) dock.classList.add('dock-reordering');
    dragState.cardEl.classList.add('dock-dragging');
    dragState.cardEl.style.zIndex = '900';

    layoutDockCards(false);
    updateDraggedCardAndReorder(dragState.lastClientY);
    stopDragAutoScroll();
    dragState.autoScrollRaf = requestAnimationFrame(stepDragAutoScroll);
  }

  function beginTicketLongPress(e, slot, cardEl, curIdx) {
    cancelPendingLongPress();
    const vp = $('dock-scroll-viewport');
    const listH = (vp && vp.clientHeight) || 840;
    const centerY = listH * 0.5;
    dragState.mouseDown = true;
    dragState.active = false;
    dragState.slotId = slot.id;
    dragState.origIdx = curIdx;
    dragState.curIdx = curIdx;
    dragState.cardEl = cardEl;
    dragState.startClientX = e.clientX;
    dragState.startClientY = e.clientY;
    dragState.lastClientY = e.clientY;
    dragState.startCy = centerY + curIdx * ROW_STRIDE - scrollPos;
    dragState.timer = setTimeout(activateDragReorder, LONG_PRESS_MS);
  }

  function finishDragReorder() {
    dragState.mouseDown = false;
    cancelPendingLongPress();
    stopDragAutoScroll();
    if (!dragState.active) {
      dragState.cardEl = null;
      return;
    }
    const moved = dragState.curIdx !== dragState.origIdx;
    const cardEl = dragState.cardEl;
    dragState.active = false;
    dragState.cardEl = null;
    suppressTicketClickUntil = performance.now() + 260;
    ignoreMouseOutUntil = performance.now() + 200;

    const dock = $('desktop-ticket-dock');
    if (dock) dock.classList.remove('dock-reordering');
    if (cardEl) cardEl.classList.remove('dock-dragging');

    syncTicketDomIndices();
    selectedIndex = Math.max(0, Math.min(slots.length - 1, dragState.curIdx));
    centerSelectedCard(true);
    if (moved) {
      saveSlots();
      showToast('已调整封票位置');
    }
  }

  function bindEvents() {
    updateDockScale();
    window.addEventListener('resize', updateDockScale);

    const vp = $('dock-scroll-viewport');
    if (vp) {
      const setDockHovered = (on) => {
        if (on) {
          if (hoverLeaveTimer) { clearTimeout(hoverLeaveTimer); hoverLeaveTimer = 0; }
          if (!dockHovered) {
            dockHovered = true;
            syncDockOpenClass();
            layoutDockCards(false);
          }
        } else {
          if (hoverLeaveTimer) return;
          hoverLeaveTimer = setTimeout(() => {
            hoverLeaveTimer = 0;
            clearCgDwell();
            dockHovered = false;
            if (drawerSlotId) closeDrawer(true);
            syncDockOpenClass();
            layoutDockCards(false);
          }, 180);
        }
      };

      // 基于几何滞回热区判定弹出与保持：
      // - 未展开时：鼠标靠近屏幕右侧边缘（约 115px 宽度、封票架垂直范围内）即唤起弹出，哪怕落在封票缝隙上也能触发；
      // - 已展开时：热区扩大至整个弹出区域及预览窗/配置窗，滚动或移入小文件夹窗口时绝不收回。
      // 真实鼠标是否仍在封票架热区。桥接器的焦点/滚轮信号是合成 mousemove，
      // 不能用事件里的 clientX/Y 判断，只能看最后一次真实鼠标位置。
      const isRealPointerNearShelf = () => {
        const scale = window.innerWidth / 1920;
        return lastMouseClientX >= window.innerWidth - 560 * scale &&
          lastMouseClientY >= window.innerHeight * 0.5 - 470 * scale &&
          lastMouseClientY <= window.innerHeight * 0.5 + 470 * scale;
      };

      window.addEventListener('mousemove', (e) => {
        const theater = document.body.classList.contains('mode-theater');
        const unfocused = document.body.classList.contains('unfocused');
        if (!dockEnabled || theater || unfocused) {
          // 桥接器在滚轮后可能紧跟一条焦点失焦信号，把 body 标记成 unfocused。
          // 真实鼠标仍在右侧封票架时不能因此收起，否则会“收起后立刻再弹出”。
          const keepForShelf = dockEnabled && !theater && unfocused && isRealPointerNearShelf();
          if (!keepForShelf && performance.now() >= ignoreMouseOutUntil) {
            if ((dockHovered || drawerSlotId) && !dragState.active && !drawerDragActive && !editingSlotId) setDockHovered(false);
          }
          return;
        }
        // 忽略桥接器发来的合成右键滚轮/焦点信号，以及滚轮归位信号
        if (e.buttons === 2) {
          if (performance.now() < ignoreMouseOutUntil) return;
          if (e.clientY > 3 && e.clientY <= 14 && e.clientX >= 25 && e.clientX <= 1000) {
            ignoreMouseOutUntil = Math.max(ignoreMouseOutUntil, performance.now() + 200);
          } else if (e.clientY <= 3 && e.clientX >= 250 && e.clientX <= 1000) {
            if ((dockHovered || drawerSlotId) && !dragState.active && !drawerDragActive && !editingSlotId && !isRealPointerNearShelf()) setDockHovered(false);
          }
          return;
        }

        if (dragState.timer && !dragState.active) {
          if (Math.hypot(e.clientX - dragState.startClientX, e.clientY - dragState.startClientY) > PRESS_MOVE_TOLERANCE) {
            cancelPendingLongPress();
          }
        }
        if (dragState.active) {
          dragState.lastClientY = e.clientY;
          if (hoverLeaveTimer) { clearTimeout(hoverLeaveTimer); hoverLeaveTimer = 0; }
          dockHovered = true;
          updateDraggedCardAndReorder(e.clientY);
          return;
        }
        if (drawerDragActive) {
          if (hoverLeaveTimer) { clearTimeout(hoverLeaveTimer); hoverLeaveTimer = 0; }
          dockHovered = true;
          return;
        }

        if (performance.now() < ignoreMouseOutUntil) return;
        lastMouseClientX = e.clientX;
        lastMouseClientY = e.clientY;

        const scale = window.innerWidth / 1920;
        const listH = vp.clientHeight || 840;
        const dockHalfH = (listH * 0.5) * scale;
        const dockCenterY = window.innerHeight * 0.5;
        const dockTop = dockCenterY - dockHalfH;
        const centerY = listH * 0.5;
        const localMinY = Math.max(0, centerY - scrollPos - 76);
        const localMaxY = Math.min(listH, centerY + Math.max(0, totalItemCount() - 1) * ROW_STRIDE - scrollPos + 76);
        const inTicketY = e.clientY >= dockTop + localMinY * scale && e.clientY <= dockTop + localMaxY * scale;
        const inDrawerY = e.clientY >= dockCenterY - 304 * scale && e.clientY <= dockCenterY + 304 * scale;

        const enterX = window.innerWidth - 115 * scale;
        const keepX = window.innerWidth - 500 * scale;
        const pop = $('dock-popover');
        const dr = $('dock-drawer');
        const onTicket = !!(e.target && e.target.closest && e.target.closest('.dock-ticket'));
        const inPopover = !!(pop && pop.classList.contains('open') && e.target && e.target.closest && e.target.closest('#dock-popover'));
        const inDrawer = !!(dr && dr.classList.contains('open') && (
          (e.target && e.target.closest && e.target.closest('#dock-drawer')) ||
          (e.clientX >= window.innerWidth - 925 * scale && e.clientX <= window.innerWidth - 490 * scale && inDrawerY)
        ));
        lastMouseInPopover = inPopover;
        lastMouseInDrawer = inDrawer;

        if (dockHovered || drawerSlotId) {
          const keep = inPopover || inDrawer || onTicket || (inTicketY && e.clientX >= keepX);
          setDockHovered(keep);
        } else {
          if (inTicketY && e.clientX >= enterX) {
            setDockHovered(true);
          }
        }
      });

      if (typeof MutationObserver !== 'undefined') {
        const bodyObs = new MutationObserver(() => {
          if (performance.now() < ignoreMouseOutUntil) return;
          if (document.body.classList.contains('unfocused') || document.body.classList.contains('mode-theater')) {
            if ((dockHovered || drawerSlotId) && !dragState.active && !drawerDragActive && !editingSlotId && !isRealPointerNearShelf()) {
              setDockHovered(false);
            }
          }
        });
        bodyObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      }

      window.addEventListener('mouseup', (e) => {
        if (e.button === 0 || dragState.mouseDown || dragState.active) {
          finishDragReorder();
        }
      });

      window.addEventListener('blur', () => {
        finishDragReorder();
      });

      document.addEventListener('mouseleave', () => {
        if (dragState.active || drawerDragActive) return;
        if (dockHovered && performance.now() >= ignoreMouseOutUntil) {
          setDockHovered(false);
        }
      });

      // 仅在封票已弹出时才响应滚轮滑动；连续滚轮即时响应，一次一格跟手切换
      const stepDockByWheel = (dir) => {
        if (!dockEnabled || !isDockExpanded()) return;
        const now = performance.now();
        if (hoverLeaveTimer) { clearTimeout(hoverLeaveTimer); hoverLeaveTimer = 0; }
        ignoreMouseOutUntil = now + 900;
        if (now < wheelStepCooldownUntil) return;
        wheelStepCooldownUntil = now + 28;
        const step = dir > 0 ? 1 : -1;
        const total = totalItemCount();
        if (!total) return;
        const nextIdx = Math.max(0, Math.min(total - 1, selectedIndex + step));
        if (nextIdx !== selectedIndex) {
          selectedIndex = nextIdx;
          centerSelectedCard(true);
        }
      };

      // 原生滚轮（浏览器直接打开时）
      window.addEventListener('wheel', (e) => {
        if (!dockEnabled || !isDockExpanded()) return;
        const target = e.target;
        const inDrawerEl = !!(target && target.closest && target.closest('#dock-drawer'));
        if (inDrawerEl) {
          if (hoverLeaveTimer) { clearTimeout(hoverLeaveTimer); hoverLeaveTimer = 0; }
          ignoreMouseOutUntil = performance.now() + 420;
          const itemsEl = $('dock-drawer-items');
          if (itemsEl && !target.closest('#dock-drawer-items')) {
            e.preventDefault();
            itemsEl.scrollTop = Math.max(0, Math.min(itemsEl.scrollHeight - itemsEl.clientHeight, itemsEl.scrollTop + e.deltaY));
          }
          return;
        }
        if (target && target.closest && target.closest('#dock-popover')) {
          if (hoverLeaveTimer) { clearTimeout(hoverLeaveTimer); hoverLeaveTimer = 0; }
          ignoreMouseOutUntil = performance.now() + 420;
          return;
        }
        if (!dockHovered && !(target && target.closest && target.closest('.dock-ticket'))) return;
        e.preventDefault();
        e.stopPropagation();
        if (Math.abs(e.deltaY) < 1) return;
        stepDockByWheel(e.deltaY > 0 ? 1 : -1);
      }, { passive: false, capture: true });

      // 桥接滚轮（Wallpaper Engine 桌面通过 NientumBridge.exe 转发）
      window.addEventListener('nientum-bridge-wheel', (e) => {
        if (!dockEnabled || !isDockExpanded()) return;
        const d = e.detail || {};
        const dy = Number(d.dy) || 0;
        if (!dy) return;
        const n = Math.max(1, Number(d.n) || 1);
        const now = performance.now();
        // 必须在处理前刷新保护窗口：桥接器每发一次滚轮都会紧跟一条 (800, 500) 的归位 mousemove
        if (hoverLeaveTimer) { clearTimeout(hoverLeaveTimer); hoverLeaveTimer = 0; }
        ignoreMouseOutUntil = now + 900;

        // 若小文件夹预览窗已打开且光标位于左侧预览区，滚轮优先滚动文件列表
        const dr = $('dock-drawer');
        const itemsEl = $('dock-drawer-items');
        const scale = window.innerWidth / 1920;
        if (dr && dr.classList.contains('open') && itemsEl && (lastMouseInDrawer || lastMouseClientX <= window.innerWidth - 495 * scale)) {
          itemsEl.scrollTop = Math.max(0, Math.min(itemsEl.scrollHeight - itemsEl.clientHeight, itemsEl.scrollTop + dy * 48 * n));
          return;
        }
        const pop = $('dock-popover');
        const pickerEl = $('dock-card-picker');
        if (pop && pop.classList.contains('open') && pickerEl && lastMouseInPopover) {
          pickerEl.scrollTop = Math.max(0, Math.min(pickerEl.scrollHeight - pickerEl.clientHeight, pickerEl.scrollTop + dy * 42 * n));
          return;
        }
        stepDockByWheel(dy);
      });
    }

    // 小文件夹预览窗支持按住左键上下拖动滚动（兼顾触控习惯与 WE 桌面）
    const drawerItemsEl = $('dock-drawer-items');
    if (drawerItemsEl) {
      let drStartY = 0, drStartScroll = 0, drMoved = 0, drPressed = false;
      drawerItemsEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('.dock-item-reveal')) return;
        drPressed = true;
        drawerDragActive = false;
        drStartY = e.clientY;
        drStartScroll = drawerItemsEl.scrollTop;
        drMoved = 0;
      });
      const endDrawerDrag = () => {
        if (!drPressed) return;
        drPressed = false;
        drawerItemsEl.classList.remove('dragging');
        if (drawerDragActive) {
          suppressDrawerClickUntil = performance.now() + 220;
          ignoreMouseOutUntil = performance.now() + 200;
        }
        drawerDragActive = false;
      };
      window.addEventListener('mousemove', (e) => {
        if (!drPressed) return;
        if ((e.buttons & 1) === 0) { endDrawerDrag(); return; }
        const dy = e.clientY - drStartY;
        drMoved = Math.max(drMoved, Math.abs(dy));
        if (drMoved > 6) {
          drawerDragActive = true;
          drawerItemsEl.classList.add('dragging');
          const scale = window.innerWidth / 1920 || 1;
          drawerItemsEl.scrollTop = Math.max(0, Math.min(drawerItemsEl.scrollHeight - drawerItemsEl.clientHeight, drStartScroll - dy / scale));
        }
      });
      window.addEventListener('mouseup', endDrawerDrag);
      window.addEventListener('blur', endDrawerDrag);
    }

    if ($('btn-dock-close')) $('btn-dock-close').onclick = () => closeDrawer(false);
    if ($('btn-dock-up')) {
      $('btn-dock-up').onclick = () => {
        if (drawerParent) loadDrawerDir(drawerParent, drawerParent.split(/[\\/]/).filter(Boolean).pop() || drawerParent);
      };
    }
    if ($('btn-dock-explorer')) {
      $('btn-dock-explorer').onclick = () => {
        if (drawerDir) apiPost('/api/fs/open', { path: drawerDir, reveal: false }).catch(() => {});
      };
    }
    if ($('dock-search')) {
      $('dock-search').oninput = (e) => {
        drawerFilter = e.target.value || '';
        renderDrawerItems();
      };
    }

    if ($('btn-dock-pick-img')) {
      $('btn-dock-pick-img').onclick = async () => {
        const slot = getEditingSlot();
        if (!slot) return;
        try {
          const res = await apiPost('/api/fs/pick-image', {});
          if (!res || !res.ok || !res.card) return;
          slot.card = res.card;
          await saveSlots();
          renderTickets();
          renderPopover();
          showToast('已更换为自定义图片');
        } catch (_) {
          showToast('未连接本地桌面服务，请重启 NientumBridge / 壁纸');
        }
      };
    }

    if (window.__nientumBridge && typeof window.__nientumBridge.getDockSettings === 'function') {
      applyDockSettings(window.__nientumBridge.getDockSettings());
    }
    window.addEventListener('nientum-dock-settings', (e) => {
      applyDockSettings(e.detail);
    });

    const pop = $('dock-popover');
    if (pop) {
      pop.addEventListener('mouseenter', () => {
        if (hoverLeaveTimer) { clearTimeout(hoverLeaveTimer); hoverLeaveTimer = 0; }
      });
    }

    if ($('btn-dock-pop-close')) $('btn-dock-pop-close').onclick = closePopover;

    const commitRename = async () => {
      const slot = getEditingSlot();
      const inp = $('dock-rename-input');
      if (!slot || !inp) return;
      const trimmed = (inp.value || '').trim();
      if (trimmed) {
        slot.title = trimmed.slice(0, 20);
        await saveSlots();
        renderTickets();
      }
      closePopover();
    };
    if ($('btn-dock-rename-ok')) $('btn-dock-rename-ok').onclick = commitRename;
    if ($('dock-rename-input')) {
      $('dock-rename-input').onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
        if (e.key === 'Escape') closePopover();
      };
    }

    document.addEventListener('pointerdown', (e) => {
      const dock = $('desktop-ticket-dock');
      if (!dock) return;
      if (!dock.contains(e.target)) {
        if (editingSlotId) closePopover();
        if (drawerSlotId) closeDrawer(false);
      }
    });
  }

  function init() {
    if (!$('desktop-ticket-dock')) return;
    bindEvents();
    loadSlots();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
