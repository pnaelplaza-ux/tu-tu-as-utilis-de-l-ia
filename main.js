/*
Infinite tiled canvas optimized:
- Uses a cached CanvasPattern instead of looping drawImage per tile.
- Renders only on state changes via a dirty flag + requestRender to avoid continuous draws.
- Keeps interaction semantics (pan, pinch, wheel zoom, momentum) but triggers draws only when needed.
*/

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false });

let DPR = Math.max(1, window.devicePixelRatio || 1);

// Transform state
let offsetX = 0; // in world pixels
let offsetY = 0;
let scale = 1;

// Cached pattern for fast tiling
let pattern = null;

// Render scheduling
let dirty = true;
let renderPending = false;
function requestRender() {
  if (renderPending) { dirty = true; return; }
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    if (dirty) { draw(); dirty = false; }
  });
}

function resize() {
  DPR = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(innerWidth * DPR);
  canvas.height = Math.floor(innerHeight * DPR);
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  ctx.setTransform(DPR,0,0,DPR,0,0);
  dirty = true;
  requestRender();
}
addEventListener('resize', resize);

// Load image
const img = new Image();
img.src = '/Screenshot_20260502_134804_TikTok.jpg';
img.onload = () => {
  // store original image natural size
  const baseW = img.naturalWidth || img.width;
  const baseH = img.naturalHeight || img.height;

  // patternScale tracks the internal upscale applied to the source when creating the pattern.
  // We recreate the pattern only when this value changes to avoid heavy work every frame.
  let patternScale = 1;

  function createPatternFor(scaleFactor) {
    // clamp to reasonable limits to avoid huge canvases
    const s = Math.max(1, Math.min(8, Math.round(scaleFactor)));
    if (s === patternScale && pattern) return;
    patternScale = s;

    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.floor(baseW * patternScale));
    off.height = Math.max(1, Math.floor(baseH * patternScale));
    const offCtx = off.getContext('2d');
    // draw the image scaled to the offscreen canvas to bake in the quality
    offCtx.imageSmoothingEnabled = true;
    offCtx.imageSmoothingQuality = 'high';
    offCtx.drawImage(img, 0, 0, off.width, off.height);
    pattern = ctx.createPattern(off, 'repeat');

    // store intrinsic pattern tile size in world (CSS) pixels for alignment
    pattern._tileW = baseW;
    pattern._tileH = baseH;
    pattern._scale = patternScale;
  }

  // create initial pattern at native resolution
  createPatternFor(1);

  // expose a function to update pattern quality based on desired multiplier
  img._createPatternFor = createPatternFor;

  // optionally start centered
  offsetX = - (baseW / 2);
  offsetY = - (baseH / 2);
  resize();
};

// Draw using pattern fill (single rect) — much faster than per-tile draws
function draw() {
  // fallback clear if pattern not ready
  if (!img.complete || !pattern) {
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle = '#111';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.restore();
    return;
  }

  // Adaptive quality: pick a pattern internal upscale to keep image crisp at current zoom
  // desiredMultiplier approximates how many source pixels per CSS pixel we want to bake into the pattern
  // consider device pixel ratio too so high-DPR displays get sharper tiles.
  const desiredMultiplier = Math.max(1, Math.min(8, Math.floor(scale * DPR)));
  if (img._createPatternFor) {
    img._createPatternFor(desiredMultiplier);
  }

  // clear background (device pixels)
  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle = '#111';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.restore();

  // Apply world transform: scale and translate (pan)
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(offsetX, offsetY);

  // Use pattern and fill a rectangle covering visible area in world coords
  // Align filling to reduce subpixel noise: compute visible region in world coords
  ctx.fillStyle = pattern;

  const viewW = canvas.width / DPR / scale;
  const viewH = canvas.height / DPR / scale;

  // fill region in world coordinates (we already applied translate)
  ctx.fillRect(-offsetX, -offsetY, viewW, viewH);

  ctx.restore();
}

// mark dirty and schedule render whenever state changes
function markDirty() { dirty = true; requestRender(); }

/* Interaction: pan with mouse/touch + improved touch behavior (multi-touch detection + momentum) */
let isPointerDown = false;
let lastX = 0, lastY = 0;

/* Track recent motion for velocity-based momentum */
let velocityX = 0, velocityY = 0;
let lastMoveTime = 0;
let lastMoveX = 0, lastMoveY = 0;
let momentumAnim = null;

/* Multitouch guard: when two fingers are active we suspend single-pointer pan */
let multitouchActive = false;

/* Timestamp of last touch activity — used to ignore wheel zooms that follow touch scroll */
let lastTouchTime = 0;

