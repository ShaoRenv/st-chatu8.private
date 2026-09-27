// st-chatu8-compress — 主线程 API，挂到 window.stChatu8Compress
// 契约：load() / supported() / compress(blob,{level}) / terminate()
// 硬性：compress 绝不抛异常；编码全在 worker；输入格式 == 输出格式；不联网。

import { sniffFormat, isAnimated, SUPPORTED_FORMATS, MIME_BY_FORMAT } from './sniff.js';
import { LEVELS, DEFAULT_LEVEL, normalizeLevel, CODEC_ID, PNG_TO_JPEG_LEVELS } from './codec.js';

const VERSION = '1.0.0';
const DEFAULT_BASE_RELATIVE = 'scripts/extensions/third-party/st-chatu8/compress';
const INIT_TIMEOUT_MS = 120000;
const COMPRESS_TIMEOUT_MS = 300000;

// 脚本求值时锁存自身 URL（document.currentScript 只在同步求值期间有效）
const SELF_SCRIPT_SRC = (function () {
  try {
    if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) return document.currentScript.src;
  } catch (_) {}
  return '';
})();

const state = {
  worker: null,
  readyPromise: null,
  seq: 0,
  pending: new Map(),
  supported: { png: false, jpeg: false, webp: false },
  errors: {},
  broken: null,
  resolved: null,
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

function attach(worker) {
  worker.onmessage = (event) => {
    const msg = event.data || {};
    const entry = state.pending.get(msg.id);
    if (!entry) return;
    state.pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  };
  worker.onerror = (event) => {
    const message = (event && (event.message || (event.error && event.error.message))) || 'worker error';
    failAll('worker-error: ' + message);
  };
  worker.onmessageerror = () => failAll('worker-error: message deserialization failed');
}

function failAll(message) {
  state.broken = message;
  for (const [id, entry] of state.pending) {
    clearTimeout(entry.timer);
    state.pending.delete(id);
    entry.reject(new Error(message));
  }
  if (state.worker) {
    try { state.worker.terminate(); } catch (_) {}
  }
  state.worker = null;
  state.readyPromise = null;
  state.supported = { png: false, jpeg: false, webp: false };
}

function rpc(type, payload, transfer, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!state.worker) { reject(new Error('worker not available')); return; }
    const id = ++state.seq;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(type + ' timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    state.pending.set(id, { resolve, reject, timer });
    try {
      state.worker.postMessage(Object.assign({ __c8c: 1, id, type }, payload || {}), transfer || []);
    } catch (e) {
      state.pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function load(options) {
  if (state.readyPromise) return state.readyPromise;
  state.readyPromise = (async () => {
    try {
      const urls = resolveBase(options);
      state.resolved = urls;
      const created = createWorker(urls.workerUrl);
      state.worker = created.worker;
      state.broken = null;
      attach(state.worker);
      const res = await rpc('init', { wasmBase: urls.wasmBase }, null, INIT_TIMEOUT_MS);
      if (res.type !== 'ready') throw new Error('unexpected init reply: ' + String(res.type));
      state.supported = Object.assign({ png: false, jpeg: false, webp: false }, res.supported || {});
      state.errors = res.errors || {};
      return {
        ok: !!(state.supported.png || state.supported.jpeg || state.supported.webp),
        supported: Object.assign({}, state.supported),
        errors: Object.assign({}, state.errors),
        workerUrl: urls.workerUrl,
        wasmBase: urls.wasmBase,
        base: urls.base,
        baseSource: urls.source,
        workerMode: created.mode,
        version: VERSION,
      };
    } catch (e) {
      const message = String((e && e.message) || e);
      if (state.worker) { try { state.worker.terminate(); } catch (_) {} }
      state.worker = null;
      state.readyPromise = null;
      state.supported = { png: false, jpeg: false, webp: false };
      state.errors = { init: message };
      return { ok: false, supported: Object.assign({}, state.supported), errors: Object.assign({}, state.errors), reason: message };
    }
  })();
  return state.readyPromise;
}

function supported() {
  return { png: !!state.supported.png, jpeg: !!state.supported.jpeg, webp: !!state.supported.webp };
}

async function compress(blob, options) {
  const opt = options || {};
  try {
    if (!blob || typeof blob.arrayBuffer !== 'function' || typeof blob.size !== 'number') {
      return { ok: false, reason: 'unsupported', message: 'input is not a Blob/File' };
    }
    const level = normalizeLevel(opt.level);
    const allowFormatChange = opt.allowFormatChange === true;
    // 调用方"显式"关掉换格式（写了 allowFormatChange:false）时，才有必要把 not-smaller 解释成
    // "是你关掉了换格式这条路"，从而给出 format-change-disabled；默认省略该选项时保持原契约 not-smaller。
    const formatChangeExplicitlyDisabled = Object.prototype.hasOwnProperty.call(opt, 'allowFormatChange') && opt.allowFormatChange !== true;
    const before = blob.size;
    if (before === 0) return { ok: false, reason: 'unsupported', message: 'empty input' };

    const buffer = await blob.arrayBuffer();
    const format = sniffFormat(new Uint8Array(buffer));
    if (SUPPORTED_FORMATS.indexOf(format) < 0) return { ok: false, reason: 'unsupported', message: 'format=' + format };
    if (isAnimated(new Uint8Array(buffer), format)) return { ok: false, reason: 'unsupported', message: 'animated ' + format };

    const ready = await load();
    if (!state.worker || !supported()[format]) {
      return { ok: false, reason: 'codec-unavailable', message: (state.errors && (state.errors[format] || state.errors.init)) || (format + ' codec unavailable') };
    }

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const res = await rpc('compress', { bytes: buffer, level, allowFormatChange, mime: MIME_BY_FORMAT[format] }, [buffer], COMPRESS_TIMEOUT_MS);
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    const outFormat = (res && res.outputFormat) || format;
    const outMime = MIME_BY_FORMAT[outFormat] || MIME_BY_FORMAT[format];
    const observation = {
      outputFormat: outFormat,
      hasAlpha: res && res.hasAlpha !== undefined ? res.hasAlpha : null,
      pngBytes: res && res.pngBytes !== undefined ? res.pngBytes : null,
      jpegBytes: res && res.jpegBytes !== undefined ? res.jpegBytes : null,
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
    return Object.assign({
      ok: true,
      blob: new Blob([outBytes], { type: outMime }),
      codec: res.codec,
      before,
      after,
      mime: outMime,
      level,
      ms,
      msWorker: res.ms,
      width: res.width,
      height: res.height,
      formatChanged: outFormat !== format,
    }, observation);
  } catch (e) {
    return { ok: false, reason: 'worker-error', message: String((e && e.message) || e) };
  }
}

function terminate() {
  for (const [id, entry] of state.pending) {
    clearTimeout(entry.timer);
    state.pending.delete(id);
    entry.reject(new Error('worker terminated'));
  }
  if (state.worker) {
    try { state.worker.terminate(); } catch (_) {}
  }
  state.worker = null;
  state.readyPromise = null;
  state.supported = { png: false, jpeg: false, webp: false };
  state.errors = {};
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
  reasons: ['unsupported', 'not-smaller', 'format-change-disabled', 'codec-unavailable', 'worker-error'],
  resolveBase: () => (state.resolved ? Object.assign({}, state.resolved) : resolveBase()),
  get state() {
    return {
      loaded: !!state.worker,
      ready: !!state.readyPromise,
      supported: supported(),
      errors: Object.assign({}, state.errors),
      broken: state.broken,
    };
  },
};

if (typeof window !== 'undefined') window.stChatu8Compress = api;
else if (typeof globalThis !== 'undefined') globalThis.stChatu8Compress = api;

export default api;

void LEVELS;
void sniffFormat;
