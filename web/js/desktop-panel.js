(() => {
  'use strict';

  const API_BASE = 'http://127.0.0.1:17988';
  const DRAWER_DIR_KEY = 'nientum_side_drawer_dir_v1';
  const DRAWER_WIDTH_KEY = 'nientum_side_drawer_width_v1';
  const DRAWER_ORDER_KEY = 'nientum_side_drawer_order_v1';
  const PINNED_SYS_ITEMS = [
    { name: '此电脑', path: '@thispc', isDir: true, pinned: true, ext: '' },
    { name: '回收站', path: '@recyclebin', isDir: true, pinned: true, ext: '' }
  ];

  const _elCache = Object.create(null);
  const $ = (id) => _elCache[id] || (_elCache[id] = document.getElementById(id));

  let drawerDir = '@desktop';
  let drawerItems = [];
  let drawerIconMap = null;
  let drawerOpen = false;
  let drawerLoaded = false;
  let lastClick = { idx: -1, time: 0, x: 0, y: 0 };
  let suppressGridClickUntil = 0;
  let hoverStatus = false;
  let hoverDrawer = false;
  let isResizingDrawer = false;
  let isDraggingItem = false;
  let pickingFolder = false;
  let openingContextMenu = false;
  let suppressOutsideCloseUntil = 0;
  let ignoreFakeMoveUntil = 0;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let drawerRetryTimer = 0;
  let drawerRetryCount = 0;

  function clearDrawerRetry() {
    if (drawerRetryTimer) {
      clearTimeout(drawerRetryTimer);
      drawerRetryTimer = 0;
    }
  }

  function scheduleDrawerRetry() {
    if (!drawerOpen || drawerLoaded) return;
    const grid = $('sd-grid');
    if (drawerRetryCount >= 6) {
      if (grid) grid.innerHTML = '<div class="sd-empty">未连接本地桌面服务，请稍后重新打开抽屉</div>';
      return;
    }
    drawerRetryCount++;
    const delay = Math.min(3000, 450 + drawerRetryCount * 450);
    if (grid) grid.innerHTML = '<div class="sd-empty">本地服务启动中，正在重试…</div>';
    clearDrawerRetry();
    drawerRetryTimer = setTimeout(() => {
      drawerRetryTimer = 0;
      if (drawerOpen && !drawerLoaded) loadDrawerItems();
    }, delay);
  }

  function clampDrawerWidth(w) {
    const maxW = Math.max(360, Math.floor((window.innerWidth || 1920) * 0.84));
    return Math.max(280, Math.min(maxW, Math.round(Number(w) || 560)));
  }

  function applyDrawerWidth(w) {
    const px = `${clampDrawerWidth(w)}px`;
    const drawerEl = $('side-drawer');
    const shellEl = $('sd-shell');
    if (drawerEl) drawerEl.style.setProperty('--sd-open-width', px);
    if (shellEl) shellEl.style.setProperty('--sd-open-width', px);
  }

  function loadOrderMap() {
    try {
      const raw = localStorage.getItem(DRAWER_ORDER_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveDrawerOrder() {
    try {
      const map = loadOrderMap();
      map[drawerDir] = drawerItems.filter(it => !it.pinned).map(it => it.name);
      localStorage.setItem(DRAWER_ORDER_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  function applySavedOrder(items) {
    const map = loadOrderMap();
    const order = map[drawerDir];
    if (!Array.isArray(order) || !order.length) return items;
    const rank = new Map(order.map((name, i) => [name, i]));
    return items.slice().sort((a, b) => {
      const ra = rank.has(a.name) ? rank.get(a.name) : 999999;
      const rb = rank.has(b.name) ? rank.get(b.name) : 999999;
      return ra - rb;
    });
  }

  function buildDrawerItems(folderItems) {
    const clean = (Array.isArray(folderItems) ? folderItems : []).filter(it => {
      if (!it || !it.path) return false;
      return it.path !== '@thispc' && it.path !== '@recyclebin';
    });
    return PINNED_SYS_ITEMS.map(it => Object.assign({}, it)).concat(applySavedOrder(clean));
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function itemEmoji(item) {
    if (item.path === '@thispc') return '💻';
    if (item.path === '@recyclebin') return '🗑';
    if (item.isDir) return '📁';
    const ext = (item.ext || '').toLowerCase();
    if (['.exe', '.msi', '.lnk', '.url', '.bat', '.cmd'].includes(ext)) return '⚡';
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'].includes(ext)) return '🖼';
    if (['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a'].includes(ext)) return '🎵';
    if (['.mp4', '.mkv', '.avi', '.mov', '.webm'].includes(ext)) return '🎬';
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) return '📦';
    return '📄';
  }

  function folderTitleOf(p) {
    if (!p || p === '@desktop') return '桌面快捷抽屉';
    if (p === '@downloads') return '下载';
    if (p === '@documents') return '文档';
    if (p === '@pictures') return '图片';
    const segs = String(p).split(/[\\/]/).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : p;
  }

  function syncHoverBridge() {
    const anyHover = hoverStatus || hoverDrawer || isResizingDrawer || isDraggingItem || openingContextMenu;
    if (window.__nientumBridge) {
      if (typeof window.__nientumBridge.setUiHover === 'function') {
        window.__nientumBridge.setUiHover('panel', anyHover);
      }
      if (typeof window.__nientumBridge.setPanelActive === 'function') {
        window.__nientumBridge.setPanelActive(hoverDrawer || isResizingDrawer || isDraggingItem || openingContextMenu);
      }
    }
  }

  function syncDrawerRectBridge() {
    const bridge = window.__nientumBridge;
    if (!bridge || typeof bridge.setDrawerRect !== 'function') return;
    if (!drawerOpen) {
      bridge.setDrawerRect(false, null);
      return;
    }
    const sh = $('sd-shell');
    const vw = window.innerWidth || 1920;
    const vh = window.innerHeight || 1080;
    if (!sh || vw <= 0 || vh <= 0) return;
    const r = sh.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return;
    bridge.setDrawerRect(true, [
      Math.max(0, Math.min(1, r.left / vw)),
      Math.max(0, Math.min(1, r.top / vh)),
      Math.max(0, Math.min(1, r.right / vw)),
      Math.max(0, Math.min(1, r.bottom / vh))
    ]);
  }

  function updateClock() {
    if (document.body.classList.contains('mode-theater')) return;
    const d = new Date();
    const hourEl = $('ss-hour');
    const minEl = $('ss-min');
    if (hourEl) hourEl.textContent = pad2(d.getHours());
    if (minEl) minEl.textContent = pad2(d.getMinutes());
  }

  function renderDrawerGrid(iconMap) {
    const grid = $('sd-grid');
    if (!grid) return;
    if (!drawerItems.length) {
      grid.innerHTML = '<div class="sd-empty">此文件夹为空</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    drawerItems.forEach((item, idx) => {
      const cell = document.createElement('div');
      cell.className = 'sd-item' + (item.pinned ? ' pinned' : '');
      cell.title = item.pinned ? `${item.name}（固定，不可移出）\n双击打开` : `${item.name}\n双击打开 / 长按拖动排序`;
      const iconUrl = iconMap && iconMap[item.path];
      const iconHtml = iconUrl
        ? `<img src="${API_BASE}${iconUrl}" alt="" draggable="false" />`
        : `<span class="sd-emoji">${itemEmoji(item)}</span>`;
      cell.innerHTML = `
        ${iconHtml}
        <div class="sd-name">${item.name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>
      `;
      cell.onclick = (e) => {
        if (performance.now() < suppressGridClickUntil) return;
        const prev = grid.querySelector('.sd-item.selected');
        if (prev && prev !== cell) prev.classList.remove('selected');
        cell.classList.add('selected');

        const now = performance.now();
        const dist = Math.hypot((e.clientX || 0) - lastClick.x, (e.clientY || 0) - lastClick.y);
        if (lastClick.idx === idx && (now - lastClick.time) < 280 && dist <= 18) {
          lastClick = { idx: -1, time: 0, x: 0, y: 0 };
          openPathWithRetry(item.path, false);
          return;
        }
        lastClick = { idx, time: now, x: e.clientX || 0, y: e.clientY || 0 };
      };
      cell.ondblclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      let lastCtxAt = 0;
      const openNativeContextMenu = async (e) => {
        if (dragActive || isDraggingItem || isResizingDrawer || openingContextMenu) return;
        const now = performance.now();
        if (now - lastCtxAt < 180) return;
        lastCtxAt = now;
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();

        const prev = grid.querySelector('.sd-item.selected');
        if (prev && prev !== cell) prev.classList.remove('selected');
        cell.classList.add('selected');

        openingContextMenu = true;
        suppressOutsideCloseUntil = performance.now() + 500;
        syncHoverBridge();
        const prevScroll = grid.scrollTop;
        try {
          const resp = await fetch(`${API_BASE}/api/fs/context-menu`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: item.path })
          });
          const data = await resp.json().catch(() => null);
          if (data && data.invoked && item.path !== '@thispc') {
            setTimeout(() => {
              const curGrid = $('sd-grid');
              const savedScroll = curGrid ? curGrid.scrollTop : prevScroll;
              drawerLoaded = false;
              loadDrawerItems().then(() => {
                const g = $('sd-grid');
                if (g) g.scrollTop = savedScroll;
              });
            }, 350);
          }
        } catch (_) {
        } finally {
          openingContextMenu = false;
          suppressOutsideCloseUntil = performance.now() + 260;
          syncHoverBridge();
        }
      };
      cell.addEventListener('mouseenter', () => {
        if (window.__nientumBridge && typeof window.__nientumBridge.setHoverDrawerItem === 'function') {
          window.__nientumBridge.setHoverDrawerItem(item.path);
        }
      });
      cell.addEventListener('mousedown', (e) => {
        if (e.button === 2 && window.__nientumBridge && typeof window.__nientumBridge.setHoverDrawerItem === 'function') {
          window.__nientumBridge.setHoverDrawerItem(item.path);
        }
      });
      cell.addEventListener('contextmenu', (e) => openNativeContextMenu(e));
      cell.addEventListener('mouseup', (e) => {
        if (e.button === 2) {
          setTimeout(() => openNativeContextMenu(e), 16);
        }
      });
      frag.appendChild(cell);
    });
    grid.innerHTML = '';
    grid.appendChild(frag);
  }

  async function loadDrawerItems() {
    const grid = $('sd-grid');
    const titleEl = $('sd-title');
    clearDrawerRetry();
    if (titleEl) titleEl.textContent = folderTitleOf(drawerDir);
    if (!grid) return;
    grid.innerHTML = '<div class="sd-empty">正在读取...</div>';
    try {
      const res = await fetch(`${API_BASE}/api/fs/list?path=${encodeURIComponent(drawerDir)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!data || !data.ok) {
        grid.innerHTML = `<div class="sd-empty">${(data && data.error) || '读取失败'}</div>`;
        scheduleDrawerRetry();
        return;
      }
      drawerItems = buildDrawerItems(data.items);
      if (data.path && titleEl) titleEl.textContent = folderTitleOf(data.path);
      drawerLoaded = true;
      drawerRetryCount = 0;
      clearDrawerRetry();
      drawerIconMap = null;
      renderDrawerGrid(null);

      if (drawerItems.length) {
        const iconRes = await fetch(`${API_BASE}/api/fs/icons`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: drawerItems.slice(0, 120) })
        });
        const iconData = await iconRes.json();
        if (iconData && iconData.ok && iconData.icons) {
          drawerIconMap = iconData.icons;
          renderDrawerGrid(drawerIconMap);
        }
      }
    } catch (_) {
      grid.innerHTML = '<div class="sd-empty">本地服务启动中，正在重试…</div>';
      scheduleDrawerRetry();
    }
  }

  async function openPathWithRetry(path, reveal, attempts = 2) {
    for (let i = 0; i <= attempts; i++) {
      try {
        const res = await fetch(`${API_BASE}/api/fs/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, reveal: !!reveal })
        });
        const data = await res.json().catch(() => null);
        if (res.ok && (!data || data.ok !== false)) return true;
      } catch (_) {}
      if (i < attempts) await new Promise((r) => setTimeout(r, 450 + i * 450));
    }
    return false;
  }

  function setDrawerOpen(open) {
    drawerOpen = !!open;
    const dr = $('side-drawer');
    if (dr) dr.classList.toggle('open', drawerOpen);
    if (!drawerOpen) clearDrawerRetry();
    if (drawerOpen && !drawerLoaded) {
      drawerRetryCount = 0;
      loadDrawerItems();
    }
    syncDrawerRectBridge();
    if (drawerOpen) {
      setTimeout(syncDrawerRectBridge, 60);
      setTimeout(syncDrawerRectBridge, 390);
    }
  }

  function bindEvents() {
    const statusEl = $('side-status');
    const drawerEl = $('side-drawer');
    if (statusEl) {
      statusEl.addEventListener('mouseenter', () => { hoverStatus = true; syncHoverBridge(); });
      statusEl.addEventListener('mouseleave', () => { hoverStatus = false; syncHoverBridge(); });
    }
    const shellEl = $('sd-shell') || drawerEl;
    if (shellEl) {
      shellEl.addEventListener('mouseenter', () => { hoverDrawer = true; syncHoverBridge(); });
      shellEl.addEventListener('mouseleave', () => {
        hoverDrawer = false;
        syncHoverBridge();
        if (window.__nientumBridge && typeof window.__nientumBridge.setHoverDrawerItem === 'function') {
          window.__nientumBridge.setHoverDrawerItem('');
        }
      });
      shellEl.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    let lastHookInvSeq = 0;
    window.addEventListener('nientum-context-menu-sync', (e) => {
      const d = (e && e.detail) || {};
      openingContextMenu = !!d.menuOpen;
      if (openingContextMenu) suppressOutsideCloseUntil = performance.now() + 800;
      syncHoverBridge();
      const seq = Number(d.invokedSeq) || 0;
      if (seq > lastHookInvSeq) {
        lastHookInvSeq = seq;
        const g = $('sd-grid');
        const savedScroll = g ? g.scrollTop : 0;
        drawerLoaded = false;
        loadDrawerItems().then(() => {
          const g2 = $('sd-grid');
          if (g2) g2.scrollTop = savedScroll;
        });
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (e.buttons === 2 && e.clientY <= 14) {
        ignoreFakeMoveUntil = performance.now() + 70;
        return;
      }
      if (performance.now() < ignoreFakeMoveUntil && e.buttons === 0 && e.clientX === 800 && e.clientY === 500) {
        return;
      }
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    });

    if ($('sd-tab')) {
      $('sd-tab').onclick = (e) => {
        e.stopPropagation();
        setDrawerOpen(true);
      };
    }
    if ($('btn-drawer-toggle')) {
      $('btn-drawer-toggle').onclick = (e) => {
        e.stopPropagation();
        setDrawerOpen(!drawerOpen);
      };
    }
    const titleEl = $('sd-title');
    if (titleEl) {
      titleEl.onclick = () => setDrawerOpen(!drawerOpen);
    }

    if ($('btn-drawer-pick')) {
      $('btn-drawer-pick').onclick = async (e) => {
        e.stopPropagation();
        pickingFolder = true;
        try {
          const res = await fetch(`${API_BASE}/api/fs/pick-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ desc: '选择桌面左侧快捷抽屉的目标文件夹' })
          });
          const data = await res.json();
          if (!data || !data.ok || !data.path) return;
          drawerDir = data.path;
          drawerLoaded = false;
          try { localStorage.setItem(DRAWER_DIR_KEY, drawerDir); } catch (_) {}
          setDrawerOpen(true);
          loadDrawerItems();
        } catch (_) {
        } finally {
          pickingFolder = false;
        }
      };
    }

    if ($('btn-drawer-open')) {
      $('btn-drawer-open').onclick = (e) => {
        e.stopPropagation();
        openPathWithRetry(drawerDir, false);
      };
    }

    if ($('btn-drawer-refresh')) {
      $('btn-drawer-refresh').onclick = (e) => {
        e.stopPropagation();
        drawerLoaded = false;
        drawerRetryCount = 0;
        clearDrawerRetry();
        loadDrawerItems();
      };
    }

    // 右边缘拖动拉缩抽屉宽度并保存（注意 WE 原生 mousemove 可能带 buttons=0，不能据此提前取消拖动）
    const resizer = $('sd-resizer');
    const shell = $('sd-shell');
    if (resizer && shell && drawerEl) {
      let startX = 0, startW = 560;
      const finishResize = () => {
        if (!isResizingDrawer) return;
        isResizingDrawer = false;
        suppressOutsideCloseUntil = performance.now() + 200;
        drawerEl.classList.remove('resizing');
        document.body.style.cursor = '';
        syncHoverBridge();
        const curW = Math.round(shell.getBoundingClientRect().width || startW);
        applyDrawerWidth(curW);
        try { localStorage.setItem(DRAWER_WIDTH_KEY, String(clampDrawerWidth(curW))); } catch (_) {}
        syncDrawerRectBridge();
      };
      resizer.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !drawerOpen) return;
        e.preventDefault();
        e.stopPropagation();
        isResizingDrawer = true;
        startX = e.clientX;
        startW = shell.getBoundingClientRect().width || 560;
        drawerEl.classList.add('resizing');
        document.body.style.cursor = 'ew-resize';
        syncHoverBridge();
      });
      window.addEventListener('mousemove', (e) => {
        if (!isResizingDrawer) return;
        if (e.buttons === 2 && e.clientY <= 14) {
          ignoreFakeMoveUntil = performance.now() + 70;
          return;
        }
        if (performance.now() < ignoreFakeMoveUntil && e.buttons === 0 && e.clientX === 800 && e.clientY === 500) {
          return;
        }
        applyDrawerWidth(startW + (e.clientX - startX));
      });
      window.addEventListener('mouseup', finishResize);
      window.addEventListener('blur', finishResize);
    }

    // 抽屉网格支持：长按 260ms 拖动排序图标（自动保存位置）、快速拖动上下滚动 + 桥接滚轮滑动
    const grid = $('sd-grid');
    if (grid) {
      let gPressed = false, gStartX = 0, gStartY = 0, gStartScroll = 0, gMoved = 0;
      let dragIdx = -1, dragOverIdx = -1, dragTimer = 0, dragActive = false;

      const clearDragState = () => {
        if (dragTimer) { clearTimeout(dragTimer); dragTimer = 0; }
        dragActive = false;
        isDraggingItem = false;
        dragIdx = -1;
        dragOverIdx = -1;
        syncHoverBridge();
        grid.querySelectorAll('.sd-item.dragging, .sd-item.drag-over').forEach(el => {
          el.classList.remove('dragging', 'drag-over');
        });
      };

      const finishGridDrag = () => {
        if (!gPressed) return;
        suppressOutsideCloseUntil = performance.now() + 180;
        if (dragActive && dragIdx >= 0 && dragOverIdx >= 0 && dragOverIdx !== dragIdx) {
          const movedItem = drawerItems[dragIdx];
          const targetItem = drawerItems[dragOverIdx];
          if (movedItem && !movedItem.pinned && targetItem && !targetItem.pinned) {
            const [moved] = drawerItems.splice(dragIdx, 1);
            drawerItems.splice(dragOverIdx, 0, moved);
            saveDrawerOrder();
            renderDrawerGrid(drawerIconMap);
          }
          suppressGridClickUntil = performance.now() + 260;
        } else if (gMoved > 6 || dragActive) {
          suppressGridClickUntil = performance.now() + 200;
        }
        gPressed = false;
        clearDragState();
      };

      grid.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        gPressed = true;
        gStartX = e.clientX;
        gStartY = e.clientY;
        gStartScroll = grid.scrollTop;
        gMoved = 0;
        const itemEl = e.target.closest('.sd-item');
        if (itemEl) {
          const all = Array.from(grid.querySelectorAll('.sd-item'));
          const idx = all.indexOf(itemEl);
          if (idx >= 0 && drawerItems[idx] && !drawerItems[idx].pinned) {
            dragIdx = idx;
            dragTimer = setTimeout(() => {
              if (!gPressed || gMoved > 8) return;
              dragActive = true;
              isDraggingItem = true;
              syncHoverBridge();
              itemEl.classList.add('dragging');
            }, 260);
          }
        }
      });
      window.addEventListener('mousemove', (e) => {
        if (!gPressed) return;
        if (e.buttons === 2 && e.clientY <= 14) {
          ignoreFakeMoveUntil = performance.now() + 70;
          return;
        }
        if (performance.now() < ignoreFakeMoveUntil && e.buttons === 0 && e.clientX === 800 && e.clientY === 500) {
          return;
        }
        const dist = Math.hypot(e.clientX - gStartX, e.clientY - gStartY);
        gMoved = Math.max(gMoved, dist);
        if (dragActive) {
          const targetEl = document.elementFromPoint(e.clientX, e.clientY);
          const overItem = targetEl && targetEl.closest ? targetEl.closest('.sd-item') : null;
          grid.querySelectorAll('.sd-item.drag-over').forEach(el => el.classList.remove('drag-over'));
          if (overItem && overItem.parentElement === grid) {
            const all = Array.from(grid.querySelectorAll('.sd-item'));
            const oIdx = all.indexOf(overItem);
            if (oIdx >= 0 && oIdx !== dragIdx && drawerItems[oIdx] && !drawerItems[oIdx].pinned) {
              dragOverIdx = oIdx;
              overItem.classList.add('drag-over');
            } else {
              dragOverIdx = -1;
            }
          } else {
            dragOverIdx = -1;
          }
          return;
        }
        if (gMoved > 6) {
          if (dragTimer) { clearTimeout(dragTimer); dragTimer = 0; }
          const dy = e.clientY - gStartY;
          grid.scrollTop = Math.max(0, Math.min(grid.scrollHeight - grid.clientHeight, gStartScroll - dy));
        }
      });
      window.addEventListener('mouseup', finishGridDrag);
      window.addEventListener('blur', finishGridDrag);

      window.addEventListener('nientum-bridge-wheel', (e) => {
        if (!drawerOpen || !hoverDrawer) return;
        const d = e.detail || {};
        const dy = Number(d.dy) || 0;
        const n = Math.max(1, Number(d.n) || 1);
        if (!dy) return;
        const rect = grid.getBoundingClientRect();
        if (lastMouseX >= rect.left && lastMouseX <= rect.right && lastMouseY >= rect.top && lastMouseY <= rect.bottom) {
          grid.scrollTop = Math.max(0, Math.min(grid.scrollHeight - grid.clientHeight, grid.scrollTop + dy * 48 * n));
        }
      });
    }

    // 点击抽屉外部区域时自动收起抽屉
    window.addEventListener('mousedown', (e) => {
      if (!drawerOpen || isResizingDrawer || isDraggingItem || pickingFolder || openingContextMenu) return;
      if (performance.now() < suppressOutsideCloseUntil) return;
      const sh = $('sd-shell');
      if (sh && sh.contains(e.target)) return;
      if (sh) {
        const rect = sh.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) return;
      }
      setDrawerOpen(false);
    }, true);

    window.addEventListener('resize', () => {
      if (drawerOpen) syncDrawerRectBridge();
    });

    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => {
        if (document.body.classList.contains('unfocused') || document.body.classList.contains('mode-theater')) {
          if (drawerOpen && !pickingFolder && !isResizingDrawer && !isDraggingItem && !hoverDrawer && !openingContextMenu) {
            setDrawerOpen(false);
          }
          if (!openingContextMenu && (hoverStatus || hoverDrawer)) {
            hoverStatus = false;
            hoverDrawer = false;
            syncHoverBridge();
          }
        }
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  function init() {
    if (!$('desktop-side-panel')) return;
    try {
      const saved = localStorage.getItem(DRAWER_DIR_KEY);
      if (saved) drawerDir = saved;
      const savedW = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
      if (Number.isFinite(savedW) && savedW >= 280) applyDrawerWidth(savedW);
    } catch (_) {}
    if ($('sd-title')) $('sd-title').textContent = folderTitleOf(drawerDir);
    updateClock();
    bindEvents();
    setInterval(updateClock, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
