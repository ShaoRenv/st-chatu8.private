// st-chatu8-compress — 主线程 API，挂到 window.stChatu8Compress
// 契约：load() / supported() / compress(blobOrBytes,{level}) / terminate()
// 硬性：compress 绝不抛异常；编码全在 worker；输入格式 == 输出格式；不联网。
//
// v1.2.0 变更：
//   A 自适应 worker 池（按硬件并发 + 是否手机）+ 内存预算背压
//   B 结果解码校验下沉到 worker（主线程不再解码）
//   D 输入/输出零多余拷贝（支持直接传字节、结果带 bytes）
//   E 极速模式 fast:true（PNG 一律不跑 oxipng）

import { sniffFormat, isAnimated, SUPPORTED_FORMATS, MIME_BY_FORMAT, imageDimensions } from './sniff.js';
import { LEVELS, DEFAULT_LEVEL, normalizeLevel, CODEC_ID, PNG_TO_JPEG_LEVELS } from './codec.js';

const VERSION = '1.2.0';
const DEFAULT_BASE_RELATIVE = 'scripts/extensions/third-party/st-chatu8/compress';
const INIT_TIMEOUT_MS = 120000;
const COMPRESS_TIMEOUT_MS = 300000;

const MAX_POOL = 4;
const BYTES_PER_PIXEL_COST = 8;         // 解码后的 RGBA 缓冲 + getImageData 副本的粗估
const UNKNOWN_DIMS_COST_FACTOR = 6;     // 尺寸嗅探失败时按输入字节的倍数粗估
const BUDGET_MOBILE = 96 * 1024 * 1024;
const BUDGET_DESKTOP = 256 * 1024 * 1024;

// 脚本求值时锁存自身 URL（document.currentScript 只在同步求值期间有效）
const SELF_SCRIPT_SRC = (function () {
  try {
    if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) return document.currentScript.src;
  } catch (_) {}
  return '';
})();

const state = {
  slots: [],            // { worker, mode, blobUrl, ready, supported, errors, busy }
  queue: [],            // 已提交、等待准入的任务
  readyPromise: null,
  seq: 0,
  pending: new Map(),   // id → { resolve, reject, timer, slot }
  running: 0,
  inflightBytes: 0,
  supported: { png: false, jpeg: false, webp: false },
  errors: {},
  broken: null,
  degraded: 0,
  resolved: null,
  maxConcurrent: 0,     // 0 = 用池容量；>0 = 本次批量显式指定的并发上限
  epoch: 0,             // 每次 failAll 自增；用于丢弃"已被清零"的旧任务的计数回退
};

function toAbsoluteDir(raw) {
  const trimmed = String(raw || '').replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\/$/, '');
  let base;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(trimmed)) base = trimmed + '/';                        // http(s):// / chrome-extension://
  else if (trimmed.charAt(0) === '/') base = new URL(trimmed + '/', location.origin + '/').href; // /scripts/...
  else base = new URL(trimmed + '/', (typeof document !== 'undefined' && document.baseURI) || location.href).href;
  return base;
}

/** 资源目录解析顺序：options.base → window.stChatu8CompressBase → document.currentScript → 内置兜底相对路径 */
export function resolveBase(options) {
  const opt = options || {};
  let raw = opt.base;
  let source = 'options.base';
  if (!raw) {
    try {
      if (typeof window !== 'undefined' && typeof window.stChatu8CompressBase === 'string' && window.stChatu8CompressBase) {
        raw = window.stChatu8CompressBase;
        source = 'window.stChatu8CompressBase';
      }
    } catch (_) {}
  }
  if (!raw && SELF_SCRIPT_SRC) {
    raw = new URL('.', SELF_SCRIPT_SRC).href;
    source = 'document.currentScript';
  }
  if (!raw) {
    raw = DEFAULT_BASE_RELATIVE;
    source = 'builtin-fallback';
  }
  const base = toAbsoluteDir(raw);
  return {
    source,
    raw,
    base,
    workerUrl: new URL('worker.js', base).href,
    wasmBase: new URL('wasm/', base).href,
  };
}

// ————— 池大小 / 预算（v1.2.0 A） —————

function isMobileEnvironment() {
  try {
    if (typeof navigator === 'undefined') return false;
    const uaData = navigator.userAgentData;
    if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;
    const ua = String(navigator.userAgent || '');
    return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Windows Phone/i.test(ua);
  } catch (_) {
    return false;
  }
}