canvas.addEventListener('pointerdown', (e) => {
  // Ignore single-pointer pan while a multitouch pinch is active
  if (multitouchActive) return;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  isPointerDown = true;
  lastX = e.clientX;
  lastY = e.clientY;

  // initialize velocity tracking
  lastMoveTime = performance.now();
  lastMoveX = lastX;
  lastMoveY = lastY;
  velocityX = 0; velocityY = 0;

  // stop any ongoing momentum
  if (momentumAnim) {
    cancelAnimationFrame(momentumAnim);
    momentumAnim = null;
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!isPointerDown || multitouchActive) return;
  const now = performance.now();
  const dt = Math.max(1, now - lastMoveTime); // ms
  const dxScreen = (e.clientX - lastX);
  const dyScreen = (e.clientY - lastY);

  const dxWorld = dxScreen / scale;
  const dyWorld = dyScreen / scale;
  offsetX += dxWorld;
  offsetY += dyWorld;

  // update velocity in world-space (px/ms) with small exponential smoothing to avoid snaps
  const instVX = ((e.clientX - lastMoveX) / scale) / dt;
  const instVY = ((e.clientY - lastMoveY) / scale) / dt;
  const smoothK = 0.2; // smoothing factor (0..1)
  velocityX = velocityX * (1 - smoothK) + instVX * smoothK;
  velocityY = velocityY * (1 - smoothK) + instVY * smoothK;

  lastX = e.clientX;
  lastY = e.clientY;
  lastMoveX = e.clientX;
  lastMoveY = e.clientY;
  lastMoveTime = now;

  markDirty();
});

canvas.addEventListener('pointerup', (e) => {
  if (multitouchActive) return;
  isPointerDown = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch {}

  // start time-based momentum if velocity is noticeable
  const speed = Math.hypot(velocityX, velocityY);
  if (speed > 0.0005) {
    let lastT = performance.now();
    // decay constant per ms (higher = faster stop)
    const decayPerMs = 0.0035;
    const step = (now) => {
      const dt = Math.max(1, now - lastT);
      lastT = now;
      // exponential decay based on elapsed time
      const decayFactor = Math.exp(-decayPerMs * dt);
      velocityX *= decayFactor;
      velocityY *= decayFactor;
      offsetX += velocityX * dt;
      offsetY += velocityY * dt;
      markDirty();
      if (Math.hypot(velocityX, velocityY) > 0.00008) {
        momentumAnim = requestAnimationFrame(step);
      } else {
        momentumAnim = null;
      }
    };
    momentumAnim = requestAnimationFrame(step);
  }
});

canvas.addEventListener('pointercancel', () => { isPointerDown = false; });

// Wheel zoom (desktop) — ignore wheel events that occur right after touch activity
canvas.addEventListener('wheel', (e) => {
  // if a touch happened very recently, ignore this wheel (prevents touch scrolling from triggering zoom)
  if (Date.now() - lastTouchTime < 400) return;
  e.preventDefault();
  // zoom to cursor
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left);
  const cy = (e.clientY - rect.top);
  const delta = -e.deltaY;
  const zoomFactor = Math.exp(delta * 0.0008); // smooth
  zoomAt(zoomFactor, cx, cy);
}, { passive: false });

/* Touch pinch-to-zoom support (simple) + multitouch flag for pointer pan suspension */
let pinch = { active:false, id1:null, id2:null, startDist:0, startScale:1, mid:{x:0,y:0} };
canvas.addEventListener('touchstart', (e) => {
  // if two fingers start, enable pinch mode and disable single-pointer pan
  if (e.touches.length >= 2) {
    pinch.active = true;
    multitouchActive = true;
    pinch.id1 = e.touches[0].identifier;
    pinch.id2 = e.touches[1].identifier;
    pinch.startDist = dist(e.touches[0], e.touches[1]);
    pinch.startScale = scale;
    pinch.mid = midPoint(e.touches[0], e.touches[1]);
    // stop any momentum
    if (momentumAnim) { cancelAnimationFrame(momentumAnim); momentumAnim = null; }
  }
});
canvas.addEventListener('touchmove', (e) => {
  if (pinch.active && e.touches.length >= 2) {
    const a = e.touches[0], b = e.touches[1];
    const d = dist(a,b);
    const factor = d / pinch.startDist;
    // zoom around midpoint
    const rect = canvas.getBoundingClientRect();
    const mid = midPoint(a,b);
    zoomAtRaw(factor * pinch.startScale, mid.x - rect.left, mid.y - rect.top);
    e.preventDefault();
  }
}, { passive: false });
canvas.addEventListener('touchend', (e) => {
  // if fewer than two touches remain, end pinch mode and allow single-pointer pan again
  if (e.touches.length < 2) {
    pinch.active = false;
    multitouchActive = false;
  }
});

