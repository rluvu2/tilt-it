// Tilt-it — 뎁스 추정 Web Worker
// 모델 다운로드와 추론을 메인 스레드 밖에서 처리해 UI가 멈추지 않게 한다.
import { pipeline, env, RawImage } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

const MODEL_ID = 'Xenova/depth-anything-small-hf';

// 로컬 모델 경로는 쓰지 않고 Hugging Face Hub에서 받아 브라우저 Cache Storage에 캐싱한다.
env.allowLocalModels = false;
env.useBrowserCache = true;

let estimatorPromise = null;

// 파일별 다운로드 상황을 모아 전체 진행률(%)을 계산한다.
const downloads = new Map();
let lastProgressPost = 0;

function onProgress(event) {
  const { status, file } = event;
  if (!file) return;

  if (status === 'initiate' || status === 'download') {
    if (!downloads.has(file)) downloads.set(file, { loaded: 0, total: 0 });
  } else if (status === 'progress') {
    downloads.set(file, { loaded: event.loaded ?? 0, total: event.total ?? 0 });
  } else if (status === 'done') {
    const entry = downloads.get(file);
    if (entry) entry.loaded = entry.total;
  } else {
    return;
  }

  const now = performance.now();
  if (status === 'progress' && now - lastProgressPost < 100) return;
  lastProgressPost = now;

  let loaded = 0;
  let total = 0;
  for (const entry of downloads.values()) {
    loaded += entry.loaded;
    total += entry.total;
  }
  const percent = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
  self.postMessage({ type: 'progress', percent, loaded, total, file });
}

function getEstimator() {
  if (!estimatorPromise) {
    estimatorPromise = pipeline('depth-estimation', MODEL_ID, { progress_callback: onProgress })
      .then((estimator) => {
        self.postMessage({ type: 'ready' });
        return estimator;
      })
      .catch((error) => {
        estimatorPromise = null; // 다음 요청 때 다시 시도할 수 있게
        throw error;
      });
  }
  return estimatorPromise;
}

async function estimate(id, blob) {
  const estimator = await getEstimator();
  self.postMessage({ type: 'status', id, stage: 'depth' });

  const image = await RawImage.fromBlob(blob);
  const { depth } = await estimator(image);

  // depth: 입력 크기로 보간된 1채널 uint8 이미지 (값이 클수록 가까움).
  // 0..1 범위의 Float32Array로 정규화해서 넘긴다.
  const src = depth.data;
  const channels = depth.channels ?? 1;
  const count = depth.width * depth.height;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = src[i * channels];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = (src[i * channels] - min) / span;

  self.postMessage(
    { type: 'result', id, depth: out, width: depth.width, height: depth.height },
    [out.buffer],
  );
}

self.addEventListener('message', async ({ data }) => {
  try {
    if (data.type === 'load') {
      await getEstimator();
    } else if (data.type === 'estimate') {
      await estimate(data.id, data.blob);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: data.id ?? null,
      stage: data.type === 'load' ? 'model' : 'depth',
      message: error?.message ?? String(error),
    });
  }
});
