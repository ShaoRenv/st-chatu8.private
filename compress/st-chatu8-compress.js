/*! st-chatu8-compress v1.2.0 | WASM 图像压缩模块（PNG/JPEG/WebP）
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
  function pngDimensions(u8) {
    if (u8.length < 24) return null;
    if (u8[12] !== 73 || u8[13] !== 72 || u8[14] !== 68 || u8[15] !== 82) return null;
    const w = (u8[16] << 24 | u8[17] << 16 | u8[18] << 8 | u8[19]) >>> 0;
    const h = (u8[20] << 24 | u8[21] << 16 | u8[22] << 8 | u8[23]) >>> 0;
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  function jpegDimensions(u8) {
    let off = 2;
    while (off + 3 < u8.length) {
      if (u8[off] !== 255) {
        off++;
        continue;
      }
      const marker = u8[off + 1];
      if (marker === 255) {
        off++;
        continue;
      }
      if (marker === 0) {
        off += 2;
        continue;
      }
      off += 2;
      if (marker === 1 || marker >= 208 && marker <= 217) continue;
      if (off + 2 > u8.length) return null;
      const len = (u8[off] << 8 | u8[off + 1]) >>> 0;
      if (len < 2) return null;
      const isSof = marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204;
      if (isSof) {
        if (off + 7 > u8.length) return null;
        const h = (u8[off + 3] << 8 | u8[off + 4]) >>> 0;
        const w = (u8[off + 5] << 8 | u8[off + 6]) >>> 0;
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      if (marker === 218) return null;
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
      if (c0 === 86 && c1 === 80 && c2 === 56 && c3 === 88 && p + 10 <= u8.length) {
        const w = (u8[p + 4] | u8[p + 5] << 8 | u8[p + 6] << 16) + 1;
        const h = (u8[p + 7] | u8[p + 8] << 8 | u8[p + 9] << 16) + 1;
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      if (c0 === 86 && c1 === 80 && c2 === 56 && c3 === 76 && p + 5 <= u8.length) {
        if (u8[p] !== 47) return null;
        const b0 = u8[p + 1], b1 = u8[p + 2], b2 = u8[p + 3], b3 = u8[p + 4];
        const w = 1 + ((b1 & 63) << 8 | b0);
        const h = 1 + ((b3 & 15) << 10 | b2 << 2 | (b1 & 192) >> 6);
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      if (c0 === 86 && c1 === 80 && c2 === 56 && c3 === 32 && p + 10 <= u8.length) {
        if (!(u8[p + 3] === 157 && u8[p + 4] === 1 && u8[p + 5] === 42)) return null;
        const w = (u8[p + 6] | u8[p + 7] << 8) & 16383;
        const h = (u8[p + 8] | u8[p + 9] << 8) & 16383;
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      off = p + size + size % 2;
    }
    return null;
  }
  function imageDimensions(bytes, format) {
    const u8 = toU8(bytes);
    const fmt = format || sniffFormat(u8);
    try {
      if (fmt === "png") return pngDimensions(u8);
      if (fmt === "jpeg") return jpegDimensions(u8);
      if (fmt === "webp") return webpDimensions(u8);
    } catch (_) {
    }
    return null;
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
  var VERSION = "1.2.0";
  var DEFAULT_BASE_RELATIVE = "scripts/extensions/third-party/st-chatu8/compress";
  var INIT_TIMEOUT_MS = 12e4;
  var COMPRESS_TIMEOUT_MS = 3e5;
  var MAX_POOL = 4;
  var BYTES_PER_PIXEL_COST = 8;
  var UNKNOWN_DIMS_COST_FACTOR = 6;
  var BUDGET_MOBILE = 96 * 1024 * 1024;
  var BUDGET_DESKTOP = 256 * 1024 * 1024;
  var SELF_SCRIPT_SRC = (function() {
    try {
      if (typeof document !== "undefined" && document.currentScript && document.currentScript.src) return document.currentScript.src;
    } catch (_) {
    }
    return "";
  })();
  var state = {
    slots: [],
    // { worker, mode, blobUrl, ready, supported, errors, busy }
    queue: [],
    // 已提交、等待准入的任务
    readyPromise: null,
    seq: 0,
    pending: /* @__PURE__ */ new Map(),
    // id → { resolve, reject, timer, slot }
    running: 0,
    inflightBytes: 0,
    supported: { png: false, jpeg: false, webp: false },
    errors: {},
    broken: null,
    degraded: 0,
    resolved: null,
    maxConcurrent: 0,
    // 0 = 用池容量；>0 = 本次批量显式指定的并发上限
    epoch: 0
    // 每次 failAll 自增；用于丢弃"已被清零"的旧任务的计数回退
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
  function isMobileEnvironment() {
    try {
      if (typeof navigator === "undefined") return false;
      const uaData = navigator.userAgentData;
      if (uaData && typeof uaData.mobile === "boolean") return uaData.mobile;
      const ua = String(navigator.userAgent || "");
      return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Windows Phone/i.test(ua);
    } catch (_) {
      return false;
    }
  }
  function computeBaseSlots() {
    let hc = 4;
    try {
      if (typeof navigator !== "undefined" && navigator.hardwareConcurrency) hc = navigator.hardwareConcurrency;
    } catch (_) {
    }
    let slots = Math.max(1, Math.min(hc - 1, MAX_POOL));
    if (isMobileEnvironment()) slots = Math.min(slots, 2);
    return Math.max(1, slots);
  }
  function budgetBytes() {
    return isMobileEnvironment() ? BUDGET_MOBILE : BUDGET_DESKTOP;
  }
  function estimateCost(dims, inputBytes) {
    if (dims && dims.width > 0 && dims.height > 0) {
      return BYTES_PER_PIXEL_COST * dims.width * dims.height + inputBytes;
    }
    return Math.max(inputBytes, 1) * UNKNOWN_DIMS_COST_FACTOR;
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
  function rpc(slot, type, payload, transfer, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!slot || !slot.worker) {
        reject(new Error("worker not available"));
        return;
      }
      const id = ++state.seq;
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(type + " timeout after " + timeoutMs + "ms"));
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
      const message = event && (event.message || event.error && event.error.message) || "worker error";
      failSlot(slot, "worker-error: " + message);
    };
    slot.worker.onmessageerror = () => failSlot(slot, "worker-error: message deserialization failed");
  }
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
    try {
      if (slot.worker) slot.worker.terminate();
    } catch (_) {
    }
    if (slot.blobUrl) {
      try {
        URL.revokeObjectURL(slot.blobUrl);
      } catch (_) {
      }
    }
    if (state.slots.length === 0) {
      state.broken = message;
      state.supported = { png: false, jpeg: false, webp: false };
      state.readyPromise = null;
    }
    pump();
  }
  var ensureChain = Promise.resolve();
  function ensureWorkers(n) {
    const target = Math.max(1, Math.min(Number(n) > 0 ? Math.floor(Number(n)) : 1, MAX_POOL));
    const run = () => ensureWorkersInner(target);
    const p = ensureChain.then(run, run);
    ensureChain = p.then(() => {
    }, () => {
    });
    return p;
  }
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
        busy: 0
      };
      attachSlot(slot);
      creations.push((async () => {
        try {
          const res = await rpc(slot, "init", { wasmBase: urls.wasmBase }, null, INIT_TIMEOUT_MS);
          if (res.type !== "ready") throw new Error("unexpected init reply: " + String(res.type));
          slot.supported = Object.assign({ png: false, jpeg: false, webp: false }, res.supported || {});
          slot.errors = res.errors || {};
          slot.ready = true;
          state.slots.push(slot);
        } catch (e) {
          slot.errors = { init: String(e && e.message || e) };
          state.degraded++;
          try {
            slot.worker.terminate();
          } catch (_) {
          }
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
              reject(new Error("worker not available"));
            }
            pump();
            return;
          }
          slot.busy++;
          const done = (ok, val) => {
            if (settled) return;
            settled = true;
            slot.busy--;
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
        }
      };
      state.queue.push(entry);
      pump();
    });
  }
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
            reason: errs.init || "no usable worker",
            base: urls.base,
            baseSource: urls.source,
            workerUrl: urls.workerUrl,
            wasmBase: urls.wasmBase,
            version: VERSION
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
          workerMode: state.slots.length ? state.slots[0].mode : "file",
          version: VERSION
        };
      } catch (e) {
        const message = String(e && e.message || e);
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
      try {
        slot.worker.terminate();
      } catch (_) {
      }
      if (slot.blobUrl) {
        try {
          URL.revokeObjectURL(slot.blobUrl);
        } catch (_) {
        }
      }
    }
    state.slots = [];
    state.readyPromise = null;
    state.maxConcurrent = 0;
    state.supported = { png: false, jpeg: false, webp: false };
  }
  async function normalizeInput(input) {
    if (!input) return null;
    if (typeof input.arrayBuffer === "function" && typeof input.size === "number") {
      if (input.size === 0) return null;
      const ab = await input.arrayBuffer();
      return { buffer: ab, before: ab.byteLength };
    }
    if (typeof ArrayBuffer !== "undefined" && input instanceof ArrayBuffer) {
      if (input.byteLength === 0) return null;
      return { buffer: input, before: input.byteLength };
    }
    if (input && input.buffer instanceof ArrayBuffer && typeof input.byteLength === "number") {
      if (input.byteLength === 0) return null;
      if (input.byteOffset === 0 && input.byteLength === input.buffer.byteLength) {
        return { buffer: input.buffer, before: input.byteLength };
      }
      const copy = new Uint8Array(input.byteLength);
      copy.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
      return { buffer: copy.buffer, before: copy.byteLength };
    }
    return void 0;
  }
  function defineLazyBlob(obj, bytes, mime) {
    Object.defineProperty(obj, "blob", {
      enumerable: true,
      configurable: true,
      get() {
        const b = new Blob([bytes], { type: mime });
        Object.defineProperty(obj, "blob", { value: b, enumerable: true, configurable: true, writable: false });
        return b;
      }
    });
  }
  async function compress(input, options) {
    const opt = options || {};
    try {
      const normalized = await normalizeInput(input);
      if (normalized === null) return { ok: false, reason: "unsupported", message: "empty input" };
      if (normalized === void 0) return { ok: false, reason: "unsupported", message: "input is not a Blob/ArrayBuffer/Uint8Array" };
      const buffer = normalized.buffer;
      const before = normalized.before;
      const bytes = new Uint8Array(buffer);
      const level = normalizeLevel(opt.level);
      const allowFormatChange = opt.allowFormatChange === true;
      const fast = opt.fast === true;
      const flattenAlpha = opt.flattenAlpha === true;
      const verify = opt.verify === void 0 ? true : opt.verify;
      const format = sniffFormat(bytes);
      if (SUPPORTED_FORMATS.indexOf(format) < 0) return { ok: false, reason: "unsupported", message: "format=" + format };
      if (isAnimated(bytes, format)) return { ok: false, reason: "unsupported", message: "animated " + format };
      const dims = imageDimensions(bytes, format);
      const wantSlots = Number(opt.concurrency) > 0 ? Number(opt.concurrency) : computeBaseSlots();
      state.maxConcurrent = Number(opt.concurrency) > 0 ? Math.min(Math.floor(Number(opt.concurrency)), MAX_POOL) : 0;
      const poolSize = await ensureWorkers(wantSlots);
      if (poolSize === 0) {
        return {
          ok: false,
          reason: "codec-unavailable",
          message: state.broken || state.errors && (state.errors[format] || state.errors.init) || format + " codec unavailable"
        };
      }
      if (!anySlotSupports(format)) {
        return {
          ok: false,
          reason: "codec-unavailable",
          message: state.errors && (state.errors[format] || state.errors.init) || format + " codec unavailable"
        };
      }
      const cost = estimateCost(dims, before);
      const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
      const res = await enqueue(cost, format, (slot) => rpc(slot, "compress", {
        bytes: buffer,
        level,
        allowFormatChange,
        fast,
        flattenAlpha,
        verify,
        mime: MIME_BY_FORMAT[format]
      }, null, COMPRESS_TIMEOUT_MS));
      const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
      const outFormat = res && res.outputFormat || format;
      const outMime = MIME_BY_FORMAT[outFormat] || MIME_BY_FORMAT[format];
      const observation = {
        outputFormat: outFormat,
        hasAlpha: res && res.hasAlpha !== void 0 ? res.hasAlpha : null,
        pngBytes: res && res.pngBytes !== void 0 ? res.pngBytes : null,
        jpegBytes: res && res.jpegBytes !== void 0 ? res.jpegBytes : null,
        skippedPngOptimise: !!(res && res.skippedPngOptimise),
        flattened: !!(res && res.flattened),
        decodeFailed: !!(res && res.decodeFailed),
        fastMode: !!(res && res.fastMode) || fast,
        verified: !!(res && res.verified),
        poolSize: state.maxConcurrent > 0 ? Math.min(poolSize, state.maxConcurrent) : poolSize,
        dims: dims || null
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
          const formatChangeExplicitlyDisabled = Object.prototype.hasOwnProperty.call(opt, "allowFormatChange") && opt.allowFormatChange !== true;
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
        bytes: outBytes
      }, observation);
      defineLazyBlob(result, outBytes, outMime);
      return result;
    } catch (e) {
      return { ok: false, reason: "worker-error", message: String(e && e.message || e) };
    }
  }
  function terminate() {
    failAll("worker terminated");
    state.errors = {};
    state.degraded = 0;
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
    reasons: ["unsupported", "not-smaller", "format-change-disabled", "codec-unavailable", "worker-error", "verify-failed", "fast-mode-skip"],
    resolveBase: () => state.resolved ? Object.assign({}, state.resolved) : resolveBase(),
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
        pool: { size: ready, created: state.slots.length, degraded: state.degraded, running: state.running, queued: state.queue.length, inflightBytes: state.inflightBytes }
      };
    }
  };
  if (typeof window !== "undefined") window.stChatu8Compress = api;
  else if (typeof globalThis !== "undefined") globalThis.stChatu8Compress = api;
  var api_default = api;
})();
