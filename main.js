// Tilt-it — UI 로직, Web Worker 통신, 거리 기반 블러 렌더링

const MAX_SIDE = 800;                                 // 모델 입력 최대 변 길이 (모바일 OOM 방지)
const BLUR_SIGMAS = [0, 1, 2, 3.5, 5.5, 8, 11.5];     // 미리 만들어 둘 가우시안 블러 단계 (px)
const DEPTH_SMOOTH_SIGMA = 1.5;                       // 뎁스맵 경계 계단 현상을 줄이는 약한 블러
const DEFAULTS = { range: 25, strength: 80, color: 130, blurNear: false };

const $ = (id) => document.getElementById(id);
const fileInput = $('file-input');
const dropzone = $('dropzone');
const canvas = $('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const statusText = $('status-text');
const canvasOverlay = $('canvas-overlay');
const modelBar = $('model-bar');
const resultCard = $('result-card');
const controls = $('controls');
const downloadBtn = $('download-btn');
const inputs = {
  focus: $('focus'),
  range: $('range'),
  strength: $('strength'),
  color: $('color'),
  blurNear: $('blur-near'),
};

const state = {
  modelReady: false,
  jobId: 0,
  busy: false,
  w: 0,
  h: 0,
  original: null,   // ImageData (리사이즈된 원본)
  levels: null,     // Uint8ClampedArray[] — 블러 단계별 RGBA
  depth: null,      // Float32Array 0..1, 1 = 가까움
  defaultFocus: 85,
  output: null,     // 결과 렌더링용 ImageData (재사용)
  view: 'result',
};

// ---------------------------------------------------------------- 상태 UI

function setStage(name, stageState, detail = '') {
  const el = document.querySelector(`.stage[data-stage="${name}"]`);
  el.dataset.state = stageState;
  el.querySelector('.detail').textContent = detail;
}

// 모바일에선 진행 패널이 사진 아래에 있으므로, 처리 중에는 사진 위에도 상태를 띄운다.
function setStatus(message) {
  statusText.textContent = message;
  canvasOverlay.textContent = message;
  canvasOverlay.classList.toggle('hidden', !state.busy);
}

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// 상태 텍스트가 실제로 화면에 그려질 틈을 준다. (백그라운드 탭에서도 멈추지 않게 setTimeout 사용)
const pause = () => new Promise((resolve) => setTimeout(resolve, 16));

// ---------------------------------------------------------------- Web Worker

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

worker.addEventListener('message', ({ data }) => {
  switch (data.type) {
    case 'progress': {
      const pct = Math.round(data.percent);
      modelBar.style.width = `${data.percent}%`;
      setStage('model', 'active', data.total ? `${pct}%` : '');
      if (data.total) setStatus(`AI 모델 다운로드 중… ${pct}% (${formatMB(data.loaded)} / ${formatMB(data.total)})`);
      break;
    }
    case 'ready':
      state.modelReady = true;
      modelBar.style.width = '100%';
      setStage('model', 'done', '완료');
      if (!state.busy) setStatus('준비 완료! 사진을 올려 보세요.');
      break;
    case 'status':
      if (data.id === state.jobId) {
        setStage('depth', 'active');
        setStatus('AI가 사진 속 거리감을 계산하고 있어요…');
      }
      break;
    case 'result':
      if (data.id === state.jobId) onDepth(data);
      break;
    case 'error':
      if (data.stage === 'model') {
        setStage('model', 'error', '실패');
        setStatus(`모델을 불러오지 못했어요: ${data.message} — 네트워크를 확인한 뒤 새로고침해 주세요.`);
      }
      if (data.id === null || data.id === state.jobId) {
        if (data.stage === 'depth') setStage('depth', 'error', '실패');
        state.busy = false;
        if (data.stage !== 'model') setStatus(`거리감 계산에 실패했어요: ${data.message}`);
      }
      break;
  }
});

worker.addEventListener('error', (event) => {
  setStage('model', 'error', '실패');
  setStatus(`백그라운드 작업을 시작하지 못했어요: ${event.message ?? '알 수 없는 오류'}`);
});

setStage('model', 'active');
worker.postMessage({ type: 'load' });

// ---------------------------------------------------------------- 업로드 + 전처리

fileInput.addEventListener('change', () => {
  handleFile(fileInput.files[0]);
  fileInput.value = ''; // 같은 파일을 다시 골라도 change가 발생하도록
});

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('dragging'));
}
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  handleFile(event.dataTransfer.files[0]);
});