/** 自动池大小：桌面 = clamp(1, hc-1, 4)；手机再压到 2（大小核 + 发热 + 内存）。 */
export function computeBaseSlots() {
  let hc = 4;
  try {
    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) hc = navigator.hardwareConcurrency;
  } catch (_) {}
  let slots = Math.max(1, Math.min(hc - 1, MAX_POOL));
  if (isMobileEnvironment()) slots = Math.min(slots, 2);
  return Math.max(1, slots);
}

function budgetBytes() {
  return isMobileEnvironment() ? BUDGET_MOBILE : BUDGET_DESKTOP;
}

/** 单张图的内存代价估算：解码后像素 + 输入字节；尺寸未知时按输入字节放大估算。 */
function estimateCost(dims, inputBytes) {
  if (dims && dims.width > 0 && dims.height > 0) {
    return BYTES_PER_PIXEL_COST * dims.width * dims.height + inputBytes;
  }
  return Math.max(inputBytes, 1) * UNKNOWN_DIMS_COST_FACTOR;
}

// ————— worker 生命周期 —————

function createWorker(workerUrl) {
  try {
    return { worker: new Worker(workerUrl), mode: 'file' };
  } catch (e) {
    // 某些 CSP 下不允许直接 new Worker(同源文件)：退化为 blob 壳 + importScripts(绝对 URL)
    const src = 'importScripts(' + JSON.stringify(workerUrl) + ');';
    const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    return { worker: new Worker(blobUrl), mode: 'blob', blobUrl, cause: String((e && e.message) || e) };
  }
}

