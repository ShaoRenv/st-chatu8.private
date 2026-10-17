// st-chatu8-compress — 编码器内核（浏览器 worker 与 Node 测量脚本共用同一份源码）
//
// 全部编码在 Worker / Node 进程内本地完成，绝不联网发送图片数据。
// wasm 载入策略（硬性要求）：
//   * 一律 fetch(url).arrayBuffer()，**不使用 WebAssembly.instantiateStreaming**
//     （SillyTavern 静态服务不保证 .wasm 的 Content-Type）
//   * oxipng  : 把 ArrayBuffer 交给 wasm-bindgen init()，内部走 WebAssembly.instantiate(bytes, imports)
//   * mozjpeg / libwebp : WebAssembly.compile(bytes) 得到 Module，交给 emscripten 的
//     instantiateWasm 钩子用 new WebAssembly.Instance(module, imports) 实例化；
//     同时注入 locateFile，避免 emscripten 胶水层用 import.meta.url 拼路径而在 IIFE 里抛错。

import mozjpegEncode, { init as initMozjpeg } from '@jsquash/jpeg/encode.js';
import webpEncode, { init as initWebp } from '@jsquash/webp/encode.js';
import oxipngInit, { optimise as oxipngOptimise } from '@jsquash/oxipng/codec/pkg/squoosh_oxipng.js';
import { simd } from 'wasm-feature-detect';

export const LEVELS = ['lossless', 'balanced', 'max'];
export const DEFAULT_LEVEL = 'balanced';

/** 每个格式对应的编码器标识（compress() 返回值里的 codec 字段）。 */
export const CODEC_ID = { png: 'oxipng', jpeg: 'mozjpeg', webp: 'libwebp' };

// —— level 语义 ——
// PNG  : 真·无损重压缩（oxipng），level 越大搜索越狠
export const PNG_LEVELS = {
  lossless: { level: 1 },
  balanced: { level: 2 },
  max: { level: 3 },
};
// JPEG : 有损格式不存在数学无损；'lossless' 档 = 最高保真（质量 90）
export const JPEG_LEVELS = {
  lossless: { quality: 90 },
  balanced: { quality: 80 },
  max: { quality: 65 },
};
// PNG→JPEG 转换档（allowFormatChange:true 且 PNG 无 alpha 时使用）
// 4:4:4（chroma_subsample=1 + auto_subsample=false）是为了线稿/动画风格的细线少色渗。
export const PNG_TO_JPEG_LEVELS = {
  balanced: { quality: 88, progressive: true, optimize_coding: true, auto_subsample: false, chroma_subsample: 1, quant_table: 3 },
  max: { quality: 80, progressive: true, optimize_coding: true, auto_subsample: false, chroma_subsample: 1, quant_table: 3 },
};

// WebP : 同上，'lossless' = 质量 90 / 低搜索强度
export const WEBP_LEVELS = {
  lossless: { quality: 90, method: 4 },
  balanced: { quality: 80, method: 5 },
  max: { quality: 65, method: 6 },
};

export const WASM_FILES = {
  jpeg: 'mozjpeg_enc.wasm',
  webp: 'webp_enc.wasm',
  webpSimd: 'webp_enc_simd.wasm',
  oxipng: 'squoosh_oxipng_bg.wasm',
};

const ready = { png: false, jpeg: false, webp: false };
const initError = {};
let initPromise = null;

export function normalizeLevel(level) {
  return LEVELS.indexOf(level) >= 0 ? level : DEFAULT_LEVEL;
}

export function status() {
  return { png: ready.png, jpeg: ready.jpeg, webp: ready.webp };
}

export function errors() {
  return { ...initError };
}

async function compile(bytes) {
  const buf = bytes instanceof ArrayBuffer ? bytes : (bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0));
  return WebAssembly.compile(buf);
}

async function initJpegCodec(loadWasm, wasmBase) {
  const bytes = await loadWasm(WASM_FILES.jpeg);
  const module = await compile(bytes);
  await initMozjpeg(module, { locateFile: (p) => wasmBase + p });
  ready.jpeg = true;
}

async function initWebpCodec(loadWasm, wasmBase) {
  let useSimd = false;
  try { useSimd = await simd(); } catch (_) { useSimd = false; }
  const bytes = await loadWasm(useSimd ? WASM_FILES.webpSimd : WASM_FILES.webp);
  const module = await compile(bytes);
  await initWebp(module, { locateFile: (p) => wasmBase + p });
  ready.webp = true;
}

