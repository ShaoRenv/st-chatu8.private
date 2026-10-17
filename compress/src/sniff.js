// st-chatu8-compress — 输入格式嗅探（纯函数，无副作用，worker 与 Node 测量共用）
// 只认三种可处理格式：png / jpeg / webp；gif 与未知一律视为 unsupported。

export const SUPPORTED_FORMATS = ['png', 'jpeg', 'webp'];

export const MIME_BY_FORMAT = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (bytes && bytes.buffer instanceof ArrayBuffer) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(0);
}

/** 按魔数判断容器格式（不看 MIME、不看扩展名）。 */
export function sniffFormat(bytes) {
  const u8 = toU8(bytes);
  if (u8.length >= 8 &&
      u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 &&
      u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a) return 'png';
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpeg';
  if (u8.length >= 12 &&
      u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
      u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'webp';
  if (u8.length >= 6 &&
      u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38 &&
      (u8[4] === 0x37 || u8[4] === 0x39) && u8[5] === 0x61) return 'gif';
  return 'unknown';
}

function hasPngChunk(u8, type) {
  // PNG: 8 字节签名后是 [len(4) type(4) data(len) crc(4)]，只扫到 IDAT 之前
  let off = 8;
  const typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  while (off + 8 <= u8.length) {
    const len = (u8[off] << 24 | u8[off + 1] << 16 | u8[off + 2] << 8 | u8[off + 3]) >>> 0;
    const isTarget = u8[off + 4] === typeBytes[0] && u8[off + 5] === typeBytes[1] &&
                     u8[off + 6] === typeBytes[2] && u8[off + 7] === typeBytes[3];
    if (isTarget) return true;
    // IDAT 之后不会再出现 acTL，直接收工
    if (u8[off + 4] === 0x49 && u8[off + 5] === 0x44 && u8[off + 6] === 0x41 && u8[off + 7] === 0x54) return false;
    if (len > u8.length) return false;
    off += 12 + len;
  }
  return false;
}

function hasWebpChunk(u8, fourcc) {
  // RIFF: 'RIFF' size(4) 'WEBP' 之后是 [fourcc(4) size(4) data(size + pad)]
  let off = 12;
  const c = [fourcc.charCodeAt(0), fourcc.charCodeAt(1), fourcc.charCodeAt(2), fourcc.charCodeAt(3)];
  while (off + 8 <= u8.length) {
    const size = (u8[off + 4] | u8[off + 5] << 8 | u8[off + 6] << 16 | u8[off + 7] << 24) >>> 0;
    if (u8[off] === c[0] && u8[off + 1] === c[1] && u8[off + 2] === c[2] && u8[off + 3] === c[3]) return true;
    off += 8 + size + (size % 2);
  }
  return false;
}

/**
 * 从 IHDR 读 PNG 色彩类型（不解码）：0=灰度 2=RGB 3=调色板 4=灰度+alpha 6=RGBA。
 * 返回 { colorType, hasAlphaChannel }；解析失败返回 null。
 * 注意：hasAlphaChannel 只说明"存在 alpha 通道"，通道里是否真的用到透明像素要靠像素检测。
 */
export function pngHeaderInfo(bytes) {
  const u8 = toU8(bytes);
  if (sniffFormat(u8) !== 'png') return null;
  if (u8.length < 26 || u8[12] !== 0x49 || u8[13] !== 0x48 || u8[14] !== 0x44 || u8[15] !== 0x52) return null;
  const colorType = u8[25];
  return { colorType, hasAlphaChannel: colorType === 4 || colorType === 6 };
}

// ————— v1.2.0 新增：从文件头读尺寸（不解码），用于 worker 池的内存预算背压 —————

function pngDimensions(u8) {
  if (u8.length < 24) return null;
  if (u8[12] !== 0x49 || u8[13] !== 0x48 || u8[14] !== 0x44 || u8[15] !== 0x52) return null;
  const w = (u8[16] << 24 | u8[17] << 16 | u8[18] << 8 | u8[19]) >>> 0;
  const h = (u8[20] << 24 | u8[21] << 16 | u8[22] << 8 | u8[23]) >>> 0;
  return (w > 0 && h > 0) ? { width: w, height: h } : null;
}

function jpegDimensions(u8) {
  let off = 2; // 跳过 SOI
  while (off + 3 < u8.length) {
    if (u8[off] !== 0xff) { off++; continue; }
    const marker = u8[off + 1];
    if (marker === 0xff) { off++; continue; }     // 填充字节
    if (marker === 0x00) { off += 2; continue; }  // 压缩数据里的 0xFF00
    off += 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue; // 无长度字段
    if (off + 2 > u8.length) return null;
    const len = (u8[off] << 8 | u8[off + 1]) >>> 0;
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (off + 7 > u8.length) return null;
      const h = (u8[off + 3] << 8 | u8[off + 4]) >>> 0;
      const w = (u8[off + 5] << 8 | u8[off + 6]) >>> 0;
      return (w > 0 && h > 0) ? { width: w, height: h } : null;
    }
    if (marker === 0xda) return null; // 到了 SOS，后面是压缩数据
    off += len;
  }
  return null;
}