function rpc(slot, type, payload, transfer, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!slot || !slot.worker) { reject(new Error('worker not available')); return; }
    const id = ++state.seq;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(type + ' timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    state.pending.set(id, { resolve, reject, timer, slot });
    try {
      slot.worker.postMessage(Object.assign({ __c8c: 1, id, type }, payload || {}), transfer || []);
    } catch (e) {
      state.pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function attachSlot(slot) {
  slot.worker.onmessage = (event) => {
    const msg = event.data || {};
    const entry = state.pending.get(msg.id);
    if (!entry) return;
    state.pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  };
  slot.worker.onerror = (event) => {
    const message = (event && (event.message || (event.error && event.error.message))) || 'worker error';
    failSlot(slot, 'worker-error: ' + message);
  };
  slot.worker.onmessageerror = () => failSlot(slot, 'worker-error: message deserialization failed');
}

/** 单个 worker 阵亡：只影响它自己的在飞任务，其余 worker 继续干活。 */
function failSlot(slot, message) {
  const idx = state.slots.indexOf(slot);
  if (idx >= 0) state.slots.splice(idx, 1);
  state.degraded++;
  for (const [id, entry] of state.pending) {
    if (entry.slot === slot) {
      clearTimeout(entry.timer);
      state.pending.delete(id);
      entry.reject(new Error(message));
    }
  }
  try { if (slot.worker) slot.worker.terminate(); } catch (_) {}
  if (slot.blobUrl) { try { URL.revokeObjectURL(slot.blobUrl); } catch (_) {} }
  if (state.slots.length === 0) {
    state.broken = message;
    state.supported = { png: false, jpeg: false, webp: false };
    state.readyPromise = null;
  }
  pump();
}

// 建池串行化：并发首次调用（批量多路 + 生图自动压缩同时发生）不能各自建一池，
// 否则 N 个并发 compress 会创建 N×target 个 worker。
let ensureChain = Promise.resolve();

function ensureWorkers(n) {
  const target = Math.max(1, Math.min(Number(n) > 0 ? Math.floor(Number(n)) : 1, MAX_POOL));
  const run = () => ensureWorkersInner(target);
  const p = ensureChain.then(run, run);
  ensureChain = p.then(() => {}, () => {});
  return p;
}

/** 建到 target 个 worker 为止（幂等、可增量扩容），各自独立 init。返回可用 worker 数。 */
async function ensureWorkersInner(target) {
  const urls = state.resolved || resolveBase();
  state.resolved = urls;
  const creations = [];
  while (state.slots.length + creations.length < target) {
    let created;
    try {
      created = createWorker(urls.workerUrl);
    } catch (e) {
      state.degraded++;
      break;
    }
    const slot = {
      worker: created.worker,
      mode: created.mode,
      blobUrl: created.blobUrl,
      ready: false,
      supported: { png: false, jpeg: false, webp: false },
      errors: {},
      busy: 0,
    };
    attachSlot(slot);
    creations.push((async () => {
      try {
        const res = await rpc(slot, 'init', { wasmBase: urls.wasmBase }, null, INIT_TIMEOUT_MS);
        if (res.type !== 'ready') throw new Error('unexpected init reply: ' + String(res.type));
        slot.supported = Object.assign({ png: false, jpeg: false, webp: false }, res.supported || {});
        slot.errors = res.errors || {};
        slot.ready = true;
        state.slots.push(slot);
      } catch (e) {
        slot.errors = { init: String((e && e.message) || e) };
        state.degraded++;
        try { slot.worker.terminate(); } catch (_) {}
      }
    })());
  }
  if (creations.length) await Promise.all(creations);
  if (state.slots.length > 0) {
    state.supported = Object.assign({}, state.slots[0].supported);
    state.errors = Object.assign({}, state.slots[0].errors);
    state.broken = null;
  }
  pump();
  return state.slots.length;
}

// ————— 调度：并发上限 + 内存预算背压 —————

function anySlotSupports(format) {
  for (const s of state.slots) {
    if (s.ready && s.supported[format]) return true;
  }
  return false;
}

function pickSlot(format) {
  let best = null;
  for (const s of state.slots) {
    if (!s.ready) continue;
    if (format && !s.supported[format]) continue;
    if (!best || s.busy < best.busy) best = s;
  }
  if (best) return best;
  for (const s of state.slots) {
    if (s.ready && (!best || s.busy < best.busy)) best = s;
  }
  return best;
}

/** 准入循环：并发 < 可用 worker 数，且 (在飞字节 + 本次代价 <= 预算 或 当前空闲)。 */
function pump() {
  const budget = budgetBytes();
  while (state.queue.length > 0) {
    let readyCount = 0;
    for (const s of state.slots) if (s.ready) readyCount++;
    if (readyCount === 0) return;
    const cap = state.maxConcurrent > 0 ? Math.min(readyCount, state.maxConcurrent) : readyCount;
    if (state.running >= cap) return;
    const task = state.queue[0];
    if (!(state.running === 0 || state.inflightBytes + task.cost <= budget)) return;
    state.queue.shift();
    state.running++;
    state.inflightBytes += task.cost;
    task.epoch = state.epoch;
    task.start();
  }
}

function enqueue(cost, format, run) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const entry = {
      cost,
      format,
      epoch: 0,
      start() {
        const slot = pickSlot(format);
        if (!slot) {
          if (!settled) {
            settled = true;
            state.running--;
            state.inflightBytes -= cost;
            reject(new Error('worker not available'));
          }
          pump();
          return;
        }
        slot.busy++;
        const done = (ok, val) => {
          if (settled) return;
          settled = true;
          slot.busy--;
          // failAll 已把这批在飞任务的计数清零；旧 epoch 的任务不能再减一次，否则计数变负、
          // 之后新池会被超量放行（内存预算也会失效）。
          if (entry.epoch === state.epoch) {
            state.running--;
            state.inflightBytes -= cost;
          }
          pump();
          if (ok) resolve(val);
          else reject(val);
        };
        run(slot).then((v) => done(true, v), (e) => done(false, e));
      },
      rejectNow(err) {
        if (settled) return;
        settled = true;
        reject(err);
      },
    };
    state.queue.push(entry);
    pump();
  });
}

// ————— 对外 API —————

function load(options) {
  if (state.readyPromise) return state.readyPromise;
  state.readyPromise = (async () => {
    try {
      const urls = resolveBase(options);
      state.resolved = urls;
      const want = options && Number(options.concurrency) > 0 ? Number(options.concurrency) : computeBaseSlots();
      state.maxConcurrent = options && Number(options.concurrency) > 0 ? Math.min(Math.floor(Number(options.concurrency)), MAX_POOL) : 0;
      const size = await ensureWorkers(want);
      const sup = Object.assign({}, state.supported);
      const ok = size > 0 && (sup.png || sup.jpeg || sup.webp);
      if (!ok) {
        const errs = Object.assign({}, state.errors);
        return {
          ok: false,
          supported: { png: false, jpeg: false, webp: false },
          errors: errs,
          reason: errs.init || 'no usable worker',
          base: urls.base,
          baseSource: urls.source,
          workerUrl: urls.workerUrl,
          wasmBase: urls.wasmBase,
          version: VERSION,
        };
      }
      return {
        ok: true,
        supported: sup,
        errors: Object.assign({}, state.errors),
        pool: { size, degraded: state.degraded },
        workerUrl: urls.workerUrl,
        wasmBase: urls.wasmBase,
        base: urls.base,
        baseSource: urls.source,
        workerMode: state.slots.length ? state.slots[0].mode : 'file',
        version: VERSION,
      };
    } catch (e) {
      const message = String((e && e.message) || e);
      failAll(message);
      state.errors = { init: message };
      return { ok: false, supported: { png: false, jpeg: false, webp: false }, errors: { init: message }, reason: message };
    }
  })();
  return state.readyPromise;
}