async function decodeImage(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // 일부 브라우저는 옵션이나 형식을 지원하지 않는다 — <img>로 다시 시도
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 가로/세로 중 긴 쪽이 MAX_SIDE를 넘지 않도록 비율을 유지하며 축소한다.
async function resizeImage(file) {
  const source = await decodeImage(file);
  const srcW = source.naturalWidth || source.width;
  const srcH = source.naturalHeight || source.height;
  if (!srcW || !srcH) throw new Error('이미지 크기를 읽을 수 없어요');

  const scale = Math.min(1, MAX_SIDE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  wctx.fillStyle = '#fff'; // 투명 PNG는 흰 배경 위에 얹는다
  wctx.fillRect(0, 0, w, h);
  wctx.imageSmoothingEnabled = true;
  wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(source, 0, 0, w, h);
  source.close?.();

  return { canvas: work, w, h, srcW, srcH };
}

function canvasToBlob(target, type, quality) {
  return new Promise((resolve, reject) => {
    target.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('이미지 변환 실패'))), type, quality);
  });
}

async function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    setStatus('이미지 파일만 올릴 수 있어요.');
    return;
  }

  const id = ++state.jobId;
  state.busy = true;
  state.levels = null;
  state.depth = null;
  downloadBtn.disabled = true;
  for (const name of ['prep', 'depth', 'filter']) setStage(name, 'idle');
  setStage('prep', 'active');
  setStatus('사진 크기를 맞추는 중…');
  await pause();

  let resized;
  try {
    resized = await resizeImage(file);
  } catch (error) {
    if (id !== state.jobId) return;
    state.busy = false;
    setStage('prep', 'error', '실패');
    setStatus(`이 사진을 열 수 없어요 (${error.message}). JPG나 PNG로 다시 시도해 주세요.`);
    return;
  }
  if (id !== state.jobId) return;

  const { canvas: work, w, h, srcW, srcH } = resized;
  state.w = w;
  state.h = h;
  state.original = work.getContext('2d').getImageData(0, 0, w, h);
  state.output = new ImageData(w, h);

  // 계산되는 동안 원본을 먼저 보여 준다.
  canvas.width = w;
  canvas.height = h;
  ctx.putImageData(state.original, 0, 0);
  resultCard.classList.remove('hidden');
  setView('result');

  const blob = await canvasToBlob(work, 'image/jpeg', 0.92);
  if (id !== state.jobId) return;
  setStage('prep', 'done', srcW === w && srcH === h ? `${w}×${h}` : `${srcW}×${srcH} → ${w}×${h}`);

  if (state.modelReady) {
    setStage('depth', 'active');
    setStatus('AI가 사진 속 거리감을 계산하고 있어요…');
  } else {
    setStage('depth', 'active', '대기 중');
    setStatus('AI 모델 다운로드가 끝나면 바로 거리감을 계산할게요…');
  }
  worker.postMessage({ type: 'estimate', id, blob });
}

// ---------------------------------------------------------------- 뎁스 → 블러 레이어

async function onDepth({ id, depth, width, height }) {
  setStage('depth', 'done', '완료');
  setStage('filter', 'active');
  setStatus('미니어처 필터를 입히는 중…');
  await pause();

  const { w, h } = state;
  let map = width === w && height === h ? depth : resampleNearest(depth, width, height, w, h);
  map = gaussianBlurPlane(map, w, h, DEPTH_SMOOTH_SIGMA);

  const levels = [state.original.data];
  const planes = splitChannels(state.original.data, w * h);
  for (let k = 1; k < BLUR_SIGMAS.length; k++) {
    setStage('filter', 'active', `${k}/${BLUR_SIGMAS.length - 1}`);
    await pause();
    if (id !== state.jobId) return;
    levels.push(blurRGBA(planes, w, h, BLUR_SIGMAS[k]));
  }
  if (id !== state.jobId) return;

  state.depth = map;
  state.levels = levels;
  state.defaultFocus = Math.round(percentile(map, 0.85) * 100);
  resetControls();

  render();
  state.busy = false;
  controls.classList.remove('hidden');
  downloadBtn.disabled = false;
  setStage('filter', 'done', '완료');
  setStatus('완성! 사진을 탭해 초점을 옮기거나 오른쪽에서 효과를 조절해 보세요.');
}