function webpDimensions(u8) {
  if (u8.length < 16) return null;
  let off = 12;
  while (off + 8 <= u8.length) {
    const c0 = u8[off], c1 = u8[off + 1], c2 = u8[off + 2], c3 = u8[off + 3];
    const size = (u8[off + 4] | u8[off + 5] << 8 | u8[off + 6] << 16 | u8[off + 7] << 24) >>> 0;
    const p = off + 8;
    // VP8X（扩展格式：alpha / 动画）：画布尺寸 24 位小端，存的是 size-1
    if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x58 && p + 10 <= u8.length) {
      const w = (u8[p + 4] | u8[p + 5] << 8 | u8[p + 6] << 16) + 1;
      const h = (u8[p + 7] | u8[p + 8] << 8 | u8[p + 9] << 16) + 1;
      return (w > 0 && h > 0) ? { width: w, height: h } : null;
    }
    // VP8L（无损）：0x2F + 14 位宽-1 + 14 位高-1
    if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x4c && p + 5 <= u8.length) {
      if (u8[p] !== 0x2f) return null;
      const b0 = u8[p + 1], b1 = u8[p + 2], b2 = u8[p + 3], b3 = u8[p + 4];
      const w = 1 + (((b1 & 0x3f) << 8) | b0);
      const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return (w > 0 && h > 0) ? { width: w, height: h } : null;
    }
    // VP8 （有损）：3 字节帧标签 + 起始码 9D 01 2A + 14 位宽 + 14 位高
    if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x20 && p + 10 <= u8.length) {
      if (!(u8[p + 3] === 0x9d && u8[p + 4] === 0x01 && u8[p + 5] === 0x2a)) return null;
      const w = (u8[p + 6] | u8[p + 7] << 8) & 0x3fff;
      const h = (u8[p + 8] | u8[p + 9] << 8) & 0x3fff;
      return (w > 0 && h > 0) ? { width: w, height: h } : null;
    }
    off = p + size + (size % 2);
  }
  return null;
}

/**
 * 从文件头读原始像素尺寸（不解码、不联网、纯函数）。
 * 解析不出来返回 null —— 调用方必须能接受 null（退化为按字节数估算）。
 */
export function imageDimensions(bytes, format) {
  const u8 = toU8(bytes);
  const fmt = format || sniffFormat(u8);
  try {
    if (fmt === 'png') return pngDimensions(u8);
    if (fmt === 'jpeg') return jpegDimensions(u8);
    if (fmt === 'webp') return webpDimensions(u8);
  } catch (_) {}
  return null;
}

/**
 * 动图检测：APNG(acTL) / 动态 WebP(ANIM) 都要拒绝——契约要求输出与输入同为静态图，
 * 而我们只编码第一帧，静默丢帧属于数据损失，必须如实拒绝。
 */
export function isAnimated(bytes, format) {
  const u8 = toU8(bytes);
  const fmt = format || sniffFormat(u8);
  if (fmt === 'png') return hasPngChunk(u8, 'acTL');
  if (fmt === 'webp') return hasWebpChunk(u8, 'ANIM');
  if (fmt === 'gif') return u8.length >= 6;
  return false;
}