function supported() {
  return { png: !!state.supported.png, jpeg: !!state.supported.jpeg, webp: !!state.supported.webp };
}

function failAll(message) {
  state.broken = message;
  for (const [id, entry] of state.pending) {
    clearTimeout(entry.timer);
    state.pending.delete(id);
    entry.reject(new Error(message));
  }
  for (const task of state.queue) task.rejectNow(new Error(message));
  state.queue = [];
  state.epoch++;
  state.running = 0;
  state.inflightBytes = 0;
  for (const slot of state.slots) {
    try { slot.worker.terminate(); } catch (_) {}
    if (slot.blobUrl) { try { URL.revokeObjectURL(slot.blobUrl); } catch (_) {} }
  }
  state.slots = [];
  state.readyPromise = null;
  state.maxConcurrent = 0;
  state.supported = { png: false, jpeg: false, webp: false };
}

/** 把输入归一成可 transfer 的 ArrayBuffer（+ 字节长度）。 */
async function normalizeInput(input) {
  if (!input) return null;
  // Blob / File（鸭子类型，兼容跨 realm）
  if (typeof input.arrayBuffer === 'function' && typeof input.size === 'number') {
    if (input.size === 0) return null;
    const ab = await input.arrayBuffer();
    return { buffer: ab, before: ab.byteLength };
  }
  if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) {
    if (input.byteLength === 0) return null;
    return { buffer: input, before: input.byteLength };
  }
  if (input && input.buffer instanceof ArrayBuffer && typeof input.byteLength === 'number') {
    if (input.byteLength === 0) return null;
    if (input.byteOffset === 0 && input.byteLength === input.buffer.byteLength) {
      return { buffer: input.buffer, before: input.byteLength };
    }
    const copy = new Uint8Array(input.byteLength);
    copy.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    return { buffer: copy.buffer, before: copy.byteLength };
  }
  return undefined; // 无法识别的类型
}

function defineLazyBlob(obj, bytes, mime) {
  Object.defineProperty(obj, 'blob', {
    enumerable: true,
    configurable: true,
    get() {
      const b = new Blob([bytes], { type: mime });
      Object.defineProperty(obj, 'blob', { value: b, enumerable: true, configurable: true, writable: false });
      return b;
    },
  });
}