function resampleNearest(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
      out[y * dw + x] = src[sy * sw + sx];
    }
  }
  return out;
}

function percentile(values, p) {
  const bins = new Uint32Array(256);
  for (let i = 0; i < values.length; i++) bins[Math.min(255, (values[i] * 255) | 0)]++;
  const target = values.length * p;
  let acc = 0;
  for (let b = 0; b < 256; b++) {
    acc += bins[b];
    if (acc >= target) return b / 255;
  }
  return 1;
}

// ---------------------------------------------------------------- 가우시안 블러 (박스 블러 3회 근사)

// 박스 블러를 세 번 겹치면 가우시안에 매우 가까워진다. ctx.filter가 없는 브라우저(구형 Safari)에서도 동일하게 동작.
function boxesForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

function boxBlurH(src, dst, w, h, r) {
  const inv = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = src[row] * (r + 1);
    for (let j = 0; j < r; j++) acc += src[row + Math.min(j, w - 1)];
    for (let x = 0; x < w; x++) {
      acc += src[row + Math.min(x + r, w - 1)] - src[row + Math.max(x - r - 1, 0)];
      dst[row + x] = acc * inv;
    }
  }
}

function boxBlurV(src, dst, w, h, r) {
  const inv = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    let acc = src[x] * (r + 1);
    for (let j = 0; j < r; j++) acc += src[Math.min(j, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      acc += src[Math.min(y + r, h - 1) * w + x] - src[Math.max(y - r - 1, 0) * w + x];
      dst[y * w + x] = acc * inv;
    }
  }
}

function gaussianBlurPlane(plane, w, h, sigma, out = new Float32Array(plane.length), tmp = new Float32Array(plane.length)) {
  out.set(plane);
  for (const size of boxesForGauss(sigma)) {
    const r = (size - 1) >> 1;
    if (r === 0) continue;
    boxBlurH(out, tmp, w, h, r);
    boxBlurV(tmp, out, w, h, r);
  }
  return out;
}

function splitChannels(rgba, n) {
  const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    planes[0][i] = rgba[p];
    planes[1][i] = rgba[p + 1];
    planes[2][i] = rgba[p + 2];
  }
  return planes;
}

function blurRGBA(planes, w, h, sigma) {
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  const result = new Float32Array(n);
  const tmp = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    gaussianBlurPlane(planes[c], w, h, sigma, result, tmp);
    for (let i = 0, p = c; i < n; i++, p += 4) out[p] = result[i];
  }
  for (let p = 3; p < out.length; p += 4) out[p] = 255;
  return out;
}

// ---------------------------------------------------------------- 렌더링

