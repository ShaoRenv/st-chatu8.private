// st-chatu8-compress — Web Worker 入口（classic worker，esbuild 打成单文件 IIFE）
// 所有解码/编码都在这里发生，主线程只传 ArrayBuffer。
// v1.2.0：结果解码校验下沉到本 worker；新增「极速模式」(fast)。

import { sniffFormat, isAnimated, SUPPORTED_FORMATS, MIME_BY_FORMAT, pngHeaderInfo } from './sniff.js';
import { initCodecs, status, errors, optimisePngBytes, encodeImageData, encodeJpegForConversion, hasTransparentPixels, normalizeLevel, CODEC_ID, LEVELS, DEFAULT_LEVEL, WASM_FILES } from './codec.js';

const VERSION = '1.2.0';
const MSG_TAG = 1;

// PNG→JPEG 提速阈值（两个条件都满足才跳过 oxipng，保守）：
//   1) JPEG 已压到原图 PNG_SKIP_OPTIMISE_RATIO 以下（要赢它，无损重压缩得再省掉一大半）；
//   2) 原 PNG 本身"稠密"（≥ PNG_SKIP_MIN_BYTES_PER_PIXEL 字节/像素）——这类图 PNG 熵编码本就没优势、oxipng 通常只再省 10~30%。
//   反例（实测）：1024² 平滑渐变 PNG 100,671 B（0.096 B/px），JPEG 28,987 B 却输给 oxipng 的 19,608 B，
//   所以"低密度 PNG"（渐变/纯色/大片平坦区）一律照旧跑 oxipng 再比较。
const PNG_SKIP_OPTIMISE_RATIO = 0.4;
const PNG_SKIP_MIN_BYTES_PER_PIXEL = 0.5;

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

/**
 * 结果解码校验（v1.2.0 从主线程下沉到这里）：
 * 只把即将写回库里的字节再解一次，确认浏览器读得懂。解不开就是坏结果，必须如实报失败。
 * 没有 createImageBitmap 时按"通过"处理（与 v1.1.1 主线程侧的行为一致）。
 */
