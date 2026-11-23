(function () {
  'use strict';

  const THEMES = {
    flower_universe: { count: 32, type: 'petal', colors: ['#e8f2ff', '#a9d2ff', '#ffe8ba', '#d4b8ff'], speed: 0.62 },
    gold_clock:      { count: 30, type: 'spark', colors: ['#f7e3b5', '#e5c687', '#fff6dc'], speed: 0.50 },
    forest_firefly:  { count: 30, type: 'firefly', colors: ['#b8ffd4', '#e8ff99', '#7ef2c2'], speed: 0.48 },
    underworld_blue: { count: 32, type: 'ember', colors: ['#8ae3ff', '#5cc4ff', '#d6f7ff'], speed: 0.56 },
    midnight_magic:  { count: 36, type: 'star', colors: ['#d8e6ff', '#a8c4ff', '#ffffff'], speed: 0.52 },
    bamboo_moon:     { count: 30, type: 'petal', colors: ['#e6f0ff', '#fff0c2', '#b8d8ff'], speed: 0.54 },
    crimson_ember:   { count: 32, type: 'ember', colors: ['#ffb07a', '#ff7052', '#ffe0a3'], speed: 0.68 },
    silver_feather:  { count: 28, type: 'petal', colors: ['#f5f8ff', '#cbd8f0', '#ffecc7'], speed: 0.48 },
    wonder_spark:    { count: 36, type: 'star', colors: ['#ffe28a', '#ff9ec4', '#8ce8ff'], speed: 0.68 },
    winter_snow:     { count: 44, type: 'snow', colors: ['#ffffff', '#dceeff', '#eef6ff'], speed: 0.60 },
    frost_star:      { count: 36, type: 'snow', colors: ['#cfeaff', '#ffffff', '#9cd4ff'], speed: 0.56 },
    theater_gold:    { count: 28, type: 'spark', colors: ['#f6dfa4', '#d8b068', '#fff2d0'], speed: 0.46 },
    star_stage:      { count: 32, type: 'star', colors: ['#b8d4ff', '#f3e3b8', '#ffffff'], speed: 0.50 }
  };

  const VS_SRC = [
    'attribute vec2 aPos;',
    'uniform mat3 uMat;',
    'uniform vec4 uUV;',
    'varying vec2 vUV;',
    'void main(){',
    '  vec2 p = vec2(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0);',
    '  vec3 t = uMat * vec3(p, 1.0);',
    '  gl_Position = vec4(t.xy, 0.0, 1.0);',
    '  vUV = mix(uUV.xy, uUV.zw, aPos);',
    '}'
  ].join('\n');

  const FS_SRC = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'uniform float uAlpha;',
    'varying vec2 vUV;',
    'void main(){',
    '  vec4 c = texture2D(uTex, vUV);',
    '  gl_FragColor = vec4(c.rgb, c.a * uAlpha);',
    '}'
  ].join('\n');

  const state = {
    canvas: null,
    ctx2d: null,
    gl: null,
    program: null,
    buffer: null,
    posLoc: -1,
    matLoc: null,
    uvLoc: null,
    alphaLoc: null,
    texLoc: null,
    w: 0,
    h: 0,
    wallpaper: null,
    single: null,
    layers: [],
    videoEl: null,
    videoTex: null,
    videoReady: false,
    videoDirty: false,
    videoW: 0,
    videoH: 0,
    fade: 0,
    butterflyImgs: [],
    butterflies: [],
    fxCanvas: null,
    fx: null,
    particles: [],
    particleDensity: 0.8,
    resScale: 1.0,
    fpsLimit: 60,
    paused: false,
    audioEnergy: 0,
    lastFrameTime: 0,
    startTime: performance.now(),
    batchMat: new Float32Array(9)
  };

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function link(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function initGL() {
    const canvas = state.canvas;
    if (!canvas) return false;
    const opts = { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false };
    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) return false;
    try {
      const prog = link(gl, compile(gl, gl.VERTEX_SHADER, VS_SRC), compile(gl, gl.FRAGMENT_SHADER, FS_SRC));
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      state.program = prog;
      state.buffer = buf;
      state.posLoc = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(state.posLoc);
      gl.vertexAttribPointer(state.posLoc, 2, gl.FLOAT, false, 0, 0);
      state.matLoc = gl.getUniformLocation(prog, 'uMat');
      state.uvLoc = gl.getUniformLocation(prog, 'uUV');
      state.alphaLoc = gl.getUniformLocation(prog, 'uAlpha');
      state.texLoc = gl.getUniformLocation(prog, 'uTex');
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      // 顶点已经把 aPos.y 映射到 NDC，纹理不能再翻转，否则整幅画面上下颠倒
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.clearColor(0, 0, 0, 0);
      state.gl = gl;
      return true;
    } catch (e) {
      state.gl = null;
      return false;
    }
  }

  function upload(img) {
    const gl = state.gl;
    if (!gl) return null;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex: tex, img: img, iw: img.naturalWidth || img.width, ih: img.naturalHeight || img.height };
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      const im = new Image();
      if (/^https?:\/\//i.test(String(src || ''))) im.crossOrigin = 'anonymous';
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('load failed: ' + src)); };
      im.src = src;
    });
  }

  function spawnParticles(wp) {
    if (!state.fxCanvas || !wp) return;
    const cfg = THEMES[wp.theme] || THEMES.theater_gold;
    const count = Math.round(cfg.count * state.particleDensity);
    const w = state.fxCanvas.width || window.innerWidth;
    const h = state.fxCanvas.height || window.innerHeight;

    state.particles = [];
    for (let i = 0; i < count; i++) {
      state.particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 1.2 + Math.random() * 2.8,
        vx: (Math.random() - 0.5) * 0.38 * cfg.speed,
        vy: (cfg.type === 'ember' || cfg.type === 'firefly')
          ? -(0.2 + Math.random() * 0.48) * cfg.speed
          : (0.18 + Math.random() * 0.48) * cfg.speed,
        phase: Math.random() * Math.PI * 2,
        rot: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 0.02,
        alpha: 0.22 + Math.random() * 0.56,
        color: cfg.colors[i % cfg.colors.length],
        type: cfg.type
      });
    }

    state.butterflies = [];
    if (wp.butterflies && wp.butterflies.length && state.particleDensity > 0.05) {
      const bfCount = Math.max(4, Math.round(12 * state.particleDensity));
      for (let i = 0; i < bfCount; i++) {
        state.butterflies.push({
          imgIdx: i % wp.butterflies.length,
          x: Math.random() * w,
          y: h * (0.25 + Math.random() * 0.68),
          size: 26 + Math.random() * 26,
          vx: (0.25 + Math.random() * 0.45) * (Math.random() < 0.5 ? 1 : -1),
          vy: -(0.12 + Math.random() * 0.25),
          phase: Math.random() * Math.PI * 2,
          flapSpeed: 0.16 + Math.random() * 0.12,
          alpha: 0.55 + Math.random() * 0.38
        });
      }
    }
  }

  function resize() {
    if (!state.canvas) return;
    const scale = Math.max(0.4, Math.min(1.0, state.resScale || 1.0));
    const tw = Math.max(320, Math.round(window.innerWidth * scale));
    const th = Math.max(180, Math.round(window.innerHeight * scale));
    state.w = tw;
    state.h = th;
    if (state.canvas.width !== tw || state.canvas.height !== th) {
      state.canvas.width = tw;
      state.canvas.height = th;
    }
    if (state.gl) state.gl.viewport(0, 0, tw, th);
    if (state.fxCanvas) {
      const fw = Math.max(320, Math.round(window.innerWidth * scale));
      const fh = Math.max(180, Math.round(window.innerHeight * scale));
      if (state.fxCanvas.width !== fw || state.fxCanvas.height !== fh) {
        state.fxCanvas.width = fw;
        state.fxCanvas.height = fh;
        if (state.wallpaper) spawnParticles(state.wallpaper);
      }
    }
  }

  function computeCropUV(iw, ih, cw, ch, crop) {
    const srcW = Math.max(1, iw || 1);
    const srcH = Math.max(1, ih || 1);
    const dstW = Math.max(1, cw || 1);
    const dstH = Math.max(1, ch || 1);
    const texAspect = srcW / srcH;
    const canvasAspect = dstW / dstH;
    let baseU = 1, baseV = 1;
    if (texAspect > canvasAspect) {
      baseU = canvasAspect / texAspect;
    } else {
      baseV = texAspect / canvasAspect;
    }
    const zoom = (crop && Number.isFinite(Number(crop.zoom)))
      ? Math.max(1, Math.min(3.5, Number(crop.zoom)))
      : 1;
    const px = (crop && Number.isFinite(Number(crop.x)))
      ? Math.max(0, Math.min(1, Number(crop.x)))
      : 0.5;
    const py = (crop && Number.isFinite(Number(crop.y)))
      ? Math.max(0, Math.min(1, Number(crop.y)))
      : 0.5;
    const uSpan = baseU / zoom;
    const vSpan = baseV / zoom;
    const u0 = (1 - uSpan) * px;
    const v0 = (1 - vSpan) * py;
    return { u0, v0, u1: u0 + uSpan, v1: v0 + vSpan, uSpan, vSpan };
  }

  function applyVideoCropLayout(v, wp) {
    if (!v) return;
    const crop = wp && wp.crop;
    const hasCustom = !!(crop && (
      Math.abs((Number(crop.zoom) || 1) - 1) > 0.002 ||
      Math.abs((Number.isFinite(Number(crop.x)) ? Number(crop.x) : 0.5) - 0.5) > 0.001 ||
      Math.abs((Number.isFinite(Number(crop.y)) ? Number(crop.y) : 0.5) - 0.5) > 0.001
    ));
    if (!hasCustom) {
      v.style.width = '';
      v.style.height = '';
      v.style.objectFit = '';
      v.style.objectPosition = '';
      v.style.transform = '';
      return;
    }
    const px = Math.max(0, Math.min(1, Number.isFinite(Number(crop.x)) ? Number(crop.x) : 0.5));
    const py = Math.max(0, Math.min(1, Number.isFinite(Number(crop.y)) ? Number(crop.y) : 0.5));
    const zoom = Math.max(1, Math.min(3.5, Number(crop.zoom) || 1));
    const vw = v.videoWidth || 0;
    const vh = v.videoHeight || 0;
    if (vw > 0 && vh > 0) {
      const cw = window.innerWidth || state.w || 1920;
      const ch = window.innerHeight || state.h || 1080;
      const coverScale = Math.max(cw / vw, ch / vh);
      const dw = vw * coverScale * zoom;
      const dh = vh * coverScale * zoom;
      const tx = (cw - dw) * px;
      const ty = (ch - dh) * py;
      v.style.width = dw.toFixed(2) + 'px';
      v.style.height = dh.toFixed(2) + 'px';
      v.style.objectFit = 'fill';
      v.style.objectPosition = '';
      v.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0)`;
    } else {
      v.style.width = '';
      v.style.height = '';
      v.style.objectFit = 'cover';
      v.style.objectPosition = `${(px * 100).toFixed(2)}% ${(py * 100).toFixed(2)}%`;
      v.style.transform = zoom > 1.002 ? `scale(${zoom.toFixed(4)})` : '';
    }
  }

  function drawTexture(obj, m, alpha, crop) {
    const gl = state.gl;
    if (!gl || !obj || !obj.tex) return;
    const w = state.w;
    const h = state.h;
    const uv = computeCropUV(obj.iw, obj.ih, w, h, crop);
    gl.bindTexture(gl.TEXTURE_2D, obj.tex);
    gl.uniformMatrix3fv(state.matLoc, false, m);
    gl.uniform4f(state.uvLoc, uv.u0, uv.v0, uv.u1, uv.v1);
    gl.uniform1f(state.alphaLoc, Math.max(0, Math.min(1, alpha)));
    gl.uniform1i(state.texLoc, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function paintGL(t) {
    const gl = state.gl;
    if (!gl) return;
    const w = state.w;
    const h = state.h;
    if (state.fade < 1) state.fade = Math.min(1, state.fade + 0.035);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const m = state.batchMat;
    if (state.single) {
      m[0] = 1; m[1] = 0; m[2] = 0;
      m[3] = 0; m[4] = 1; m[5] = 0;
      m[6] = 0; m[7] = 0; m[8] = 1;
      drawTexture(state.single, m, state.fade, state.wallpaper && state.wallpaper.crop);
      return;
    }

    const k = w / 1920;
    const energy = state.audioEnergy;
    for (let i = 0; i < state.layers.length; i++) {
      const L = state.layers[i];
      if (!L || !L.tex) continue;
      let dx = 0, dy = 0, rot = 0, sc = 1, alpha = state.fade;
      if (L.kind === 'char') {
        dy = (Math.sin(t * 0.82) * 3.8 + Math.sin(t * 0.41) * 1.1) * k;
        dx = Math.cos(t * 0.44) * 1.3 * k;
        sc = 1.016;
      } else if (L.kind === 'glow') {
        alpha *= Math.min(1, 0.80 + 0.18 * Math.sin(t * 0.95) + energy * 0.12);
      } else if (L.kind === 'flower') {
        const amp = L.amp || 1;
        const ph = L.phase || 0;
        const wind = Math.sin(t * 0.72 + ph) + 0.42 * Math.sin(t * 1.24 + ph * 1.3);
        const sway = Math.cos(t * 0.62 + ph);
        dx = wind * 2.2 * amp * k;
        dy = sway * 1.1 * amp * k;
        rot = -wind * 0.18 * amp * Math.PI / 180;
        sc = 1.022;
      } else {
        sc = 1.016;
      }
      const tx = dx / (w * 0.5);
      const ty = -dy / (h * 0.5);
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      m[0] = c * sc; m[1] = s * sc; m[2] = 0;
      m[3] = -s * sc; m[4] = c * sc; m[5] = 0;
      m[6] = tx; m[7] = ty; m[8] = 1;
      drawTexture(L, m, alpha);
    }
  }

  function drawCover2D(ctx, obj, w, h, crop) {
    if (!obj || !obj.img) return;
    const iw = obj.iw || 1;
    const ih = obj.ih || 1;
    const uv = computeCropUV(iw, ih, w, h, crop);
    ctx.drawImage(obj.img, uv.u0 * iw, uv.v0 * ih, uv.uSpan * iw, uv.vSpan * ih, 0, 0, w, h);
  }

  // 没有 WebGL 时的回退路径（画布 2D，帧率较低但不会缺块）
  function paint2D(t) {
    const ctx = state.ctx2d;
    if (!ctx) return;
    const w = state.w;
    const h = state.h;
    if (state.fade < 1) state.fade = Math.min(1, state.fade + 0.035);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);

    if (state.single) {
      ctx.globalAlpha = state.fade;
      drawCover2D(ctx, state.single, w, h, state.wallpaper && state.wallpaper.crop);
      ctx.globalAlpha = 1;
      return;
    }

    const k = w / 1920;
    const energy = state.audioEnergy;
    for (let i = 0; i < state.layers.length; i++) {
      const L = state.layers[i];
      if (!L || !L.img) continue;
      ctx.save();
      ctx.translate(w * 0.5, h * 0.5);
      let alpha = state.fade;
      if (L.kind === 'char') {
        const dy = (Math.sin(t * 0.82) * 3.8 + Math.sin(t * 0.41) * 1.1) * k;
        const dx = Math.cos(t * 0.44) * 1.3 * k;
        ctx.translate(dx, dy);
        ctx.scale(1.016, 1.016);
      } else if (L.kind === 'glow') {
        alpha *= Math.min(1, 0.80 + 0.18 * Math.sin(t * 0.95) + energy * 0.12);
      } else if (L.kind === 'flower') {
        const amp = L.amp || 1;
        const ph = L.phase || 0;
        const wind = Math.sin(t * 0.72 + ph) + 0.42 * Math.sin(t * 1.24 + ph * 1.3);
        const sway = Math.cos(t * 0.62 + ph);
        ctx.translate(wind * 2.2 * amp * k, sway * 1.1 * amp * k);
        ctx.rotate(wind * 0.18 * amp * Math.PI / 180);
        ctx.scale(1.022, 1.022);
      } else {
        ctx.scale(1.016, 1.016);
      }
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.translate(-w * 0.5, -h * 0.5);
      drawCover2D(ctx, L, w, h);
      ctx.restore();
    }
  }

  function paint(t) {
    if (state.gl) paintGL(t);
    else paint2D(t);
  }

  function repaintIfPaused() {
    if (!state.paused || !state.gl || !state.canvas) return;
    paint((performance.now() - state.startTime) * 0.001);
    drawParticles(0.4);
    mirrorToCard();
  }

  function drawParticles(dt) {
    const ctx = state.fx;
    if (!ctx) return;
    const w = state.fxCanvas.width;
    const h = state.fxCanvas.height;
    ctx.clearRect(0, 0, w, h);
    if (state.particleDensity <= 0.01) return;

    const boost = 1 + state.audioEnergy * 0.45;
    for (let i = 0; i < state.particles.length; i++) {
      const p = state.particles[i];
      p.phase += 0.018 * dt;
      p.rot += p.vRot * dt;
      p.x += (p.vx + Math.sin(p.phase) * 0.25) * dt * boost;
      p.y += p.vy * dt * boost;

      if (p.y < -20) { p.y = h + 20; p.x = Math.random() * w; }
      if (p.y > h + 20) { p.y = -20; p.x = Math.random() * w; }
      if (p.x < -20) p.x = w + 20;
      if (p.x > w + 20) p.x = -20;

      const twinkle = (p.type === 'star' || p.type === 'firefly')
        ? (0.45 + 0.55 * Math.sin(p.phase * 1.8))
        : 1.0;
      ctx.globalAlpha = Math.max(0.05, Math.min(0.9, p.alpha * twinkle));
      ctx.fillStyle = p.color;

      if (p.type === 'petal') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, p.r * 1.6, p.r * 0.78, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (p.type === 'star') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot * 0.35);
        const s = p.r * 2.0;
        ctx.beginPath();
        ctx.moveTo(0, -s); ctx.lineTo(s * 0.24, -s * 0.24);
        ctx.lineTo(s, 0); ctx.lineTo(s * 0.24, s * 0.24);
        ctx.lineTo(0, s); ctx.lineTo(-s * 0.24, s * 0.24);
        ctx.lineTo(-s, 0); ctx.lineTo(-s * 0.24, -s * 0.24);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (let i = 0; i < state.butterflies.length; i++) {
      const bf = state.butterflies[i];
      const img = state.butterflyImgs[bf.imgIdx];
      if (!img || !img.complete || !img.naturalWidth) continue;
      bf.phase += bf.flapSpeed * dt;
      bf.x += (bf.vx + Math.sin(bf.phase * 0.35) * 0.35) * dt * boost;
      bf.y += (bf.vy + Math.cos(bf.phase * 0.45) * 0.28) * dt * boost;

      if (bf.y < -40) { bf.y = h + 30; bf.x = Math.random() * w; }
      if (bf.x < -50) bf.x = w + 40;
      if (bf.x > w + 50) bf.x = -40;

      const flap = 0.38 + 0.62 * Math.abs(Math.sin(bf.phase));
      ctx.save();
      ctx.globalAlpha = bf.alpha;
      ctx.translate(bf.x, bf.y);
      ctx.rotate(bf.vx > 0 ? 0.18 : -0.18);
      ctx.scale(flap, 1.0);
      ctx.drawImage(img, -bf.size * 0.5, -bf.size * 0.5, bf.size, bf.size);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
  }

  let cpCardEl = null;
  let cpMirrorEl = null;
  let cpMirrorCtx = null;
  let cpMirrorW = 0;
  let cpMirrorH = 0;

  function invalidateMirrorSize() {
    cpMirrorW = 0;
    cpMirrorH = 0;
  }

  function releaseWallpaperTextures(oldLayers, oldSingle) {
    if (!state.gl) return;
    if (Array.isArray(oldLayers)) {
      for (let i = 0; i < oldLayers.length; i++) {
        if (oldLayers[i] && oldLayers[i].tex) state.gl.deleteTexture(oldLayers[i].tex);
      }
    }
    if (oldSingle && oldSingle.tex) {
      state.gl.deleteTexture(oldSingle.tex);
    }
  }

  let cpVideoListeners = null;
  function releaseVideoTexture() {
    if (state.videoEl) {
      if (cpVideoListeners) {
        try {
          state.videoEl.removeEventListener('loadedmetadata', cpVideoListeners.onMeta);
          state.videoEl.removeEventListener('loadeddata', cpVideoListeners.markReady);
          state.videoEl.removeEventListener('canplay', cpVideoListeners.markReady);
          state.videoEl.removeEventListener('error', cpVideoListeners.tryFallback);
        } catch (_) {}
        cpVideoListeners = null;
      }
      try { state.videoEl.pause(); } catch (_) {}
      try { state.videoEl.removeAttribute('src'); state.videoEl.load(); } catch (_) {}
      try { state.videoEl.classList.remove('show', 'error'); } catch (_) {}
      try { state.videoEl.removeAttribute('poster'); } catch (_) {}
      applyVideoCropLayout(state.videoEl, null);
    }
    state.videoEl = null;
    state.videoReady = false;
    state.videoDirty = false;
    state.videoW = 0;
    state.videoH = 0;
    if (state.videoTex && state.gl) {
      try { state.gl.deleteTexture(state.videoTex); } catch (_) {}
    }
    state.videoTex = null;
  }

  function uploadVideoFrame() {
    const gl = state.gl, v = state.videoEl;
    if (!gl || !v || !v.videoWidth || !v.videoHeight) return;
    if (!state.videoTex) {
      state.videoTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, state.videoTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, state.videoTex);
    }
    try {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      state.videoW = v.videoWidth;
      state.videoH = v.videoHeight;
      state.videoDirty = false;
    } catch (_) {}
  }

  function mirrorToCard() {
    if (!document.body.classList.contains('desktop-card-mode')) return;
    if (document.body.classList.contains('mode-theater')) return;
    const wp = state.wallpaper;
    if (!wp || !((wp.layers && wp.layers.length) || wp.videoSrc || wp.spine)) return;
    if (!cpCardEl) cpCardEl = document.getElementById('cp-card');
    if (!cpMirrorEl) cpMirrorEl = document.getElementById('cp-dynamic-canvas');
    if (!cpCardEl || !cpMirrorEl || !cpCardEl.classList.contains('is-dynamic')) return;
    const srcGl = state.canvas;
    if (!srcGl || !srcGl.width || !srcGl.height) return;

    if (!cpMirrorW || !cpMirrorH) {
      // 使用布局尺寸（不受卡片悬停倾斜 / 漂移 transform 影响）
      const rect = cpCardEl.getBoundingClientRect();
      const cw = cpCardEl.offsetWidth || rect.width;
      const ch = cpCardEl.offsetHeight || rect.height;
      if (!cw || !ch) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * Math.max(0.4, Math.min(1, state.resScale || 1));
      cpMirrorW = Math.min(1600, Math.max(320, Math.round(cw * dpr)));
      cpMirrorH = Math.min(900, Math.max(180, Math.round(ch * dpr)));
    }
    const tw = cpMirrorW;
    const th = cpMirrorH;
    if (cpMirrorEl.width !== tw || cpMirrorEl.height !== th) {
      cpMirrorEl.width = tw;
      cpMirrorEl.height = th;
    }

    if (!cpMirrorCtx) cpMirrorCtx = cpMirrorEl.getContext('2d');
    const mctx = cpMirrorCtx;
    if (!mctx) return;

    const sw = srcGl.width;
    const sh = srcGl.height;
    const scale = Math.max(tw / sw, th / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (tw - dw) * 0.5;
    const dy = (th - dh) * 0.5;

    mctx.clearRect(0, 0, tw, th);
    const dv = state.videoEl;
    const overlay = (wp && wp.spine && window.NientumSpine && window.NientumSpine.isActive())
      ? window.NientumSpine.getCanvas() : null;
    if (overlay && overlay.width > 0 && overlay.height > 0) {
      mctx.drawImage(srcGl, dx, dy, dw, dh);
      mctx.drawImage(overlay, dx, dy, dw, dh);
      if (state.fxCanvas && state.fxCanvas.width > 0 && state.fxCanvas.height > 0) {
        mctx.drawImage(state.fxCanvas, dx, dy, dw, dh);
      }
      return;
    }
    if (wp && wp.videoSrc && state.videoReady && dv && dv.videoWidth > 0) {
      drawCover2D(mctx, { img: dv, iw: dv.videoWidth, ih: dv.videoHeight }, tw, th, wp.crop);
    } else {
      mctx.drawImage(srcGl, dx, dy, dw, dh);
    }
    if (state.fxCanvas && state.fxCanvas.width > 0 && state.fxCanvas.height > 0) {
      mctx.drawImage(state.fxCanvas, dx, dy, dw, dh);
    }
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (window.NientumSpine) window.NientumSpine.setPaused(state.paused);
    if (state.paused) return;
    // 帧率由全局帧闸门统一控制（index.html 的 NientumRender）
    const elapsed = now - state.lastFrameTime;
    const dt = Math.min(2.5, Math.max(0.4, elapsed / 16.67));
    state.lastFrameTime = now;

    paint((now - state.startTime) * 0.001);
    drawParticles(dt);
    mirrorToCard();
  }

  function setWallpaper(wp) {
    if (!wp) return;
    if (state.wallpaper && state.wallpaper.id === wp.id) return;
    releaseVideoTexture();
    if (window.NientumSpine) window.NientumSpine.release();
    state.wallpaper = wp;
    const token = wp.id;
    state.fade = 0;

    if (wp.butterflies && wp.butterflies.length) {
      state.butterflyImgs = wp.butterflies.map(function (src) {
        const im = new Image();
        im.src = src;
        return im;
      });
    } else {
      state.butterflyImgs = [];
    }

    if (wp.videoSrc) {
      const oldLayers = state.layers;
      const oldSingle = state.single;
      state.layers = [];
      state.single = null;
      releaseWallpaperTextures(oldLayers, oldSingle);
      spawnParticles(wp);

      const v = document.getElementById('wp-video-layer');
      if (!v) return;
      state.videoEl = v;
      state.videoReady = false;
      state.videoDirty = false;
      state.videoW = 0;
      state.videoH = 0;
      v.crossOrigin = 'anonymous';
      v.poster = wp.thumb || '';
      v.classList.add('show');
      v.classList.remove('error');
      let fallbackTried = false;
      let stallTimer = 0;
      const failStatic = function () {
        if (state.videoEl !== v || !state.wallpaper || state.wallpaper.id !== token) return;
        state.videoReady = false;
        v.classList.add('error');
        if (!v.poster && wp.thumb) v.poster = wp.thumb;
      };
      const tryFallback = function () {
        if (state.videoEl !== v || !state.wallpaper || state.wallpaper.id !== token) return;
        if (fallbackTried || !wp.videoFallback) { failStatic(); return; }
        fallbackTried = true;
        state.videoReady = false;
        try { v.src = wp.videoFallback; v.load(); } catch (_) {}
        if (!state.paused) v.play().catch(function () {});
        stallTimer = setTimeout(function () { if (!state.videoReady) failStatic(); }, 8000);
      };
      const onMeta = function () {
        if (state.videoEl !== v || !state.wallpaper || state.wallpaper.id !== token) return;
        applyVideoCropLayout(v, state.wallpaper);
      };
      const markReady = function () {
        if (state.videoEl !== v || !state.wallpaper || state.wallpaper.id !== token) return;
        state.videoReady = true;
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = 0; }
        v.classList.remove('error');
        applyVideoCropLayout(v, state.wallpaper);
        if (!state.paused) v.play().catch(function () {});
      };
      cpVideoListeners = { onMeta, markReady, tryFallback };
      v.addEventListener('loadedmetadata', onMeta);
      v.addEventListener('loadeddata', markReady);
      v.addEventListener('canplay', markReady);
      v.addEventListener('error', tryFallback);
      applyVideoCropLayout(v, wp);
      stallTimer = setTimeout(function () { if (!state.videoReady) tryFallback(); }, 6000);
      v.src = wp.videoSrc;
      v.play().catch(function () {});
      return;
    }

    if (wp.layers && wp.layers.length) {
      const jobs = wp.layers.map(function (layer) {
        return loadImage(layer.src).then(function (img) {
          const up = upload(img);
          return { tex: up ? up.tex : null, img: img, iw: up ? up.iw : 1, ih: up ? up.ih : 1, kind: layer.kind, amp: layer.amp, phase: layer.phase, z: layer.z };
        });
      });
      Promise.all(jobs).then(function (list) {
        if (!state.wallpaper || state.wallpaper.id !== token) {
          list.forEach(function (x) { if (x.tex && state.gl) state.gl.deleteTexture(x.tex); });
          return;
        }
        list.sort(function (a, b) { return (a.z || 0) - (b.z || 0); });
        const oldLayers = state.layers;
        const oldSingle = state.single;
        state.single = null;
        state.layers = list;
        releaseWallpaperTextures(oldLayers, oldSingle);
        spawnParticles(wp);
        repaintIfPaused();
      }).catch(function () {
        loadImage(wp.src).then(function (img) {
          if (state.wallpaper && state.wallpaper.id === token) {
            const oldLayers = state.layers;
            const oldSingle = state.single;
            state.single = upload(img);
            state.layers = [];
            releaseWallpaperTextures(oldLayers, oldSingle);
            spawnParticles(wp);
            repaintIfPaused();
          }
        }).catch(function () {});
      });
    } else {
      loadImage(wp.src).then(function (img) {
        if (state.wallpaper && state.wallpaper.id === token) {
          const oldLayers = state.layers;
          const oldSingle = state.single;
          state.layers = [];
          state.single = upload(img);
          releaseWallpaperTextures(oldLayers, oldSingle);
          spawnParticles(wp);
          repaintIfPaused();
        }
      }).catch(function () {});
    }
    if (wp.spine && window.NientumSpine) {
      window.NientumSpine.set(wp.spine, wp.src);
    }
  }

  window.NientumStage = {
    init() {
      state.canvas = document.getElementById('stage-gl');
      if (state.canvas) {
        if (!initGL()) state.ctx2d = state.canvas.getContext('2d');
      }
      state.fxCanvas = document.getElementById('fx-stage');
      state.fx = state.fxCanvas ? state.fxCanvas.getContext('2d') : null;
      resize();
      window.addEventListener('resize', () => {
        resize();
        invalidateMirrorSize();
        if (state.videoEl && state.wallpaper && state.wallpaper.videoSrc) {
          applyVideoCropLayout(state.videoEl, state.wallpaper);
        }
      });
      requestAnimationFrame(loop);
    },
    setWallpaper,
    setWallpaperCrop(id, crop) {
      if (!state.wallpaper || state.wallpaper.id !== id) return;
      state.wallpaper.crop = crop || null;
      if (state.videoEl && state.wallpaper.videoSrc) {
        applyVideoCropLayout(state.videoEl, state.wallpaper);
      }
      if (state.gl && state.canvas) {
        paint((performance.now() - state.startTime) * 0.001);
        mirrorToCard();
      }
    },
    debug() {
      return {
        wallpaperId: state.wallpaper && state.wallpaper.id,
        gl: !!state.gl,
        single: !!(state.single && state.single.tex),
        layers: state.layers ? state.layers.length : 0,
        canvas: state.canvas ? [state.canvas.width, state.canvas.height] : null,
        paused: !!state.paused,
        spine: !!(state.wallpaper && state.wallpaper.spine)
      };
    },
    redrawOnce() {
      if (!state.gl || !state.canvas) return;
      const t = (performance.now() - state.startTime) * 0.001;
      paint(t);
      drawParticles(0.4);
      mirrorToCard();
    },
    setSettings(opts) {
      if (typeof opts.resScale === 'number') {
        const clamped = Math.max(0.4, Math.min(1.0, opts.resScale));
        if (Math.abs(clamped - state.resScale) > 0.02) {
          state.resScale = clamped;
          resize();
          invalidateMirrorSize();
        }
      }
      if (typeof opts.particles === 'number') {
        const changed = Math.abs(opts.particles - state.particleDensity) > 0.04;
        state.particleDensity = opts.particles;
        if (changed && state.wallpaper) spawnParticles(state.wallpaper);
      }
      if (typeof opts.fpsLimit === 'number') state.fpsLimit = opts.fpsLimit;
      if (window.NientumSpine && typeof window.NientumSpine.setSettings === 'function') {
        window.NientumSpine.setSettings(opts);
      }
    },
    setPaused(p) {
      state.paused = !!p;
      if (state.videoEl) {
        if (state.paused) {
          try { state.videoEl.pause(); } catch (_) {}
        } else if (state.videoReady) {
          state.videoEl.play().catch(function () {});
        }
      }
    },
    setAudioEnergy(e) { state.audioEnergy = Math.max(0, Math.min(1, e || 0)); }
  };
})();