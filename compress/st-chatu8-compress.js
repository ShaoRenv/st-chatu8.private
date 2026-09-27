/*! st-chatu8-compress v1.0.0 | WASM 图像压缩模块（PNG/JPEG/WebP）
 * 本地计算，不联网。第三方编码器许可见 THIRD-PARTY-LICENSES.md
 * codecs: oxipng (MIT) / MozJPEG (IJG+BSD-style) / libwebp (BSD-3-Clause)
 */
(() => {
  // src/sniff.js
  var SUPPORTED_FORMATS = ["png", "jpeg", "webp"];
  var MIME_BY_FORMAT = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp"
  };
  function toU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (bytes && bytes.buffer instanceof ArrayBuffer) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return new Uint8Array(0);
  }
  function sniffFormat(bytes) {
    const u8 = toU8(bytes);
    if (u8.length >= 8 && u8[0] === 137 && u8[1] === 80 && u8[2] === 78 && u8[3] === 71 && u8[4] === 13 && u8[5] === 10 && u8[6] === 26 && u8[7] === 10) return "png";
    if (u8.length >= 3 && u8[0] === 255 && u8[1] === 216 && u8[2] === 255) return "jpeg";
    if (u8.length >= 12 && u8[0] === 82 && u8[1] === 73 && u8[2] === 70 && u8[3] === 70 && u8[8] === 87 && u8[9] === 69 && u8[10] === 66 && u8[11] === 80) return "webp";
    if (u8.length >= 6 && u8[0] === 71 && u8[1] === 73 && u8[2] === 70 && u8[3] === 56 && (u8[4] === 55 || u8[4] === 57) && u8[5] === 97) return "gif";
    return "unknown";
  }
  function hasPngChunk(u8, type) {
    let off = 8;
    const typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
    while (off + 8 <= u8.length) {
      const len = (u8[off] << 24 | u8[off + 1] << 16 | u8[off + 2] << 8 | u8[off + 3]) >>> 0;
      const isTarget = u8[off + 4] === typeBytes[0] && u8[off + 5] === typeBytes[1] && u8[off + 6] === typeBytes[2] && u8[off + 7] === typeBytes[3];
      if (isTarget) return true;
      if (u8[off + 4] === 73 && u8[off + 5] === 68 && u8[off + 6] === 65 && u8[off + 7] === 84) return false;
      if (len > u8.length) return false;
      off += 12 + len;
    }
    return false;
  }
  function hasWebpChunk(u8, fourcc) {
    let off = 12;
    const c = [fourcc.charCodeAt(0), fourcc.charCodeAt(1), fourcc.charCodeAt(2), fourcc.charCodeAt(3)];
    while (off + 8 <= u8.length) {
      const size = (u8[off + 4] | u8[off + 5] << 8 | u8[off + 6] << 16 | u8[off + 7] << 24) >>> 0;
      if (u8[off] === c[0] && u8[off + 1] === c[1] && u8[off + 2] === c[2] && u8[off + 3] === c[3]) return true;
      off += 8 + size + size % 2;
    }
    return false;
  }
  function isAnimated(bytes, format) {
    const u8 = toU8(bytes);
    const fmt = format || sniffFormat(u8);
    if (fmt === "png") return hasPngChunk(u8, "acTL");
    if (fmt === "webp") return hasWebpChunk(u8, "ANIM");
    if (fmt === "gif") return u8.length >= 6;
    return false;
  }

  // src/codec.js
  var LEVELS = ["lossless", "balanced", "max"];
  var DEFAULT_LEVEL = "balanced";
  var CODEC_ID = { png: "oxipng", jpeg: "mozjpeg", webp: "libwebp" };
  var PNG_TO_JPEG_LEVELS = {
    balanced: { quality: 88, progressive: true, optimize_coding: true, auto_subsample: false, chroma_subsample: 1, quant_table: 3 },
    max: { quality: 80, progressive: true, optimize_coding: true, auto_subsample: false, chroma_subsample: 1, quant_table: 3 }
  };
  function normalizeLevel(level) {
    return LEVELS.indexOf(level) >= 0 ? level : DEFAULT_LEVEL;
  }

  // src/api.js
  var VERSION = "1.0.0";
  var DEFAULT_BASE_RELATIVE = "scripts/extensions/third-party/st-chatu8/compress";
  var INIT_TIMEOUT_MS = 12e4;
  var COMPRESS_TIMEOUT_MS = 3e5;
  var SELF_SCRIPT_SRC = (function() {
    try {
      if (typeof document !== "undefined" && document.currentScript && document.currentScript.src) return document.currentScript.src;
    } catch (_) {
    }
    return "";
  })();
  var state = {
    worker: null,
    readyPromise: null,
    seq: 0,
    pending: /* @__PURE__ */ new Map(),
    supported: { png: false, jpeg: false, webp: false },
    errors: {},
    broken: null,
    resolved: null
  };
  function toAbsoluteDir(raw) {
    const trimmed = String(raw || "").replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\/$/, "");
    let base;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(trimmed)) base = trimmed + "/";
    else if (trimmed.charAt(0) === "/") base = new URL(trimmed + "/", location.origin + "/").href;
    else base = new URL(trimmed + "/", typeof document !== "undefined" && document.baseURI || location.href).href;
    return base;
  }
  function resolveBase(options) {
    const opt = options || {};
    let raw = opt.base;
    let source = "options.base";
    if (!raw) {
      try {
        if (typeof window !== "undefined" && typeof window.stChatu8CompressBase === "string" && window.stChatu8CompressBase) {
          raw = window.stChatu8CompressBase;
          source = "window.stChatu8CompressBase";
        }
      } catch (_) {
      }
    }
    if (!raw && SELF_SCRIPT_SRC) {
      raw = new URL(".", SELF_SCRIPT_SRC).href;
      source = "document.currentScript";
    }
    if (!raw) {
      raw = DEFAULT_BASE_RELATIVE;
      source = "builtin-fallback";
    }
    const base = toAbsoluteDir(raw);
    return {
      source,
      raw,
      base,
      workerUrl: new URL("worker.js", base).href,
      wasmBase: new URL("wasm/", base).href
    };
  }
  function createWorker(workerUrl) {
    try {
      return { worker: new Worker(workerUrl), mode: "file" };
    } catch (e) {
      const src = "importScripts(" + JSON.stringify(workerUrl) + ");";
      const blobUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      return { worker: new Worker(blobUrl), mode: "blob", blobUrl, cause: String(e && e.message || e) };
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
      const message = event && (event.message || event.error && event.error.message) || "worker error";
      failAll("worker-error: " + message);
    };
    worker.onmessageerror = () => failAll("worker-error: message deserialization failed");
  }
  function failAll(message) {
    state.broken = message;
    for (const [id, entry] of state.pending) {
      clearTimeout(entry.timer);
      state.pending.delete(id);
      entry.reject(new Error(message));
    }
    if (state.worker) {
      try {
        state.worker.terminate();
      } catch (_) {
      }
    }
    state.worker = null;
    state.readyPromise = null;
    state.supported = { png: false, jpeg: false, webp: false };
  }
  function rpc(type, payload, transfer, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!state.worker) {
        reject(new Error("worker not available"));
        return;
      }
      const id = ++state.seq;
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(type + " timeout after " + timeoutMs + "ms"));
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
        const res = await rpc("init", { wasmBase: urls.wasmBase }, null, INIT_TIMEOUT_MS);
        if (res.type !== "ready") throw new Error("unexpected init reply: " + String(res.type));
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
          version: VERSION
        };
      } catch (e) {
        const message = String(e && e.message || e);
        if (state.worker) {
          try {
            state.worker.terminate();
          } catch (_) {
          }
        }
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
      if (!blob || typeof blob.arrayBuffer !== "function" || typeof blob.size !== "number") {
        return { ok: false, reason: "unsupported", message: "input is not a Blob/File" };
      }
      const level = normalizeLevel(opt.level);
      const allowFormatChange = opt.allowFormatChange === true;
      const formatChangeExplicitlyDisabled = Object.prototype.hasOwnProperty.call(opt, "allowFormatChange") && opt.allowFormatChange !== true;
      const before = blob.size;
      if (before === 0) return { ok: false, reason: "unsupported", message: "empty input" };
      const buffer = await blob.arrayBuffer();
      const format = sniffFormat(new Uint8Array(buffer));
      if (SUPPORTED_FORMATS.indexOf(format) < 0) return { ok: false, reason: "unsupported", message: "format=" + format };
      if (isAnimated(new Uint8Array(buffer), format)) return { ok: false, reason: "unsupported", message: "animated " + format };
      const ready = await load();
      if (!state.worker || !supported()[format]) {
        return { ok: false, reason: "codec-unavailable", message: state.errors && (state.errors[format] || state.errors.init) || format + " codec unavailable" };
      }
      const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
      const res = await rpc("compress", { bytes: buffer, level, allowFormatChange, mime: MIME_BY_FORMAT[format] }, [buffer], COMPRESS_TIMEOUT_MS);
      const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
      const outFormat = res && res.outputFormat || format;
      const outMime = MIME_BY_FORMAT[outFormat] || MIME_BY_FORMAT[format];
      const observation = {
        outputFormat: outFormat,
        hasAlpha: res && res.hasAlpha !== void 0 ? res.hasAlpha : null,
        pngBytes: res && res.pngBytes !== void 0 ? res.pngBytes : null,
        jpegBytes: res && res.jpegBytes !== void 0 ? res.jpegBytes : null
      };
      if (!res || res.ok !== true) {
        const reason = res && res.reason || "worker-error";
        const failure = Object.assign({
          ok: false,
          reason,
          message: res && res.message,
          before,
          after: res && res.after,
          codec: res && res.codec,
          mime: outMime
        }, observation);
        if (reason === "not-smaller" && res && format === "png" && level !== "lossless" && res.hasAlpha === false && !allowFormatChange) {
          failure.formatChangeSuggested = true;
          failure.alternative = "jpeg";
          failure.hint = "pass { allowFormatChange: true } to try PNG→JPEG (MozJPEG)";
          if (formatChangeExplicitlyDisabled) {
            failure.notSmallerReason = "not-smaller";
            failure.reason = "format-change-disabled";
          }
        }
        return failure;
      }
      const outBytes = new Uint8Array(res.buffer);
      const after = outBytes.byteLength;
      if (after >= before) {
        return Object.assign({ ok: false, reason: "not-smaller", before, after, codec: res.codec, mime: outMime }, observation);
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
        formatChanged: outFormat !== format
      }, observation);
    } catch (e) {
      return { ok: false, reason: "worker-error", message: String(e && e.message || e) };
    }
  }
  function terminate() {
    for (const [id, entry] of state.pending) {
      clearTimeout(entry.timer);
      state.pending.delete(id);
      entry.reject(new Error("worker terminated"));
    }
    if (state.worker) {
      try {
        state.worker.terminate();
      } catch (_) {
      }
    }
    state.worker = null;
    state.readyPromise = null;
    state.supported = { png: false, jpeg: false, webp: false };
    state.errors = {};
    return true;
  }
  var api = {
    version: VERSION,
    load,
    supported,
    compress,
    terminate,
    levels: LEVELS.slice(),
    defaultLevel: DEFAULT_LEVEL,
    codecIds: Object.assign({}, CODEC_ID),
    pngToJpegLevels: JSON.parse(JSON.stringify(PNG_TO_JPEG_LEVELS)),
    reasons: ["unsupported", "not-smaller", "format-change-disabled", "codec-unavailable", "worker-error"],
    resolveBase: () => state.resolved ? Object.assign({}, state.resolved) : resolveBase(),
    get state() {
      return {
        loaded: !!state.worker,
        ready: !!state.readyPromise,
        supported: supported(),
        errors: Object.assign({}, state.errors),
        broken: state.broken
      };
    }
  };
  if (typeof window !== "undefined") window.stChatu8Compress = api;
  else if (typeof globalThis !== "undefined") globalThis.stChatu8Compress = api;
  var api_default = api;
})();