async function compress(input, options) {
  const opt = options || {};
  try {
    const normalized = await normalizeInput(input);
    if (normalized === null) return { ok: false, reason: 'unsupported', message: 'empty input' };
    if (normalized === undefined) return { ok: false, reason: 'unsupported', message: 'input is not a Blob/ArrayBuffer/Uint8Array' };

    const buffer = normalized.buffer;
    const before = normalized.before;
    const bytes = new Uint8Array(buffer);
    const level = normalizeLevel(opt.level);
    const allowFormatChange = opt.allowFormatChange === true;
    const fast = opt.fast === true;
    const flattenAlpha = opt.flattenAlpha === true;
    const verify = opt.verify === undefined ? true : opt.verify;

    const format = sniffFormat(bytes);
    if (SUPPORTED_FORMATS.indexOf(format) < 0) return { ok: false, reason: 'unsupported', message: 'format=' + format };
    if (isAnimated(bytes, format)) return { ok: false, reason: 'unsupported', message: 'animated ' + format };

    const dims = imageDimensions(bytes, format);
    const wantSlots = Number(opt.concurrency) > 0 ? Number(opt.concurrency) : computeBaseSlots();
    state.maxConcurrent = Number(opt.concurrency) > 0 ? Math.min(Math.floor(Number(opt.concurrency)), MAX_POOL) : 0;
    const poolSize = await ensureWorkers(wantSlots);
    if (poolSize === 0) {
      return {
        ok: false,
        reason: 'codec-unavailable',
        message: state.broken || (state.errors && (state.errors[format] || state.errors.init)) || (format + ' codec unavailable'),
      };
    }
    if (!anySlotSupports(format)) {
      return {
        ok: false,
        reason: 'codec-unavailable',
        message: (state.errors && (state.errors[format] || state.errors.init)) || (format + ' codec unavailable'),
      };
    }

    const cost = estimateCost(dims, before);
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const res = await enqueue(cost, format, (slot) => rpc(slot, 'compress', {
      bytes: buffer,
      level,
      allowFormatChange,
      fast,
      flattenAlpha,
      verify,
      mime: MIME_BY_FORMAT[format],
    }, null, COMPRESS_TIMEOUT_MS));   // 注意：不再 transfer 输入缓冲，避免调用方手里的字节被掏空
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

    const outFormat = (res && res.outputFormat) || format;
    const outMime = MIME_BY_FORMAT[outFormat] || MIME_BY_FORMAT[format];
    const observation = {
      outputFormat: outFormat,
      hasAlpha: res && res.hasAlpha !== undefined ? res.hasAlpha : null,
      pngBytes: res && res.pngBytes !== undefined ? res.pngBytes : null,
      jpegBytes: res && res.jpegBytes !== undefined ? res.jpegBytes : null,
      skippedPngOptimise: !!(res && res.skippedPngOptimise),
      flattened: !!(res && res.flattened),
      decodeFailed: !!(res && res.decodeFailed),
      fastMode: !!(res && res.fastMode) || fast,
      verified: !!(res && res.verified),
      poolSize: state.maxConcurrent > 0 ? Math.min(poolSize, state.maxConcurrent) : poolSize,
      dims: dims || null,
    };
    if (!res || res.ok !== true) {
      const reason = (res && res.reason) || 'worker-error';
      const failure = Object.assign({
        ok: false,
        reason,
        message: res && res.message,
        before,
        after: res && res.after,
        codec: res && res.codec,
        mime: outMime,
      }, observation);
      if (reason === 'not-smaller' && res && format === 'png' && level !== 'lossless' && res.hasAlpha === false && !allowFormatChange) {
        // 这张 PNG 确定没有透明像素：换 JPEG 很可能大幅压小，但当前没开
        failure.formatChangeSuggested = true;
        failure.alternative = 'jpeg';
        failure.hint = 'pass { allowFormatChange: true } to try PNG→JPEG (MozJPEG)';
        const formatChangeExplicitlyDisabled = Object.prototype.hasOwnProperty.call(opt, 'allowFormatChange') && opt.allowFormatChange !== true;
        if (formatChangeExplicitlyDisabled) {
          failure.notSmallerReason = 'not-smaller';
          failure.reason = 'format-change-disabled';
        }
      }
      return failure;
    }
    const outBytes = new Uint8Array(res.buffer);
    const after = outBytes.byteLength;
    if (after >= before) {
      return Object.assign({ ok: false, reason: 'not-smaller', before, after, codec: res.codec, mime: outMime }, observation);
    }
    const result = Object.assign({
      ok: true,
      before,
      after,
      codec: res.codec,
      mime: outMime,
      level,
      ms,
      msWorker: res.ms,
      width: res.width,
      height: res.height,
      formatChanged: outFormat !== format,
      bytes: outBytes,
    }, observation);
    defineLazyBlob(result, outBytes, outMime);
    return result;
  } catch (e) {
    return { ok: false, reason: 'worker-error', message: String((e && e.message) || e) };
  }
}

function terminate() {
  failAll('worker terminated');
  state.errors = {};
  state.degraded = 0;
  return true;
}

const api = {
  version: VERSION,
  load,
  supported,
  compress,
  terminate,
  levels: LEVELS.slice(),
  defaultLevel: DEFAULT_LEVEL,
  codecIds: Object.assign({}, CODEC_ID),
  pngToJpegLevels: JSON.parse(JSON.stringify(PNG_TO_JPEG_LEVELS)),
  reasons: ['unsupported', 'not-smaller', 'format-change-disabled', 'codec-unavailable', 'worker-error', 'verify-failed', 'fast-mode-skip'],
  resolveBase: () => (state.resolved ? Object.assign({}, state.resolved) : resolveBase()),
  computeBaseSlots,
  isMobile: isMobileEnvironment,
  get state() {
    let ready = 0;
    for (const s of state.slots) if (s.ready) ready++;
    return {
      loaded: ready > 0,
      ready: !!state.readyPromise,
      supported: supported(),
      errors: Object.assign({}, state.errors),
      broken: state.broken,
      pool: { size: ready, created: state.slots.length, degraded: state.degraded, running: state.running, queued: state.queue.length, inflightBytes: state.inflightBytes },
    };
  },
};

if (typeof window !== 'undefined') window.stChatu8Compress = api;
else if (typeof globalThis !== 'undefined') globalThis.stChatu8Compress = api;

export default api;