function dist(a,b){
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx,dy);
}
function midPoint(a,b){
  return { x: (a.clientX + b.clientX)/2, y: (a.clientY + b.clientY)/2 };
}

// Zoom helpers
function zoomAt(factor, screenX, screenY){
  // animate zoom smoothly to avoid sudden snaps
  const rect = canvas.getBoundingClientRect();
  const x = (screenX - rect.left);
  const y = (screenY - rect.top);
  const targetScale = scale * factor;
  const worldBeforeX = (x / scale) - offsetX;
  const worldBeforeY = (y / scale) - offsetY;

  // cancel any ongoing zoom animation
  if (canvas._zoomAnim) {
    cancelAnimationFrame(canvas._zoomAnim);
    canvas._zoomAnim = null;
  }

  const duration = 200; // ms
  const startScale = scale;
  const startOffsetX = offsetX;
  const startOffsetY = offsetY;
  const start = performance.now();

  const ease = (t) => 1 - Math.pow(1 - t, 3); // smooth ease-out

  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = ease(t);
    const s = startScale + (targetScale - startScale) * eased;

    // compute world before/after at interpolated scale and adjust offset so the screen point remains anchored
    const worldBeforeAtStart = (x / startScale) - startOffsetX;
    const worldAfterAtS = (x / s) - ((startOffsetX)); // we'll compute offset delta below

    // set temporary scale to compute proper offset delta
    const oldScale = scale;
    scale = s;
    const worldAfterX = (x / scale) - startOffsetX;
    const worldAfterY = (y / scale) - startOffsetY;
    // compute deltas relative to initial worldBeforeAtStart
    offsetX = startOffsetX + (worldBeforeAtStart - worldAfterX);
    offsetY = startOffsetY + (worldBeforeAtStart - worldAfterY); // reuse var, will be corrected below

    // The above arithmetic can cause slight drift; instead use anchor math:
    // Recompute correctly:
    scale = s;
    const worldBeforeXcur = (x / startScale) - startOffsetX;
    const worldAfterXcur = (x / scale) - startOffsetX;
    const worldBeforeYcur = (y / startScale) - startOffsetY;
    const worldAfterYcur = (y / scale) - startOffsetY;
    offsetX = startOffsetX + (worldAfterXcur - worldBeforeXcur);
    offsetY = startOffsetY + (worldAfterYcur - worldBeforeYcur);

    markDirty();

    if (t < 1) {
      canvas._zoomAnim = requestAnimationFrame(step);
    } else {
      canvas._zoomAnim = null;
    }
  };

  canvas._zoomAnim = requestAnimationFrame(step);
}

function zoomAtRaw(newScale, screenX, screenY){
  // set scale directly (used for pinch) — no clamp to allow infinite zoom
  const rect = canvas.getBoundingClientRect();
  const x = (screenX - rect.left);
  const y = (screenY - rect.top);
  const worldBeforeX = (x / scale) - offsetX;
  const worldBeforeY = (y / scale) - offsetY;
  const oldScale = scale;
  scale = newScale;
  const worldAfterX = (x / scale) - offsetX;
  const worldAfterY = (y / scale) - offsetY;
  offsetX += (worldAfterX - worldBeforeX);
  offsetY += (worldAfterY - worldBeforeY);
  draw();
}

// Double-tap/double-click recenters/zooms
let lastTap = 0;
canvas.addEventListener('dblclick', (e) => {
  // zoom in centered on cursor
  zoomAt(1.5, e.clientX, e.clientY);
});
canvas.addEventListener('touchend', (e) => {
  const t = Date.now();
  if (t - lastTap < 300) {
    // double-tap detected: zoom in center of last touch
    const touch = e.changedTouches[0];
    if (touch) zoomAt(1.6, touch.clientX, touch.clientY);
  }
  lastTap = t;
});

// initial draw loop
requestAnimationFrame(function loop(){
  // nothing animated except interactions; keep drawing when image still loading
  draw();
  requestAnimationFrame(loop);
});

// Start centered on load / window center (optional)
addEventListener('load', () => {
  if (img.complete) {
    offsetX = - (img.width / 2) + (canvas.width / DPR / 2) / scale;
    offsetY = - (img.height / 2) + (canvas.height / DPR / 2) / scale;
  }
  draw();
});