/** 把带 alpha 的 RGBA 铺到纯色背景上，得到完全不透明的像素（用于 PNG→JPEG）。 */
async function flattenToOpaque(imageData, r, g, b) {
  const width = imageData.width;
  const height = imageData.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
  ctx.fillRect(0, 0, width, height);
  const tmp = new OffscreenCanvas(width, height);
  const tctx = tmp.getContext('2d');
  if (!tctx) throw new Error('OffscreenCanvas 2d context unavailable');
  tctx.putImageData(imageData, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  const out = ctx.getImageData(0, 0, width, height);
  return { data: out.data, width, height };
}

async function canDecodeOutput(u8, mime) {
  if (typeof createImageBitmap !== 'function') return true;
  try {
    const blob = new Blob([u8], { type: mime });
    const bitmap = await createImageBitmap(blob);
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    return true;
  } catch (_) {
    return false;
  }
}

async function runCompress(msg) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const bytes = msg.bytes instanceof ArrayBuffer ? new Uint8Array(msg.bytes) : new Uint8Array(0);
  const before = bytes.byteLength;
  const level = normalizeLevel(msg.level);
  const format = sniffFormat(bytes);
  const fast = msg.fast === true;
  const verifyOpt = msg.verify === undefined ? true : msg.verify;

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
  // 铺白背景后转 JPEG：默认启用（不再提供开关）。图片本身没有透明像素时铺白是空操作。
  const flattenAlpha = msg.flattenAlpha !== false;
  let out = null;
  let width = 0;
  let height = 0;
  let outputFormat = format;
  let hasAlpha = null;          // 仅 PNG 有意义：true=真的用到透明像素 / false=确定不透明 / null=未检测
  let pngBytes = null;          // 诊断用：PNG→JPEG 两条路各自的字节数（跳过 oxipng 时为 null）
  let jpegBytes = null;
  let skippedPngOptimise = false; // true = 未再跑 oxipng（提速 / 极速路径）
  let flattened = false;          // true = 透明 PNG 被铺白后转 JPEG
  let decodeFailed = false;       // true = 无法解码（WebView 缺 OffscreenCanvas/createImageBitmap）

  const failMeta = () => ({
    codec: CODEC_ID[outputFormat],
    mime: MIME_BY_FORMAT[outputFormat],
    outputFormat,
    hasAlpha,
    pngBytes,
    jpegBytes,
    before,
    after: before,
    level,
    width,
    height,
    format,
    skippedPngOptimise,
    fastMode: fast,
    verified: false,
  });

  if (format === 'png') {
    const info = pngHeaderInfo(bytes);
    const headerNoAlpha = !!(info && !info.hasAlphaChannel); // colorType 0/2/3：结构上就没有 alpha 通道
    // 极速模式只改变「跑不跑 oxipng」，不改变「要不要换格式」：
    // level='lossless' 时本来就不转 JPEG（无损优先是用户的明确承诺，不能被极速模式悄悄推翻——
    // 批量压缩是不可撤销的，转成 JPEG 就是不可逆的画质损失）。此时极速模式对 PNG 等于"原样保留"。
    const wantConversion = allowFormatChange && level !== 'lossless';
    if (!wantConversion) {
      if (fast) {
        // 极速 + 不允许换格式：既不能跑 oxipng 也不能转 JPEG → 原样保留
        hasAlpha = headerNoAlpha ? false : null;
        return Object.assign({ ok: false, reason: 'fast-mode-skip', message: 'fast mode: png kept as-is (format change disabled)' }, failMeta());
      }
      // 无损路径（与 v1.1.1 完全一致）：原始 PNG 字节 → oxipng，不解码、不重采样
      const pngOut = await optimisePngBytes(bytes, level);
      pngBytes = pngOut.byteLength;
      out = pngOut;
      if (headerNoAlpha) {
        hasAlpha = false;
      } else if (level !== 'lossless') {
        try {
          const imageData = await decodeToImageData(bytes, 'png');
          width = imageData.width;
          height = imageData.height;
          hasAlpha = hasTransparentPixels(imageData);
        } catch (_) {
          hasAlpha = null;
        }
      } else {
        hasAlpha = null; // lossless 档 + 存在 alpha 通道：不做转换，也就不额外解码
      }
    } else {
      // 换格式路径：无论如何都要解码一次（判 alpha + 拿像素编码 JPEG）
      let imageData = null;
      try {
        imageData = await decodeToImageData(bytes, 'png');
        width = imageData.width;
        height = imageData.height;
        hasAlpha = headerNoAlpha ? false : hasTransparentPixels(imageData);
      } catch (_) {
        imageData = null;
        decodeFailed = true;                     // 解码失败：如实上报，不再静默降级成 oxipng
        hasAlpha = headerNoAlpha ? false : null; // 只保留 IHDR 能确定的部分
      }
      if (imageData && hasAlpha === true && flattenAlpha) {
        // 铺白：NovelAI 的 PNG 常带 alpha 通道（多数像素其实全不透明），只跑 oxipng 只能省 10~20%；
        // 铺白后转 JPEG 能到原图 1/10 以下。代价：透明区域变成白色。
        try {
          imageData = await flattenToOpaque(imageData, 255, 255, 255);
          hasAlpha = false;
          flattened = true;
        } catch (_) { /* 铺白失败就退回只跑 oxipng */ }
      }
      if (imageData && hasAlpha === false) {
        // 先跑便宜的那条：MozJPEG（1024² 约 0.2s，2048² 约 1.2s）
        const jpegOut = await encodeJpegForConversion(imageData, level);
        jpegBytes = jpegOut.byteLength;
        const pixels = width * height;
        const densePng = pixels > 0 && before / pixels >= PNG_SKIP_MIN_BYTES_PER_PIXEL;
        if (fast) {
          // 极速模式：只信 MozJPEG，永不跑 oxipng
          out = jpegOut;
          outputFormat = 'jpeg';
          skippedPngOptimise = true;
        } else if (densePng && jpegOut.byteLength <= before * PNG_SKIP_OPTIMISE_RATIO) {
          // JPEG 已经把体积压到原图 40% 以下：无损重压缩（oxipng）不可能反超，
          // 直接采用 JPEG 并跳过 oxipng（1024² 省约 1.1s、2048² 省约 4.6s）
          out = jpegOut;
          outputFormat = 'jpeg';
          skippedPngOptimise = true;
        } else {
          const pngOut = await optimisePngBytes(bytes, level);
          pngBytes = pngOut.byteLength;
          if (jpegOut.byteLength < pngOut.byteLength) {
            out = jpegOut;
            outputFormat = 'jpeg';
          } else {
            out = pngOut;
          }
        }
      } else if (fast) {
        // 真的有透明像素 / 解码失败：极速模式不冒险，原样保留
        return Object.assign({
          ok: false,
          reason: 'fast-mode-skip',
          message: imageData ? 'fast mode: transparent png kept as-is' : 'fast mode: png decode failed',
        }, failMeta());
      } else {
        const pngOut = await optimisePngBytes(bytes, level);
        pngBytes = pngOut.byteLength;
        out = pngOut;
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
    skippedPngOptimise,
    flattened,
    decodeFailed,
    fastMode: fast,
  };
  if (after >= before) {
    return Object.assign({ ok: false, reason: 'not-smaller' }, meta);
  }

  // 校验策略：true=一定校验；'auto'=只在换格式时校验；false=不校验
  let verified = false;
  const shouldVerify = verifyOpt === true || (verifyOpt === 'auto' && outputFormat !== format);
  if (shouldVerify) {
    const okOutput = await canDecodeOutput(out, MIME_BY_FORMAT[outputFormat]);
    if (!okOutput) {
      return Object.assign({ ok: false, reason: 'verify-failed', message: 'output could not be decoded' }, meta);
    }
    verified = true;
  }

  const buffer = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out.buffer : out.slice().buffer;
  return Object.assign({ ok: true, __transfer: [buffer], buffer, verified, flattened, decodeFailed, fastMode: fast }, meta);
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