// 각 픽셀의 뎁스 값으로 블러 단계를 고르고, 인접한 두 단계를 선형 보간해 매끄럽게 섞는다.
function renderResult() {
  const { levels, depth, output } = state;
  const focus = inputs.focus.value / 100;
  const half = inputs.range.value / 200;
  const strength = inputs.strength.value / 100;
  const sat = inputs.color.value / 100;
  const contrast = 1 + (sat - 1) * 0.35;
  const blurNear = inputs.blurNear.checked;
  const maxLevel = levels.length - 1;

  // 뎁스 값(256단계) → 블러 단계 인덱스 조회표
  const lut = new Float32Array(256);
  const farSpan = Math.max(focus - half, 1e-3);
  const nearSpan = Math.max(1 - focus - half, 1e-3);
  for (let b = 0; b < 256; b++) {
    const d = b / 255;
    let t = 0;
    if (d < focus) t = (focus - d - half) / farSpan;          // 초점보다 먼 곳 → 흐리게
    else if (blurNear) t = (d - focus - half) / nearSpan;     // 초점보다 가까운 곳 (옵션)
    t = Math.min(1, Math.max(0, t));
    lut[b] = t * strength * maxLevel;
  }

  const out = output.data;
  const n = depth.length;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const li = lut[Math.min(255, (depth[i] * 255) | 0)];
    const i0 = li | 0;
    const f = li - i0;
    const a = levels[i0];
    const b = levels[Math.min(i0 + 1, maxLevel)];

    let r = a[p] + (b[p] - a[p]) * f;
    let g = a[p + 1] + (b[p + 1] - a[p + 1]) * f;
    let bl = a[p + 2] + (b[p + 2] - a[p + 2]) * f;

    // 미니어처 특유의 쨍한 색감: 채도 + 대비
    const lum = 0.299 * r + 0.587 * g + 0.114 * bl;
    r = (lum + (r - lum) * sat - 128) * contrast + 128;
    g = (lum + (g - lum) * sat - 128) * contrast + 128;
    bl = (lum + (bl - lum) * sat - 128) * contrast + 128;

    out[p] = r;
    out[p + 1] = g;
    out[p + 2] = bl;
    out[p + 3] = 255;
  }
  return output;
}

function renderDepth() {
  const out = state.output.data;
  const { depth } = state;
  for (let i = 0, p = 0; i < depth.length; i++, p += 4) {
    const v = depth[i] * 255;
    out[p] = out[p + 1] = out[p + 2] = v;
    out[p + 3] = 255;
  }
  return state.output;
}

function render() {
  if (!state.original) return;
  if (state.view === 'original' || !state.levels) {
    ctx.putImageData(state.original, 0, 0);
  } else if (state.view === 'depth') {
    ctx.putImageData(renderDepth(), 0, 0);
  } else {
    ctx.putImageData(renderResult(), 0, 0);
  }
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// ---------------------------------------------------------------- 조절 패널

function updateLabels() {
  $('focus-value').textContent = `${inputs.focus.value}`;
  $('range-value').textContent = `${inputs.range.value}`;
  $('strength-value').textContent = `${inputs.strength.value}%`;
  $('color-value').textContent = `${inputs.color.value}%`;
}

function resetControls() {
  inputs.focus.value = state.defaultFocus;
  inputs.range.value = DEFAULTS.range;
  inputs.strength.value = DEFAULTS.strength;
  inputs.color.value = DEFAULTS.color;
  inputs.blurNear.checked = DEFAULTS.blurNear;
  updateLabels();
}

for (const input of Object.values(inputs)) {
  input.addEventListener('input', () => {
    updateLabels();
    if (state.view !== 'result') setView('result');
    scheduleRender();
  });
}

$('reset-btn').addEventListener('click', () => {
  resetControls();
  scheduleRender();
});

function setView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll('.view-tab')) {
    tab.setAttribute('aria-pressed', String(tab.dataset.view === view));
  }
  scheduleRender();
}

for (const tab of document.querySelectorAll('.view-tab')) {
  tab.addEventListener('click', () => setView(tab.dataset.view));
}

// 사진을 탭하면 그 지점의 뎁스 값을 초점으로 삼는다.
canvas.addEventListener('click', (event) => {
  if (!state.depth) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.min(state.w - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * state.w)));
  const y = Math.min(state.h - 1, Math.max(0, Math.floor(((event.clientY - rect.top) / rect.height) * state.h)));
  inputs.focus.value = Math.round(state.depth[y * state.w + x] * 100);
  updateLabels();
  setView('result');
});

downloadBtn.addEventListener('click', async () => {
  if (!state.levels) return;
  const out = document.createElement('canvas');
  out.width = state.w;
  out.height = state.h;
  out.getContext('2d').putImageData(renderResult(), 0, 0);
  const blob = await canvasToBlob(out, 'image/jpeg', 0.92);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `tilt-it-${Date.now()}.jpg`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

updateLabels();
