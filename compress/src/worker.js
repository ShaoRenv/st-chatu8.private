// st-chatu8-compress — Web Worker 入口（classic worker，esbuild 打成单文件 IIFE）
// 所有解码/编码都在这里发生，主线程只传 ArrayBuffer。

import { sniffFormat, isAnimated, SUPPORTED_FORMATS, MIME_BY_FORMAT, pngHeaderInfo } from './sniff.js';
import { initCodecs, status, errors, optimisePngBytes, encodeImageData, encodeJpegForConversion, hasTransparentPixels, normalizeLevel, CODEC_ID, LEVELS, DEFAULT_LEVEL, WASM_FILES } from './codec.js';

const VERSION = '1.0.0';
const MSG_TAG = 1;

let wasmBase = '';
let initDone = null;

function log(...args) {
  // 只打日志，不干扰主线程
  try { console.log('[st-chatu8-compress:worker]', ...args); } catch (_) {}
}

function loadWasm(name) {
  const url = new URL(name, wasmBase || self.location.href).href;
  return fetch(url, { credentials: 'same-origin' }).then((res) => {
    if (!res.ok) throw new Error('wasm fetch ' + name + ' → HTTP ' + res.status);
    return res.arrayBuffer();
  });
}

function ensureInit(base) {
  if (!initDone) {
    wasmBase = base || new URL('./wasm/', self.location.href).href;
    initDone = initCodecs(loadWasm, wasmBase);
  }
  return initDone;
}

async function decodeToImageData(bytes, format) {
  const mime = MIME_BY_FORMAT[format];
  const blob = new Blob([bytes], { type: mime });
  if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap unavailable');
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  } catch (_) {
    bitmap = await createImageBitmap(blob);
  }
  const width = bitmap.width;
  const height = bitmap.height;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    return { data: imageData.data, width, height };
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

async function runCompress(msg) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const bytes = msg.bytes instanceof ArrayBuffer ? new Uint8Array(msg.bytes) : new Uint8Array(0);
  const before = bytes.byteLength;
  const level = normalizeLevel(msg.level);
  const format = sniffFormat(bytes);

  if (SUPPORTED_FORMATS.indexOf(format) < 0) {
    return { ok: false, reason: 'unsupported', message: 'format=' + format, before };
  }
  if (isAnimated(bytes, format)) {
    return { ok: false, reason: 'unsupported', message: 'animated ' + format, before };
  }
  await ensureInit(wasmBase);
  if (!status()[format]) {
    return { ok: false, reason: 'codec-unavailable', message: (errors() || {})[format] || (format + ' codec init failed'), before };
  }

  const allowFormatChange = msg.allowFormatChange === true;
  let out;
  let width = 0;
  let height = 0;
  let outputFormat = format;
  let hasAlpha = null;          // 仅 PNG 有意义：true=真的用到透明像素 / false=确定不透明 / null=未检测
  let pngBytes = null;          // 诊断用：PNG→JPEG 两条路各自的字节数
  let jpegBytes = null;

  if (format === 'png') {
    // 无损路径：原始 PNG 字节 → oxipng，不解码、不重采样、像素与 alpha 完全不变
    const pngOut = await optimisePngBytes(bytes, level);
    out = pngOut;
    pngBytes = pngOut.byteLength;

    const wantConversion = allowFormatChange && level !== 'lossless';
    const info = pngHeaderInfo(bytes);
    const headerNoAlpha = !!(info && !info.hasAlphaChannel); // colorType 0/2/3：结构上就没有 alpha 通道
    // 需要像素级 alpha 判定的两种情况：
    //   1) 开了换格式 → 必须知道能否转 JPEG（顺便也要解码来编码）
    //   2) 没开换格式，但 level != lossless（有转换余地）且 IHDR 显示存在 alpha 通道 → 给调用方准确观测值 + 建议
    const needPixelCheck = wantConversion || (!headerNoAlpha && level !== 'lossless');
    let imageData = null;
    if (needPixelCheck) {
      try {
        imageData = await decodeToImageData(bytes, 'png');
        width = imageData.width;
        height = imageData.height;
        hasAlpha = hasTransparentPixels(imageData);
      } catch (_) {
        imageData = null;
        hasAlpha = headerNoAlpha ? false : null; // 解码失败：只保留 IHDR 能确定的部分
      }
    } else if (headerNoAlpha) {
      hasAlpha = false;
    } else {
      hasAlpha = null; // lossless 档 + 存在 alpha 通道：不做转换，也就不额外解码
    }
    if (wantConversion && imageData && hasAlpha === false) {
      const jpegOut = await encodeJpegForConversion(imageData, level);
      jpegBytes = jpegOut.byteLength;
      if (jpegOut.byteLength < pngOut.byteLength) {
        out = jpegOut;
        outputFormat = 'jpeg';
      }
    }
  } else {
    const imageData = await decodeToImageData(bytes, format);
    width = imageData.width;
    height = imageData.height;
    out = await encodeImageData(format, imageData, level);
  }

  const after = out.byteLength;
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  const meta = {
    codec: CODEC_ID[outputFormat],
    mime: MIME_BY_FORMAT[outputFormat],
    outputFormat,
    hasAlpha,
    pngBytes,
    jpegBytes,
    before,
    after,
    ms,
    level,
    width,
    height,
    format,
  };
  if (after >= before) {
    return Object.assign({ ok: false, reason: 'not-smaller' }, meta);
  }
  const buffer = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out.buffer : out.slice().buffer;
  return Object.assign({ ok: true, __transfer: [buffer], buffer }, meta);
}

const queue = { chain: Promise.resolve() };

function handle(message) {
  const msg = message || {};
  const id = msg.id;
  if (msg.type === 'init') {
    const base = msg.wasmBase || new URL('./wasm/', self.location.href).href;
    return ensureInit(base).then(() => {
      const sup = status();
      log('ready', JSON.stringify(sup));
      return { type: 'ready', supported: sup, errors: errors(), codecIds: CODEC_ID, levels: LEVELS, defaultLevel: DEFAULT_LEVEL, wasmBase, wasmFiles: WASM_FILES, version: VERSION };
    });
  }
  if (msg.type === 'compress') {
    return runCompress(msg);
  }
  if (msg.type === 'ping') {
    return { type: 'pong', t: Date.now(), state: { wasmBase, initialized: !!initDone, supported: status() } };
  }
  return { type: 'error', reason: 'bad-request', message: 'unknown type ' + String(msg.type) };
}

self.onmessage = (event) => {
  const msg = event.data || {};
  const id = msg.id;
  queue.chain = queue.chain
    .catch(() => {})
    .then(() => handle(msg))
    .then((result) => {
      const payload = Object.assign({ __c8c: MSG_TAG, id, ok: result && result.ok !== false }, result || {});
      const transfer = payload.__transfer;
      delete payload.__transfer;
      if (Array.isArray(transfer)) self.postMessage(payload, transfer);
      else self.postMessage(payload);
    })
    .catch((e) => {
      self.postMessage({ __c8c: MSG_TAG, id, ok: false, reason: 'worker-error', message: String((e && e.message) || e), stack: e && e.stack ? String(e.stack).slice(0, 1200) : undefined });
    });
  void id;
};