async function initOxipngCodec(loadWasm) {
  const bytes = await loadWasm(WASM_FILES.oxipng);
  await oxipngInit(bytes);
  ready.png = true;
}

/**
 * 初始化三个编码器。单个失败不影响其他（supported() 会如实返回 false）。
 * @param {(name: string) => Promise<ArrayBuffer|Uint8Array>} loadWasm
 * @param {string} wasmBase 绝对 URL 前缀（含结尾 /），仅用于 emscripten locateFile 兜底
 */
export function initCodecs(loadWasm, wasmBase = '') {
  if (initPromise) return initPromise;
  const tasks = [
    ['png', () => initOxipngCodec(loadWasm)],
    ['jpeg', () => initJpegCodec(loadWasm, wasmBase)],
    ['webp', () => initWebpCodec(loadWasm, wasmBase)],
  ];
  initPromise = Promise.all(tasks.map(async ([name, run]) => {
    try {
      await run();
    } catch (e) {
      ready[name] = false;
      initError[name] = String((e && e.message) || e);
    }
  })).then(() => status());
  return initPromise;
}

/** PNG 无损重压缩：直接把原始 PNG 字节交给 oxipng，不解码不重采样，alpha/色彩完全保留。 */
export async function optimisePngBytes(pngBytes, level) {
  const opts = PNG_LEVELS[normalizeLevel(level)];
  const u8 = pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes);
  // 注意：这是 wasm-bindgen 的底层导出，参数是位置参数 (data, level, interlace, optimiseAlpha)，
  // 不是 jSquash 上层 optimise.js 的对象签名。
  const out = oxipngOptimise(u8, opts.level, false, false);
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

/** 有损格式重编码：输入必须是 {data: Uint8ClampedArray, width, height} 形态的 RGBA 像素。 */
export async function encodeImageData(format, imageData, level) {
  const lvl = normalizeLevel(level);
  if (format === 'jpeg') {
    const out = await mozjpegEncode(imageData, JPEG_LEVELS[lvl]);
    return new Uint8Array(out);
  }
  if (format === 'webp') {
    const out = await webpEncode(imageData, WEBP_LEVELS[lvl]);
    return new Uint8Array(out);
  }
  throw new Error('encodeImageData: unsupported format ' + format);
}

/** 像素级 alpha 检测：RGBA 缓冲里只要有一个像素 alpha < 255 就算"用到透明"。 */
export function hasTransparentPixels(rgba) {
  const d = rgba && rgba.data ? rgba.data : rgba;
  if (!d) return false;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 255) return true;
  }
  return false;
}

/** PNG→JPEG 转换专用编码器（与 JPEG 输入的档位表相互独立，互不影响）。 */
export async function encodeJpegForConversion(imageData, level) {
  const opts = PNG_TO_JPEG_LEVELS[normalizeLevel(level)] || PNG_TO_JPEG_LEVELS.balanced;
  return new Uint8Array(await mozjpegEncode(imageData, opts));
}

/** 显式参数编码出口（测量脚本用于生成高保真原图 / 未来 UI 精调档位）。 */
export async function encodeJpegOptions(imageData, options) {
  return new Uint8Array(await mozjpegEncode(imageData, options || {}));
}

export async function encodeWebpOptions(imageData, options) {
  return new Uint8Array(await webpEncode(imageData, options || {}));
}

/** 仅供测量/自检：描述每个档位实际使用的参数。 */
export function describeLevels() {
  return {
    png: { codec: CODEC_ID.png, params: PNG_LEVELS, note: 'lossless recompression (oxipng), no pixel change' },
    jpeg: { codec: CODEC_ID.jpeg, params: JPEG_LEVELS, note: 'lossy re-encode (mozjpeg), lossless tier = highest fidelity' },
    webp: { codec: CODEC_ID.webp, params: WEBP_LEVELS, note: 'lossy re-encode (libwebp), lossless tier = highest fidelity' },
    pngToJpeg: { codec: CODEC_ID.jpeg, params: PNG_TO_JPEG_LEVELS, note: 'opt-in PNG→JPEG (allowFormatChange), only when PNG has no transparent pixel; lossless tier never converts' },
    levels: LEVELS,
    defaultLevel: DEFAULT_LEVEL,
  };
}
