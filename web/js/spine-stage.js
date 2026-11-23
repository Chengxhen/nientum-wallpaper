(function () {
  'use strict';

  let canvas = null;
  let gl = null;
  let renderer = null;
  let current = null; // { stageWidth, stageHeight, actors: [...] }
  let token = 0;
  let raf = 0;
  let paused = false;
  let fpsLimit = 60;
  let resScale = 1.0;
  let speedScale = 1.0;
  let lastError = '';
  let lastTick = 0;
  let lastDraw = 0;

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      if (/^https?:\/\//i.test(String(src || ''))) im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('贴图加载失败：' + src));
      im.src = src;
    });
  }

  function b64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function resizeBuffers() {
    if (!canvas) return;
    const cssW = Math.max(1, window.innerWidth || 1280);
    const cssH = Math.max(1, window.innerHeight || 720);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const scale = Math.max(0.4, Math.min(1.0, resScale || 1.0));
    const w = Math.max(320, Math.round(cssW * dpr * scale));
    const h = Math.max(180, Math.round(cssH * dpr * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (gl) gl.viewport(0, 0, w, h);
  }

  // 与 stage.js 背景的 cover 裁切严格同步，保证人物双脚精准落在 3840x2160 舞台聚光灯投影上
  function fitCamera() {
    if (!renderer || !current || !canvas) return;
    const cw = Math.max(1, canvas.width);
    const ch = Math.max(1, canvas.height);
    const canvasAspect = cw / ch;
    const cam = renderer.camera;

    if (current.isStageLayout) {
      const sw = current.stageWidth || 3840;
      const sh = current.stageHeight || 2160;
      const stageAspect = sw / sh;
      let vw, vh;
      if (canvasAspect > stageAspect) {
        vw = sw;
        vh = sw / canvasAspect;
      } else {
        vh = sh;
        vw = sh * canvasAspect;
      }
      cam.position.set(0, 0, 0);
      cam.viewportWidth = vw;
      cam.viewportHeight = vh;
      cam.update();
      return;
    }

    // 兼容单角色居中的旧模式
    const first = current.actors[0];
    if (!first) return;
    const off = new spine.Vector2();
    const size = new spine.Vector2();
    first.skeleton.updateWorldTransform();
    first.skeleton.getBounds(off, size, []);
    const bw = Math.max(1, size.x);
    const bh = Math.max(1, size.y);
    const margin = Math.max(0.6, Math.min(0.98, Number(current.margin) || 0.90));
    const worldH = Math.max(bh / margin, (bw / margin) / canvasAspect);
    const worldW = worldH * canvasAspect;
    cam.position.set(off.x + bw * 0.5, off.y + bh * 0.5, 0);
    cam.viewportWidth = worldW;
    cam.viewportHeight = worldH;
    cam.update();
  }

  let fgProg = null;
  let fgVbo = null;

  function ensureFgShader() {
    if (fgProg || !gl) return;
    const vsSrc = 'attribute vec2 a_pos; attribute vec2 a_uv; varying vec2 v_uv; void main(){ v_uv=a_uv; gl_Position=vec4(a_pos,0.0,1.0); }';
    const fsSrc = [
      'precision mediump float;',
      'uniform sampler2D u_tex;',
      'uniform float u_alpha;',
      'uniform int u_mode;',
      'varying vec2 v_uv;',
      'void main(){',
      '  vec4 c = texture2D(u_tex, v_uv);',
      '  if (u_mode == 3) {',
      '    gl_FragColor = vec4(c.rgb, 1.0);',
      '  } else if (u_mode == 2) {',
      '    vec3 m = mix(vec3(1.0), c.rgb, c.a * u_alpha);',
      '    gl_FragColor = vec4(m, 1.0);',
      '  } else if (u_mode == 1) {',
      '    gl_FragColor = vec4(c.rgb * (c.a * u_alpha), 0.0);',
      '  } else {',
      '    float a = c.a * u_alpha;',
      '    gl_FragColor = vec4(c.rgb * a, a);',
      '  }',
      '}'
    ].join('\n');
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    fgProg = {
      prog,
      aPos: gl.getAttribLocation(prog, 'a_pos'),
      aUv: gl.getAttribLocation(prog, 'a_uv'),
      uTex: gl.getUniformLocation(prog, 'u_tex'),
      uAlpha: gl.getUniformLocation(prog, 'u_alpha'),
      uMode: gl.getUniformLocation(prog, 'u_mode'),
    };
    fgVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, fgVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0,
    ]), gl.STATIC_DRAW);
  }

  function drawStageQuad(tex, mode, alpha, scale) {
    if (!tex || !renderer || !current) return;
    ensureFgShader();
    if (!fgProg || !fgVbo) return;
    const cam = renderer.camera;
    const sw = current.stageWidth || 3840;
    const sh = current.stageHeight || 2160;
    const vw = Math.max(1, cam.viewportWidth || sw);
    const vh = Math.max(1, cam.viewportHeight || sh);
    const sc = scale || 1;
    const nx = (sw * sc) / vw;
    const ny = (sh * sc) / vh;

    gl.useProgram(fgProg.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, fgVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -nx, -ny, 0, 1,
       nx, -ny, 1, 1,
      -nx,  ny, 0, 0,
       nx,  ny, 1, 0,
    ]), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(fgProg.aPos);
    gl.vertexAttribPointer(fgProg.aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(fgProg.aUv);
    gl.vertexAttribPointer(fgProg.aUv, 2, gl.FLOAT, false, 16, 8);

    if (mode === 3) {
      gl.disable(gl.BLEND);
    } else {
      gl.enable(gl.BLEND);
      if (mode === 1) {
        gl.blendFunc(gl.ONE, gl.ONE);
      } else if (mode === 2) {
        gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      } else {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.texture);
    gl.uniform1i(fgProg.uTex, 0);
    gl.uniform1f(fgProg.uAlpha, alpha !== undefined ? alpha : 1.0);
    gl.uniform1i(fgProg.uMode, mode);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  function drawFgLayers() {
    if (!current || !current.fgLayers || !current.fgLayers.length || !renderer) return;
    for (let i = 0; i < current.fgLayers.length; i++) {
      const fg = current.fgLayers[i];
      if (!fg.tex) continue;
      const mode = fg.blend === 'additive' ? 1 : (fg.blend === 'multiply' ? 2 : 0);
      drawStageQuad(fg.tex, mode, fg.color ? fg.color.a : 1.0, fg.scale || 1);
    }
  }

  function drawFrame() {
    if (!renderer || !current || !gl) return;
    if (current.bgTex) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawStageQuad(current.bgTex, 3, 1.0, 1);
    } else {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    renderer.begin();
    for (let i = 0; i < current.actors.length; i++) {
      const a = current.actors[i];
      renderer.drawSkeleton(a.skeleton, a.pma);
    }
    renderer.end();
    drawFgLayers();
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!current || paused || document.hidden) return;
    // 帧率由全局帧闸门统一控制（index.html 的 NientumRender）
    lastDraw = now;

    const dt = lastTick ? Math.min(0.05, Math.max(0.001, (now - lastTick) / 1000)) : 0.016;
    lastTick = now;
    const sdt = dt * speedScale;

    for (let i = 0; i < current.actors.length; i++) {
      const a = current.actors[i];
      if (a.intervalTracks && a.intervalTracks.length) {
        for (let j = 0; j < a.intervalTracks.length; j++) {
          const it = a.intervalTracks[j];
          const curEntry = a.state.tracks[it.track];
          if (!curEntry || curEntry.isComplete()) {
            it.wait += sdt;
            if (it.wait >= it.interval) {
              it.wait = 0;
              const ne = a.state.setAnimation(it.track, it.animation, false);
              if (ne) ne.timeScale = it.timeScale;
            }
          }
        }
      }
      a.state.update(sdt);
      a.state.apply(a.skeleton);
      a.skeleton.updateWorldTransform();
    }
    drawFrame();
  }

  function disposeCurrent() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (current && Array.isArray(current.actors)) {
      for (let i = 0; i < current.actors.length; i++) {
        const pages = current.actors[i].pages || [];
        for (let j = 0; j < pages.length; j++) {
          try { if (pages[j].texture && pages[j].texture.dispose) pages[j].texture.dispose(); } catch (_) {}
        }
      }
    }
    if (current && Array.isArray(current.fgLayers)) {
      for (let i = 0; i < current.fgLayers.length; i++) {
        try { if (current.fgLayers[i].tex && current.fgLayers[i].tex.dispose) current.fgLayers[i].tex.dispose(); } catch (_) {}
      }
    }
    if (current && current.bgTex) {
      try { if (current.bgTex.dispose) current.bgTex.dispose(); } catch (_) {}
    }
    current = null;
    lastTick = 0;
    lastDraw = 0;
    if (gl && canvas) {
      try {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } catch (_) {}
    }
    if (canvas) canvas.classList.remove('show');
  }

  function release() {
    token++;
    disposeCurrent();
  }

  function setPaused(v) {
    const next = !!v;
    if (next === paused) return;
    paused = next;
    if (!paused) lastTick = 0;
  }

  function setSettings(opts) {
    if (!opts) return;
    if (typeof opts.fpsLimit === 'number') fpsLimit = opts.fpsLimit;
    if (typeof opts.spineSpeed === 'number' && isFinite(opts.spineSpeed)) {
      speedScale = Math.max(0.2, Math.min(2.0, opts.spineSpeed));
    }
    if (typeof opts.resScale === 'number') {
      const clamped = Math.max(0.4, Math.min(1.0, opts.resScale));
      if (Math.abs(clamped - resScale) > 0.02) {
        resScale = clamped;
        if (current) {
          resizeBuffers();
          fitCamera();
          drawFrame();
        }
      }
    }
  }

  async function buildActor(spec) {
    const charKey = spec.char;
    const data = window.NIENTUM_SPINE_DATA && window.NIENTUM_SPINE_DATA[charKey];
    if (!data) throw new Error('缺少 Spine 数据：' + charKey);

    const atlas = new spine.TextureAtlas(String(data.atlas || '').split('\r').join(''));
    const dirPrefix = `assets/spines/${charKey}/`;
    // 支持单页或多页 atlas 贴图加载
    for (let i = 0; i < atlas.pages.length; i++) {
      const page = atlas.pages[i];
      let src = data.png;
      if (data.pages && data.pages[page.name]) {
        src = data.pages[page.name];
      } else if (i > 0 || (page.name && page.name !== `${charKey}.png` && !src)) {
        src = dirPrefix + page.name;
      }
      const img = await loadImage(src);
      page.setTexture(new spine.GLTexture(gl, img));
    }

    const loader = new spine.AtlasAttachmentLoader(atlas);
    const skeletonData = data.json
      ? new spine.SkeletonJson(loader).readSkeletonData(typeof data.json === 'string' ? data.json : JSON.stringify(data.json))
      : new spine.SkeletonBinary(loader).readSkeletonData(b64ToBytes(data.skelB64));
    const skeleton = new spine.Skeleton(skeletonData);
    const sc = Number(spec.scale) || 1;
    skeleton.scaleX = sc;
    skeleton.scaleY = sc;
    skeleton.x = Number(spec.x) || 0;
    skeleton.y = Number(spec.y) || 0;

    const animState = new spine.AnimationState(new spine.AnimationStateData(skeletonData));
    if (Number(spec.timeScale) > 0) animState.timeScale = Number(spec.timeScale);
    let primaryAnim = '';
    const intervalTracks = [];
    if (Array.isArray(spec.tracks) && spec.tracks.length) {
      for (let i = 0; i < spec.tracks.length; i++) {
        const tr = spec.tracks[i];
        if (!tr || !tr.animation) continue;
        const trackIdx = typeof tr.track === 'number' ? tr.track : i;
        const iv = Number(tr.interval) || 0;
        const ts = Number(tr.timeScale) > 0 ? Number(tr.timeScale) : 1;
        const entry = animState.setAnimation(trackIdx, tr.animation, iv > 0 ? false : (tr.loop !== false));
        if (entry) {
          entry.timeScale = ts;
          if (tr.timeOffset) entry.trackTime = Number(tr.timeOffset) || 0;
        }
        if (iv > 0) {
          intervalTracks.push({ track: trackIdx, animation: tr.animation, interval: iv, timeScale: ts, wait: 0 });
        }
        if (i === 0) primaryAnim = tr.animation;
      }
    } else {
      const animName = spec.animation || (skeletonData.animations.length ? skeletonData.animations[0].name : '');
      if (animName) {
        const entry = animState.setAnimation(0, animName, true);
        // 错开初始呼吸相位一丁点让同台更自然
        if (spec.timeOffset && entry) entry.trackTime = Number(spec.timeOffset) || 0;
      }
      primaryAnim = animName;
    }
    animState.apply(skeleton);
    skeleton.updateWorldTransform();

    return {
      char: charKey,
      atlas,
      pages: atlas.pages,
      pma: data.pma !== undefined ? !!data.pma : true,
      skeleton,
      skeletonData,
      state: animState,
      intervalTracks,
      animation: primaryAnim
    };
  }

  async function set(config, bgSrc) {
    if (!config) return;
    if (!window.spine) { lastError = 'Spine 运行库未加载'; return; }
    if (!window.NIENTUM_SPINE_DATA) { lastError = '缺少 Spine 数据'; return; }

    canvas = document.getElementById('wp-spine-layer');
    if (!canvas) { lastError = '缺少 Spine 画布'; return; }

    const actorsCfg = Array.isArray(config.actors) && config.actors.length
      ? config.actors
      : (config.char ? [{ char: config.char, x: 0, y: 0, scale: 1, animation: config.animation }] : []);
    if (!actorsCfg.length) return;

    const myToken = ++token;
    try {
      if (!gl) {
        if (typeof spine.GLTexture !== 'undefined') {
          spine.GLTexture.DISABLE_UNPACK_PREMULTIPLIED_ALPHA_WEBGL = true;
        }
        gl = canvas.getContext('webgl', {
          alpha: true,
          premultipliedAlpha: true,
          antialias: true,
          depth: false,
          stencil: false,
          preserveDrawingBuffer: true
        }) || canvas.getContext('experimental-webgl', {
          alpha: true,
          premultipliedAlpha: true,
          antialias: true,
          preserveDrawingBuffer: true
        });
        if (!gl) throw new Error('WebGL 不可用');
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        renderer = new spine.SceneRenderer(canvas, gl, true);
      }

      resizeBuffers();
      disposeCurrent();

      const built = [];
      for (let i = 0; i < actorsCfg.length; i++) {
        const actor = await buildActor(actorsCfg[i]);
        if (myToken !== token) {
          for (let j = 0; j < actor.pages.length; j++) {
            try { if (actor.pages[j].texture && actor.pages[j].texture.dispose) actor.pages[j].texture.dispose(); } catch (_) {}
          }
          return;
        }
        built.push(actor);
      }
      const fgCfg = Array.isArray(config.fgLayers) ? config.fgLayers : [];
      const needBg = !!(bgSrc && fgCfg.some(s => s && (s.blend === 'multiply' || s.blend === 'additive')));
      let bgTex = null;
      if (needBg) {
        const bgImg = await loadImage(bgSrc);
        if (myToken !== token) return;
        bgTex = new spine.GLTexture(gl, bgImg);
      }
      const builtFg = [];
      for (let i = 0; i < fgCfg.length; i++) {
        const spec = fgCfg[i];
        if (!spec || !spec.src) continue;
        const img = await loadImage(spec.src);
        if (myToken !== token) {
          if (bgTex && bgTex.dispose) try { bgTex.dispose(); } catch (_) {}
          for (let j = 0; j < builtFg.length; j++) {
            try { if (builtFg[j].tex && builtFg[j].tex.dispose) builtFg[j].tex.dispose(); } catch (_) {}
          }
          return;
        }
        const tex = new spine.GLTexture(gl, img);
        const a = spec.alpha !== undefined ? Number(spec.alpha) : 1;
        builtFg.push({
          tex,
          blend: spec.blend || 'normal',
          scale: Number(spec.scale) || 1,
          color: new spine.Color(1, 1, 1, a)
        });
      }
      if (myToken !== token) {
        if (bgTex && bgTex.dispose) try { bgTex.dispose(); } catch (_) {}
        for (let i = 0; i < builtFg.length; i++) {
          try { if (builtFg[i].tex && builtFg[i].tex.dispose) builtFg[i].tex.dispose(); } catch (_) {}
        }
        return;
      }

      current = {
        isStageLayout: !!(config.stageWidth || config.actors),
        stageWidth: Number(config.stageWidth) || 3840,
        stageHeight: Number(config.stageHeight) || 2160,
        margin: config.margin,
        actors: built,
        fgLayers: builtFg,
        bgTex
      };

      lastTick = 0;
      lastDraw = 0;
      lastError = '';
      fitCamera();
      drawFrame();
      canvas.classList.add('show');
      if (!raf) raf = requestAnimationFrame(tick);
    } catch (e) {
      lastError = (e && e.message) || String(e);
      try { disposeCurrent(); } catch (_) {}
      console.warn('[NientumSpine]', lastError);
    }
  }

  window.addEventListener('resize', () => {
    if (!current) return;
    resizeBuffers();
    fitCamera();
    drawFrame();
  });

  window.NientumSpine = {
    set,
    release,
    setPaused,
    setSettings,
    getCanvas: () => canvas,
    isActive: () => !!(current && canvas && canvas.classList.contains('show')),
    getLastError: () => lastError,
    debug: () => ({
      actors: current ? current.actors.map(a => ({
        char: a.char,
        x: a.skeleton.x,
        y: a.skeleton.y,
        scale: a.skeleton.scaleX,
        animation: a.animation,
        trackTime: a.state && a.state.tracks[0] ? a.state.tracks[0].trackTime : -1
      })) : [],
      renderer: !!renderer,
      contextLost: !!(gl && gl.isContextLost()),
      paused,
      canvas: canvas ? [canvas.width, canvas.height] : null,
      lastError
    })
  };
})();
