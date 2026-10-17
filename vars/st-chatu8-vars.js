/* st-chatu8 变量系统 v1 —— 由 tools/build-vars.mjs 生成，不要直接改这个文件 */
(function () {
  "use strict";
  if (window.stChatu8Vars) return;


/* ---- resolve.js ---- */
// st-chatu8 tag 存储：引用求值（纯函数，无依赖；注入 index.js 时删掉 export 关键字）
// 投影只展开当前层：字符串=tag，数组=tag列表，对象=分组（不自动进图）
// 只有 $...$ 里的路径才是引用（路径指针）；不带 $ 的字符串永远是字面 tag
// 对象可以带一个保留键 key：值写关键词，多个用逗号隔开；命中才展开，没 key 常开

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function splitPath(ref) {
  return String(ref).split(/[./]/).map((s) => s.trim()).filter((s) => s.length > 0);
}

function segsToString(segs) { return "/" + segs.join("/"); }

function readSegs(root, segs) {
  let node = root;
  for (const s of segs) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, s)) return undefined;
    node = node[s];
  }
  return node;
}

// 引用查找顺序（路径指针）：
//   1. 相对当前节点的路径   $服装列表.白色睡衣$ / $人物状态$
//   2. 从根开始的路径       $爱莉希雅.人物状态$ / $爱莉希雅$
//   3. 根下 角色/角色列表/人物/人物列表 的同名键
//   以 / 开头 = 强制从根算  $/爱莉希雅.形象$
function readPath(root, baseSegs, ref) {
  const raw = String(ref).trim();
  const segs = splitPath(raw);
  if (!segs.length) return { value: undefined, segs: [] };
  const tries = [];
  if (raw.charAt(0) === "/") {
    tries.push(segs);
  } else {
    if (baseSegs.length) tries.push(baseSegs.concat(segs));
    tries.push(segs);
    // 顶层若带「角色列表」这类包装层，两种都能命中
    for (const a of ["角色", "角色列表", "人物", "人物列表"]) tries.push([a].concat(segs));
  }
  for (const t of tries) {
    const v = readSegs(root, t);
    if (v !== undefined) return { value: v, segs: t };
  }
  return { value: undefined, segs: segs };
}

const REF_RE = /\$([^$]+)\$/g;

// 按逗号分段，但跳过 $...$ 内部（${"name":"x","angle":"y"}$ 里的逗号不算分段）
// 半角 , ; 与全角 ，；都算分段符（模型常写全角）
function isSegSep(ch) { return ch === "," || ch === ";" || ch === "，" || ch === "；"; }

// 减号的各种写法：半角 - 、全角 － 、数学减号 − 、不换行连字符 ‑ 、小连字符 ﹣
const MINUS_CHARS = "-\uFF0D\u2212\u2011\uFE63";
function isMinusChar(ch) { return ch.length === 1 && MINUS_CHARS.indexOf(ch) >= 0; }
// 项以减号开头 = 减一项；返回 { minus, body }
function splitMinus(s) {
  const str = String(s);
  if (!str.length) return { minus: false, body: str };
  return isMinusChar(str.charAt(0)) ? { minus: true, body: str.slice(1).trim() } : { minus: false, body: str };
}

// {A,B} 是并列候选；{{tag}} 是 tag 自带的强调括号（如 {{blue pupils}}），不是候选。
// 判定按「组」来：某一层里带顶层逗号才算并列候选，所以同一个 $...$ 里两种都能混着写。
function findAlternativesBrace(s) {
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    if (str.charAt(i) !== "{") continue;
    let depth = 0;
    let close = -1;
    for (let j = i; j < str.length; j++) {
      const ch = str.charAt(j);
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close < 0) continue; // 没闭合：当字面
    // {{tag}} = tag 自带的强调括号（如 {{blue pupils}}）：整组跳过，别把内层 { 当候选
    if (str.charAt(i + 1) === "{" && str.charAt(close - 1) === "}") { i = close; continue; }
    return i;
  }
  return -1;
}
function hasBraceAlternatives(s) { return findAlternativesBrace(s) >= 0; }

// 花括号体的切分：只在花括号自己这一层切，嵌套的逗号不算
function splitBraceBody(body) {
  const out = [];
  let buf = "";
  let depth = 0;
  const str = String(body);
  for (let i = 0; i < str.length; i++) {
    const ch = str.charAt(i);
    if (ch === "{") { depth++; buf += ch; continue; }
    if (ch === "}") { depth = Math.max(0, depth - 1); buf += ch; continue; }
    if (depth === 0 && (ch === "," || ch === "，")) { out.push(buf); buf = ""; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function splitSegments(text) {
  const out = [];
  let buf = "";
  let inRef = false;
  const str = String(text);
  for (let i = 0; i < str.length; i++) {
    const ch = str.charAt(i);
    if (ch === "$") { inRef = !inRef; buf += ch; continue; }
    if (!inRef && isSegSep(ch)) { out.push(buf); buf = ""; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function makeCtx(triggerText) {
  return { text: triggerText == null ? "" : String(triggerText), gate: triggerText != null, depth: 0, seen: {} };
}

function down(ctx, seen) {
  return { text: ctx.text, gate: ctx.gate, depth: (ctx.depth || 0) + 1, seen: seen || ctx.seen || {} };
}

// key 触发：没 key 常开；有 key 要求关键词出现在触发文本里（逗号分隔，大小写不敏感）
function isTriggered(triggerText, keyValue) {
  if (typeof keyValue !== "string" || !keyValue.trim()) return true;
  const keys = keyValue.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (!keys.length) return true;
  const hay = String(triggerText == null ? "" : triggerText).toLowerCase();
  if (!hay) return false;
  for (const k of keys) { if (hay.indexOf(k.toLowerCase()) >= 0) return true; }
  return false;
}

// 激活关键词字段：主名用「激活词」，兼容旧的 key
const GATE_FIELDS = ["激活词", "key"];
const RESERVED = { "激活词": 1, key: 1, "不遍历": 1 };

function readGate(node) {
  if (!isPlainObject(node)) return undefined;
  for (const f of GATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(node, f)) return node[f];
  }
  return undefined;
}


// ===== 批量调用（通配符）=====
//   *   这一层的每个键（一级）      $角色列表/*/人物状态$   $沈慕微/服装列表/*$
//   **  这一层往下所有层级的字段    $角色列表/**$           $沈慕微/**$
//   前缀/后缀写法也支持            $沈慕微/人物*$（= 人物形象 + 人物状态）
// 通配不会带出 _ 备注、激活词/key、不遍历 标记；一个都没命中=原样保留
// 批量调用不看激活词（有多少拉多少）；不想被批量拉走的块写上 "不遍历": true
function skipMetaKey(k) { return k.charAt(0) === "_" || RESERVED[k] === 1; }
function isNoTraverse(node) {
  if (!isPlainObject(node)) return false;
  const v = node["不遍历"];
  if (v === undefined || v === null) return false;
  if (v === false || v === 0 || v === "") return false;
  const s = String(v).trim().toLowerCase();
  return s !== "false" && s !== "0" && s !== "no";
}
function isGlobSeg(seg) { return seg === "**" || seg.indexOf("*") >= 0; }
function globRe(pattern) {
  const esc = String(pattern).split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + esc + "$");
}
// 自身 + 所有后代（只下探容器），跳过 _ / 保留键 / 不遍历 的块
function collectDesc(node, segs, out, ctx) {
  if (isNoTraverse(node)) return;
  out.push({ node: node, segs: segs });
  if (!isPlainObject(node)) return;
  for (const k of Object.keys(node)) {
    if (skipMetaKey(k)) continue;
    collectDesc(node[k], segs.concat(k), out, ctx);
  }
}
// 所有叶子值（字符串 / 数组元素），不重复、不做对象投影
function collectLeaves(node, segs, out, ctx) {
  if (isNoTraverse(node)) return;
  if (typeof node === "string") { out.push({ value: node, base: segs.slice(0, -1) }); return; }
  if (Array.isArray(node)) {
    for (const item of node) {
      if (typeof item === "string") out.push({ value: item, base: segs });
      else if (Array.isArray(item)) collectLeaves(item, segs, out, ctx);
    }
    return;
  }
  if (!isPlainObject(node)) return;
  for (const k of Object.keys(node)) {
    if (skipMetaKey(k)) continue;
    collectLeaves(node[k], segs.concat(k), out, ctx);
  }
}
// 按通配路径从根匹配：命中返回展开后的 tag 文本（可能是空串），一个都没命中返回 null
function globHit(root, patternSegs, ctx) {
  // 批量调用不看激活词：投影时显式关掉门控
  const gc = { text: (ctx && ctx.text) || "", gate: false, depth: (ctx && ctx.depth) || 0, seen: (ctx && ctx.seen) || {} };
  let cands = [{ node: root, segs: [] }];
  for (let i = 0; i < patternSegs.length; i++) {
    const seg = patternSegs[i];
    const next = [];
    for (const c of cands) {
      if (seg === "**") { collectDesc(c.node, c.segs, next, ctx); continue; }
      if (!isPlainObject(c.node)) continue;
      if (seg.indexOf("*") >= 0) {
        const re = globRe(seg);
        for (const k of Object.keys(c.node)) {
          if (skipMetaKey(k) || !re.test(k)) continue;
          const child = c.node[k];
          if (isPlainObject(child) && isNoTraverse(child)) continue; // 不遍历
          next.push({ node: child, segs: c.segs.concat(k) });
        }
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(c.node, seg)) continue;
      {
        const child = c.node[seg];
        if (isPlainObject(child) && isNoTraverse(child)) continue; // 不遍历
        next.push({ node: child, segs: c.segs.concat(seg) });
      }
    }
    cands = next;
    if (!cands.length) return null;
  }
  const last = patternSegs[patternSegs.length - 1];
  const out = [];
  for (const c of cands) {
    if (last === "**") {
      const leaves = [];
      collectLeaves(c.node, c.segs, leaves, ctx);
      for (const L of leaves) {
        const txt = project(root, L.base, L.value, gc);
        if (txt) out.push(txt);
      }
      continue;
    }
    const base = (typeof c.node === "string" && c.segs.length) ? c.segs.slice(0, -1) : c.segs;
    const txt = project(root, base, c.node, gc);
    if (txt) out.push(txt);
  }
  // 批量调用自动去重（同一 tag 只留一次）
  const uniq = [];
  const seenTag = {};
  for (const s of out) {
    for (const piece of String(s).split(",").map((x) => x.trim()).filter(Boolean)) {
      const k = piece.toLowerCase();
      if (seenTag[k]) continue;
      seenTag[k] = 1;
      uniq.push(piece);
    }
  }
  return uniq.join(", ");
}
// 通配引用：不含通配返回 null；沿 readPath 的同一套尝试顺序找，命中返回 tag 文本
function expandGlobRef(root, baseSegs, ref, ctx, bases) {
  const raw = String(ref).trim();
  const segs = splitPath(raw);
  if (!segs.length || !segs.some(isGlobSeg)) return null;
  const tries = [];
  if (raw.charAt(0) === "/") tries.push(segs);
  else {
    if (bases && bases.length) {
      for (const b of bases) {
        for (const w of ["", "角色", "角色列表", "人物", "人物列表"]) tries.push((w ? [w] : []).concat(b).concat(segs));
      }
    }
    if (baseSegs && baseSegs.length) tries.push(baseSegs.concat(segs));
    tries.push(segs);
    for (const a of ["角色", "角色列表", "人物", "人物列表"]) tries.push([a].concat(segs));
  }
  const seen = {};
  for (const t of tries) {
    const key = segsToString(t);
    if (seen[key]) continue;
    seen[key] = 1;
    const txt = globHit(root, t, ctx);
    if (txt !== null) return txt;
  }
  return null;
}

// 投影：只展开这一层（字符串/数组）；下一层的对象是分组，不进去
function project(root, baseSegs, value, ctx) {
  const c = ctx || makeCtx("");
  if ((c.depth || 0) > 8) return "";
  if (typeof value === "string") return evalText(root, baseSegs, value, c);
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      let s = "";
      if (typeof item === "string") s = evalText(root, baseSegs, item, down(c));
      else if (Array.isArray(item)) s = project(root, baseSegs, item, down(c));
      if (s) parts.push(s);
    }
    return parts.join(", ");
  }
  if (isPlainObject(value)) {
    if (c.gate !== false && !isTriggered(c.text, readGate(value))) return "";
    const parts = [];
    for (const k of Object.keys(value)) {
      if (k.charAt(0) === "_" || RESERVED[k]) continue;
      const child = value[k];
      let s = "";
      if (typeof child === "string") s = evalText(root, baseSegs, child, down(c));
      else if (Array.isArray(child)) s = project(root, baseSegs, child, down(c));
      if (s) parts.push(s);
    }
    return parts.join(", ");
  }
  return "";
}

const GROUP_SEP = /[;,，；]/;

// 把 $...$ 里的内容按 ; 或 , 切开（花括号里的逗号不算分隔）
function splitGroupItems(text) {
  const out = [];
  let buf = "";
  let depth = 0;
  const str = String(text);
  for (let i = 0; i < str.length; i++) {
    const ch = str.charAt(i);
    if (ch === "{") { depth++; buf += ch; continue; }
    if (ch === "}") { depth = Math.max(0, depth - 1); buf += ch; continue; }
    if (GROUP_SEP.test(ch) && depth === 0) { out.push(buf); buf = ""; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

// 花括号并列：$A/{x,y}$ -> ["A/x","A/y"]（可嵌套，最多 cap 项）
function braceExpandItems(text, cap) {
  const str = String(text);
  const open = findAlternativesBrace(str);
  if (open < 0) return [str];
  let depth = 0;
  let close = -1;
  for (let i = open; i < str.length; i++) {
    const ch = str.charAt(i);
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return [str];
  const head = str.slice(0, open);
  const body = str.slice(open + 1, close);
  const tail = str.slice(close + 1);
  const out = [];
  for (const opt of splitBraceBody(body)) {
    const raw = opt.trim();
    const neg = raw.length > 0 && isMinusChar(raw.charAt(0));
    const core = neg ? raw.slice(1) : raw;
    for (const rest of braceExpandItems(tail, cap)) {
      // 减号提到整项最前：$A/{状态,-服装列表/长袍}$ 才能被当成「减一项」而不是取用项
      out.push((neg ? "-" : "") + head + core + rest);
      if (out.length >= (cap || 32)) return out;
    }
  }
  return out;
}

// 保险：展开后若减号被挤到路径中间（角色列表/沈慕微/-服装列表/长袍），提回最前
function hoistMinus(s) {
  const str = String(s);
  if (str.indexOf("/-") < 0) return str;
  return "-" + str.split("/-").join("/");
}

// 组内查找：先按「续写基址」逐级往上找（基址 + 路径、基址 + 包装层 + 路径）
// 全部落空再回到单路径的原规则（含 / 绝对、包装层、原样保留）
function readPathInGroup(root, bases, ref, outerBase, ctx) {
  const raw = String(ref).trim();
  const segs = splitPath(raw);
  if (!segs.length) return { value: undefined, segs: [] };
  const globbed = expandGlobRef(root, outerBase || [], raw, ctx, bases);
  if (globbed !== null) return { value: globbed, segs: [] };
  if (raw.charAt(0) !== "/") {
    const wrappers = ["", "角色", "角色列表", "人物", "人物列表"];
    for (const b of bases) {
      for (const w of wrappers) {
        const t = (w ? [w] : []).concat(b).concat(segs);
        const v = readSegs(root, t);
        if (v !== undefined) return { value: v, segs: t };
      }
    }
  }
  const direct = readPath(root, [], raw);
  if (direct.value !== undefined) return direct;
  return readPath(root, outerBase || [], raw);
}

// 多重调用：$路径1;路径2;-路径3$ —— 组基 = 第一个「取用项」的父路径
//   - 非 - 项：取出来拼在一起；- 项：把它产出的 tag 从本组结果里减掉（认不出路径就当字面 tag 减）
//   查不到的取用项原样保留；整组都没命中就返回 null（交回老的单路径逻辑）
// 续写梯子：第一个取用项的各级父路径（就近优先）→ 第一项自己（第一项是分组时，第 2 项写在它下面）→ 外层 baseSegs
function groupLadder(segs, outer) {
  const base = Array.isArray(segs) ? segs : [];
  const out = [];
  for (let n = base.length - 1; n >= 0; n--) out.push(base.slice(0, n));
  if (base.length) out.push(base.slice());
  if (outer && outer.length) out.push(outer.slice());
  return out;
}

// 像「路径」的项（含 / . *）：查不到就是写错了，别把中文路径原文塞进图
function isPathLike(body) { return /[\/.*]/.test(String(body)); }

function expandRefGroup(root, baseSegs, inner, ctx) {
  const hasBrace = hasBraceAlternatives(inner);
  const raw = splitGroupItems(inner);
  if (raw.length < 2 && !hasBrace) return null;
  const items = [];
  for (const it of raw) {
    const m = splitMinus(it);
    for (const o of braceExpandItems(m.body, 32)) items.push(hoistMinus((m.minus ? "-" : "") + o));
    if (items.length > 32) break;
  }
  const list = items.filter((s) => s.length > 0 && s !== "-");
  if (!list.length) return null;
  const firstTake = list.find((i) => i.charAt(0) !== "-") || list[0];
  // 第 1 项解析出来之后，梯子换成它的「真实路径」（含它自己），后面的项就能相对它写
  let ladder = groupLadder(splitPath(firstTake), baseSegs);
  let firstDone = false;
  const takes = []; // 已经取到的片段（按书写顺序）
  let anyHit = false;
  for (const it of list) {
    const mi = splitMinus(it);
    const minus = mi.minus;
    const body = mi.body;
    if (!body) continue;
    if (body.indexOf("$") >= 0) { if (!minus) takes.push(body); continue; }
    const hit = readPathInGroup(root, ladder, body, baseSegs, ctx);
    if (!firstDone && it === firstTake) {
      firstDone = true;
      if (hit.value !== undefined && hit.segs && hit.segs.length) ladder = groupLadder(hit.segs, baseSegs);
    }
    if (hit.value === undefined) {
      // 减项：认不出路径就当字面 tag 减（只减它前面已经取到的）
      if (minus) pruneTakes(takes, [body.toLowerCase()]);
      else if (!isPathLike(body)) takes.push(body); // 字面 tag 留着；写错的路径丢掉
      continue;
    }
    anyHit = true;
    const hitBase = (typeof hit.value === "string" && hit.segs.length) ? hit.segs.slice(0, -1) : hit.segs;
    // 下探一层 + 记住这条路径：值里再引用回自己（或互相引用）时能收住，不会递归爆栈
    const pc = down(ctx);
    if (hit.segs && hit.segs.length) {
      const seen2 = Object.assign({}, pc.seen || {});
      seen2[segsToString(hit.segs)] = true;
      pc.seen = seen2;
    }
    const txt = project(root, hitBase, hit.value, pc);
    if (minus) {
      // 左到右：减项只作用于它前面取到的内容，所以「先减旧的、再加新的」加得回来
      pruneTakes(takes, String(txt).split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.toLowerCase()));
    } else if (txt) takes.push(txt);
  }
  if (!anyHit) return null;
  return takes.join(", ");
}

// 把 takes 里命中 removals（小写比较）的 tag 去掉
function pruneTakes(takes, removals) {
  if (!removals || !removals.length || !takes.length) return;
  for (let i = 0; i < takes.length; i++) {
    takes[i] = String(takes[i]).split(",").map((x) => x.trim()).filter((x) => x && removals.indexOf(x.toLowerCase()) < 0).join(", ");
  }
}

// 展开一段文本里的 $...$（路径形态取存储，JSON 形态留给预设管线）
function expandRefs(root, baseSegs, text, ctx) {
  const c = ctx;
  return String(text).replace(REF_RE, (match, inner) => {
    const t = String(inner).trim();
    if (!t) return match;
    if (t.charAt(0) === "{") return match;
    const grouped = expandRefGroup(root, baseSegs, t, c);
    if (grouped !== null) return grouped;
    const globbed = expandGlobRef(root, baseSegs, t, c);
    if (globbed !== null) return globbed;
    const hit = readPath(root, baseSegs, t);
    if (hit.value === undefined) {
      // 查不到就原样保留：不认识的 $...$ 交给原有管线（与扩展原本的行为一致），绝不误删
      return match;
    }
    const key = segsToString(hit.segs);
    if (c.seen && c.seen[key]) return "";
    const nextSeen = Object.assign({}, c.seen || {});
    nextSeen[key] = true;
    const hitBase = (typeof hit.value === "string" && hit.segs.length) ? hit.segs.slice(0, -1) : hit.segs;
    return project(root, hitBase, hit.value, down(c, nextSeen));
  });
}


// 写入时判断：这个 $...$ 要不要原样存进变量（true = 变量指针，别交给预设/官方调用展开器）
//   $路径$        → 指针，原样存
//   ${...}$       → 预设调用，展开
//   短引用：能在库里找到就是变量；找不到才当官方调用（$xiao hong-from front$）展开
function isVarPointer(root, span) {
  const s = String(span == null ? "" : span).trim();
  if (s.length < 3 || s.charAt(0) !== "$" || s.charAt(s.length - 1) !== "$") return false;
  const inner = s.slice(1, -1).trim();
  if (!inner) return false;
  if (inner.charAt(0) === "{") return false; // ${...}$ 预设调用
  // 多重调用 / 花括号并列：整条都当变量指针（里面某一项查不到也不交给官方展开器去猜）
  if (/[,;，；]/.test(inner) || hasBraceAlternatives(inner)) return true;
  if (inner.indexOf("/") >= 0 || inner.indexOf("*") >= 0 || inner.indexOf(".") >= 0) return true;
  try { if (readPath(root || {}, [], inner).value !== undefined) return true; } catch (e) { }
  try { if (expandGlobRef(root || {}, [], inner, makeCtx("")) !== null) return true; } catch (e) { }
  return false;
}

// 求值一段值：
//   $路径$   取存储
//   -tag     从本段里【所有】引用的结果里减掉这个 tag（位置无关）
//   其它     字面 tag，原样保留
function evalText(root, baseSegs, text, ctx) {
  const c = ctx || makeCtx("");
  if ((c.depth || 0) > 8) return String(text);
  if (typeof text !== "string") return String(text);
  const parts = splitSegments(text);
  const removals = [];
  let hasRef = false;
  for (const p of parts) {
    const q = p.trim();
    if (!q) continue;
    if (isMinusChar(q.charAt(0)) && q.length > 1) {
      const body = q.slice(1).trim();
      if (body.indexOf("$") >= 0) {
        // -$引用$：把这个引用产出的所有 tag 都减掉
        const expanded = expandRefs(root, baseSegs, body, c);
        const pieces = expanded.split(",").map((x) => x.trim()).filter(Boolean);
        for (const piece of pieces) removals.push(piece.toLowerCase());
      } else {
        removals.push(body.toLowerCase());
      }
    }
    else if (q.indexOf("$") >= 0 && q.indexOf("${") < 0) hasRef = true;
  }
  if (!hasRef && !removals.length) return text;
  const out = [];
  for (const raw of parts) {
    const seg = raw.trim();
    if (!seg) continue;
    if (isMinusChar(seg.charAt(0)) && seg.length > 1) continue;
    const rawExp = expandRefs(root, baseSegs, seg, c);
    const isPreset = rawExp.indexOf("${") >= 0;
    const isVarRef = seg.indexOf("$") >= 0 && seg.indexOf("${") < 0;
    let val;
    if (isPreset) {
      val = rawExp.trim();
    } else if (!isVarRef) {
      val = seg;
    } else {
      let pieces = rawExp.split(",").map((x) => x.trim()).filter(Boolean);
      if (removals.length) pieces = pieces.filter((x) => removals.indexOf(x.toLowerCase()) < 0);
      val = pieces.join(", ");
    }
    if (val) out.push(val);
  }
  return out.filter(Boolean).join(", ");
}

// 结构无关的「激活」过滤：对象只要带 激活词/key，未命中就整块删掉；不认键名、不认层数
// 不传触发文本时不做过滤（原样返回）；数组里的元素同样过滤
function filterActive(node, triggerText, depth) {
  const d = depth || 0;
  if (d > 8) return node;
  if (triggerText == null || String(triggerText).trim() === "") return node;
  if (Array.isArray(node)) {
    const arr = [];
    for (const x of node) {
      const f = filterActive(x, triggerText, d + 1);
      if (f !== undefined) arr.push(f);
    }
    return arr;
  }
  if (!isPlainObject(node)) return node;
  if (!isTriggered(triggerText, readGate(node))) return undefined;
  const out = {};
  for (const k of Object.keys(node)) {
    const v = node[k];
    const f = (isPlainObject(v) || Array.isArray(v)) ? filterActive(v, triggerText, d + 1) : v;
    if (f === undefined) continue;
    if (isPlainObject(v) && isPlainObject(f) && Object.keys(v).length > 0 && Object.keys(f).length === 0) continue;
    if (Array.isArray(v) && Array.isArray(f) && v.length > 0 && f.length === 0) continue;
    out[k] = f;
  }
  return out;
}

// 快速调用：$角色名$ -> 该角色整棵投影
function renderCharacter(root, name, triggerText) {
  const hit = readPath(root, [], name);
  if (hit.value === undefined) return "";
  return project(root, hit.segs, hit.value, makeCtx(triggerText));
}

// 便捷入口：给一段文本，按存储求值
function evaluate(root, text, triggerText) {
  return evalText(root, [], text, makeCtx(triggerText));
}
/* ---- store.js ---- */
// st-chatu8 tag 存储：默认写【消息楼层变量】（酒馆助手 TavernHelper 的 message 域）
// 可选 backend: "chat" 走聊天变量 chatMetadata.variables
// 纯逻辑；注入 index.js 时删掉 export


// 深合并：对象递归；字符串/数组/数字直接替换；null 或 "" 表示删除该键
function mergeTags(base, patch) {
  if (!isPlainObject(patch)) return patch;
  const out = Object.assign({}, isPlainObject(base) ? base : {});
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    if (pv === null || pv === undefined || pv === "") { delete out[k]; continue; }
    if (isPlainObject(pv)) out[k] = mergeTags(out[k], pv);
    else out[k] = pv;
  }
  return out;
}

function createStorage(opts) {
  const cfg = opts || {};
  const win = cfg.win || (typeof window !== "undefined" ? window : {});
  const ns = cfg.namespace || "st-chatu8";
  const backend = cfg.backend || "message";

  function ctx() {
    try {
      if (win.SillyTavern && typeof win.SillyTavern.getContext === "function") return win.SillyTavern.getContext();
      if (typeof win.getContext === "function") return win.getContext();
    } catch (e) { }
    return null;
  }

  function chatVars(c) {
    if (!c) return null;
    if (!isPlainObject(c.chatMetadata)) c.chatMetadata = {};
    if (!isPlainObject(c.chatMetadata.variables)) c.chatMetadata.variables = {};
    return c.chatMetadata.variables;
  }

  function helper() {
    const h = win.TavernHelper;
    if (h && typeof h.getVariables === "function" && typeof h.replaceVariables === "function") return h;
    return null;
  }

  function chatArr() {
    const c = ctx();
    if (!c) return null;
    const arr = c.chat || (win.SillyTavern && win.SillyTavern.chat);
    return Array.isArray(arr) ? arr : null;
  }

  function lastMessageId() {
    const arr = chatArr();
    return arr && arr.length ? arr.length - 1 : -1;
  }

  function swipeOf(msg) {
    if (isPlainObject(msg) && typeof msg.swipe_id === "number") return msg.swipe_id;
    return 0;
  }

  function readChat() {
    const c = ctx();
    const vars = chatVars(c);
    if (!vars) return null;
    const mine = vars[ns];
    return isPlainObject(mine) ? mine : null;
  }

  function writeChat(tags) {
    const c = ctx();
    const vars = chatVars(c);
    if (!vars) return false;
    vars[ns] = Object.assign({}, tags || {});
    try { if (c && typeof c.saveMetadata === "function") c.saveMetadata(); } catch (e) { }
    return true;
  }

  function readTable(messageId) {
    const h = helper();
    if (h) { try { return h.getVariables({ type: "message", message_id: messageId }) || {}; } catch (e) { return {}; } }
    const arr = chatArr();
    if (!arr || messageId < 0 || messageId >= arr.length) return {};
    const msg = arr[messageId];
    const v = isPlainObject(msg) ? msg.variables : null;
    if (!isPlainObject(v)) return {};
    const s = swipeOf(msg);
    if (isPlainObject(v[s])) return v[s];
    return v;
  }

  function writeTable(messageId, table) {
    const h = helper();
    if (h) { try { h.replaceVariables(table, { type: "message", message_id: messageId }); return true; } catch (e) { return false; } }
    const arr = chatArr();
    if (!arr || messageId < 0 || messageId >= arr.length) return false;
    const msg = arr[messageId];
    if (!isPlainObject(msg)) return false;
    if (!isPlainObject(msg.variables)) msg.variables = {};
    msg.variables[swipeOf(msg)] = table;
    try { const c = ctx(); if (c && typeof c.saveChat === "function") c.saveChat(); } catch (e) { }
    return true;
  }

  function readAt(messageId) {
    if (backend === "chat") return readChat();
    const mine = readTable(messageId)[ns];
    return isPlainObject(mine) ? mine : null;
  }

  function writeAt(messageId, tags) {
    if (backend === "chat") return writeChat(tags);
    const table = readTable(messageId);
    const next = Object.assign({}, isPlainObject(table) ? table : {});
    next[ns] = Object.assign({}, tags || {});
    return writeTable(messageId, next);
  }

  function findLatest(fromId) {
    if (backend === "chat") return { messageId: -1, tags: readChat() };
    if (typeof fromId === "number" && fromId < 0) {
      const mine = readAt(fromId);
      if (mine) return { messageId: fromId, tags: mine };
    }
    let i = typeof fromId === "number" ? fromId : lastMessageId();
    for (; i >= 0; i--) {
      const mine = readAt(i);
      if (mine) return { messageId: i, tags: mine };
    }
    return { messageId: -1, tags: null };
  }

  return {
    ns: ns,
    backend: backend,
    usingHelper: function () { return !!helper(); },
    lastMessageId: lastMessageId,
    readTable: readTable,
    writeTable: writeTable,
    readAt: readAt,
    writeAt: writeAt,
    findLatest: findLatest,
    readTags: function (fromId) { try { return findLatest(fromId).tags || {}; } catch (e) { return {}; } },
    applyUpdate: function (messageId, patch) {
      const cur = readAt(messageId) || findLatest(messageId).tags || {};
      const merged = mergeTags(cur, patch);
      const ok = writeAt(messageId, merged);
      return { ok: ok, tags: merged };
    }
  };
}
/* ---- patch.js ---- */
// st-chatu8 更新块：从生图 LLM 的输出里摘出变量更新，并把这段从提示词里去掉
// 更新 = 一棵部分树（不用 op/path）：写值=设置/新增，空串=删除，对象=往库里加条目
//
// 模型输出经常不干净（会复述格式模板），实测出现过：
//   <变量更新>json<变量更新></images>
//
//   </images>
//   <变量更新>
//   { ... 真正的 JSON ... }
//   </变量更新>
// 老写法「第一个开标签配第一个闭标签」会把 json<变量更新></images>… 一起抓进来 → JSON.parse 直接失败 → 变量一个字都写不进去。
// 现在改成：列出所有候选片段（最内层优先），逐个尝试解析，谁解析成功用谁；整段垃圾一起从正文里摘掉。

const UPDATE_TAG = "变量更新";

const OPEN_RE = new RegExp("<" + UPDATE_TAG + ">", "gi");
const CLOSE_RE = new RegExp("</" + UPDATE_TAG + ">", "gi");
const ANY_TAG_RE = new RegExp("</?" + UPDATE_TAG + ">", "gi");

function stripFence(s) {
  let t = String(s).trim();
  const m = t.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (m) t = m[1].trim();
  return t;
}

// 候选片段里的噪音：代码围栏、"json" 字样（模型把格式说明一起吐出来了）、残留的复述开标签
function stripJsonLabel(s) {
  let t = stripFence(s);
  const reTag = new RegExp("^(?:<" + UPDATE_TAG + ">)+\\s*", "i");
  const reJson = /^json\s*/i;
  // 模型可能复述成 <变量更新>json<变量更新>{...}：标签和 json 字样交替出现，反复剥几轮
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(reTag, "").replace(reJson, "");
    if (t === before) break;
  }
  return t.trim();
}

// 宽松解析：去掉 json 标签/代码围栏、去掉尾随逗号再试
function looseJsonParse(s) {
  const t = stripJsonLabel(s).replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(t);
}

// 模型常把 ${"name":"x",...}$ 直接塞进 JSON 字符串里而忘记转义引号 —— 只修 $...$ 内部，不动别处
function repairQuotesInCalls(text) {
  return String(text).replace(/\$[^$]*\$/g, function (m) {
    return m.replace(/\\"/g, "\"").replace(/"/g, "\\\"");
  });
}

// 只把 $...$ 片段逐个交给扩展的展开器，绝不把整段 JSON 喂进去（那会搅烂换行与括号）
function expandSpans(text, expand) {
  if (typeof expand !== "function") return String(text);
  return String(text).replace(/\$[^$]*\$/g, function (m) {
    try { var r = expand(m); return (typeof r === "string" && r) ? r : m; } catch (e) { return m; }
  });
}

// 解析一段更新文本（已展开过预设调用的版本）
function parsePatchText(text) {
  const fixed = repairQuotesInCalls(text);
  const obj = looseJsonParse(fixed);
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not-object");
  return obj;
}

// 所有 <变量更新>…</变量更新> 候选：每个闭标签先配「它前面最近的开标签」（最内层，最像真 JSON），
// 再补上其它开×闭组合兜底；去重并限量
function updateCandidates(text) {
  const s = String(text == null ? "" : text);
  const opens = [];
  const closes = [];
  for (const m of s.matchAll(OPEN_RE)) opens.push(m.index);
  for (const m of s.matchAll(CLOSE_RE)) closes.push(m.index);
  const out = [];
  const seen = {};
  const add = (o, c) => {
    const start = o + UPDATE_TAG.length + 2;
    if (c <= start) return;
    const key = o + ":" + c;
    if (seen[key]) return;
    seen[key] = 1;
    out.push({ open: o, close: c, start: start, end: c, text: s.slice(start, c) });
  };
  if (!opens.length || !closes.length) return out;
  for (const c of closes) {
    let inner;
    for (const o of opens) { if (o < c) inner = o; else break; }
    if (inner !== undefined) add(inner, c);
  }
  for (const o of opens) for (const c of closes) if (c > o) add(o, c);
  return out.slice(0, 24);
}

// 哪些候选算「真块/复述垃圾」：文本里没有任何图片内容标记的都算
const IMAGE_CONTENT_RE = /<(?:image|regex|title_styled|Tag_think|prompts|safe)\b/i;

// 按候选各自的 [开标签 → 闭标签] 范围做掩码删除（重叠自动合并）；
// 绝不从第一个开标签一路删到最后一个闭标签 —— 否则模型在 <thinking> 里写一句
// 「后接 <变量更新>」就会把中间的 <images> 整段删掉（2026-09-30 报的格式错误就是这个）
function removeByMask(s, spans) {
  const mask = new Array(s.length).fill(false);
  for (const c of spans) {
    const to = Math.min(s.length, c.close + UPDATE_TAG.length + 3);
    for (let i = c.open; i < to; i++) mask[i] = true;
  }
  let out = "";
  for (let i = 0; i < s.length; i++) if (!mask[i]) out += s.charAt(i);
  return out.replace(ANY_TAG_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

// 结尾要摘的候选：不含图片内容标记的候选（含真块）+ 命中的那个真块本身
function junkAndParsed(s, candidates, parsed) {
  const spans = candidates.filter((c) => !IMAGE_CONTENT_RE.test(c.text));
  if (parsed && !spans.some((c) => c.open === parsed.open && c.close === parsed.close)) spans.push(parsed);
  return spans.length ? removeByMask(s, spans) : s.replace(ANY_TAG_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

// 摘块：候选按「范围最小（最内层）」优先，取第一个非空候选作为真块
function extractUpdateBlock(text) {
  const s = String(text == null ? "" : text);
  const candidates = updateCandidates(s);
  if (!candidates.length) {
    const hasTag = new RegExp("<" + UPDATE_TAG + ">", "i").test(s) || new RegExp("</" + UPDATE_TAG + ">", "i").test(s);
    if (!hasTag) return { clean: s, raw: "", candidates: [] };
    return { clean: s.replace(ANY_TAG_RE, "").replace(/\n{3,}/g, "\n\n").trim(), raw: "", candidates: [] };
  }
  const ordered = candidates.slice().sort((a, b) => a.text.length - b.text.length);
  const best = ordered.find((c) => c.text.trim().length > 0) || ordered[0];
  return { clean: junkAndParsed(s, candidates, best), raw: best ? best.text : "", candidates: candidates };
}

// 逐个候选尝试解析，谁先解析成功就用谁
function parseUpdate(text) {
  const got = extractUpdateBlock(text);
  const list = got.candidates || [];
  if (!list.length || !String(got.raw || "").trim()) {
    return { clean: got.clean, raw: "", candidates: list, patch: null, ok: false, error: "no-block" };
  }
  let lastErr = "";
  // 范围最小的候选优先（最像真块）；摘掉的是它自己的那一小段
  const ordered = list.slice().sort((a, b) => a.text.length - b.text.length);
  for (const c of ordered) {
    const body = String(c && c.text != null ? c.text : "");
    if (!body.trim()) continue;
    try {
      const patch = parsePatchText(body);
      return { clean: junkAndParsed(String(text == null ? "" : text), list, c), raw: body, candidates: list, patch: patch, ok: true, error: "" };
    } catch (e) {
      lastErr = String(e && e.message || e);
    }
  }
  return { clean: got.clean, raw: got.raw, candidates: list, patch: null, ok: false, error: lastErr || "no-json" };
}

/* ---- glue.js ---- */
// st-chatu8 变量系统粘合层：生图 LLM 输出 -> 摘块 -> 写楼层变量 -> 生图前求值
// 纯逻辑；注入 index.js 时删掉 import/export




function createVarSystem(opts) {
  const cfg = opts || {};
  const st = createStorage(cfg);

  // 某楼层的状态：优先这一楼自己的表，没有就往下找最近一个楼层（楼层变量是逐楼快照）
  function currentTags(messageId) {
    if (messageId == null) return {};
    const at = st.readAt(messageId);
    if (at) return at;
    const latest = st.findLatest(messageId);
    return latest.tags || {};
  }

  return {
    storage: st,
    tags: currentTags,

    // 上一个消息楼层的状态（模型要看的「上一楼」，也是本楼层更新时的起点）
    prevTags: function (messageId) {
      const cur = (messageId == null) ? st.lastMessageId() : messageId;
      return cur > 0 ? currentTags(cur - 1) : {};
    },

    // 生图 LLM 输出：摘掉更新块，其余是图片提示词；有更新就写进这一楼
    ingest: function (text, messageId) {
      const r = parseUpdate(text);
      let wrote = false;
      if (r.ok) {
        const merged = mergeTags(currentTags(messageId), r.patch);
        wrote = st.writeAt(messageId, merged);
      }
      return { clean: r.clean, ok: r.ok, wrote: wrote, error: r.error };
    },

    // 生图前：把提示词里的 $路径$ 用当前变量求值
    render: function (text, messageId) {
      return evaluate(currentTags(messageId), text, text);
    },

    // 单个角色的当前投影（面板/调试用）
    char: function (name, messageId) {
      return evaluate(currentTags(messageId), "$" + name + "$", name);
    }
  };
}

// 对外接口（被 build-vars.mjs 拼到 bundle 尾部）
var __system = null;
function __stSys() {
  if (!__system) __system = createVarSystem({ namespace: "st-chatu8", version: 1, backend: (window.__stChatu8VarsBackend || "message") });
  return __system;
}
function __stLastId() { return __stSys().storage.lastMessageId(); }

// ---- 楼层模式 v1.3.0：varsFloorMode = "follow"（默认，v1.2.2 行为）| "latest"（始终最新层）----
// 缺失 / 非法 / 其它值一律回落 "follow"，保证默认行为一字不变
function __stSettingsBox() {
  try {
    var c = (window.SillyTavern && window.SillyTavern.getContext) ? window.SillyTavern.getContext() : null;
    var es = c && c.extensionSettings;
    return es ? (es["st-chatu8"] || null) : null;
  } catch (e) { return null; }
}
function __stMode() {
  try {
    var cfg = __stSettingsBox();
    return (cfg && cfg.varsFloorMode === "latest") ? "latest" : "follow";
  } catch (e) { return "follow"; }
}

// 当前聊天楼层数（拿不到返回 -1）
function __stChatLen() {
  try {
    var c = (window.SillyTavern && window.SillyTavern.getContext) ? window.SillyTavern.getContext() : null;
    var arr = c && c.chat;
    return Array.isArray(arr) ? arr.length : -1;
  } catch (e) { return -1; }
}

// 当前楼层 = 这次请求正在处理的那一楼。
// index.js 在处理某条消息（生图 / 视材准备 / 角色设计…）时会打标记 window.__stChatu8VarsFloor，
// 所以旧楼层重绘、连续点几条消息都能各归各楼；没有标记（设置页直接点按钮）才退回聊天最后一楼。
function __stCurId() {
  var last = __stLastId();
  try {
    var h = window.__stChatu8VarsFloor;
    if (h && typeof h.id === "number" && h.id >= 0) {
      var len = __stChatLen();
      var fresh = (Date.now() - (h.at || 0)) < 6 * 3600 * 1000;
      if (fresh && (len < 0 || h.id < len)) return h.id;
    }
  } catch (e) { }
  return last;
}

// 给模型看的变量 = 上一个消息楼层（当前楼层还没定稿，它该看的是自己之前的状态）
// latest 模式：读最新层本身。id 只给 floor() 这类显式查询用，不传 = 当前楼层。
function __stReadId(id) {
  if (__stMode() === "latest") return __stLastId();
  var cur = (id == null) ? __stCurId() : id;
  return cur > 0 ? cur - 1 : -1;
}

// 写哪一楼（生图求值 render 用）：latest = 最新层；follow = 当前楼层（v1.2.2 行为）
function __stWriteId(id) {
  if (__stMode() === "latest") return __stLastId();
  return (id == null) ? __stCurId() : id;
}

// <变量更新> 落库写哪一楼：latest 忽略传进来的旧楼层 id，一律写最新层；
// follow 与 v1.2.2 完全相同（显式 id 优先，否则当前楼层）
function __stIngestId(id) {
  if (__stMode() === "latest") return __stLastId();
  return (id == null) ? __stCurId() : id;
}

// 指定楼层的状态（<0 视为空）
function __stTagsAt(at) {
  if (at == null || at < 0) return {};
  try { return __stSys().tags(at) || {}; } catch (e) { return {}; }
}

// 在插件 LLM 入口的返回值里找「装着 <变量更新> 的字符串」，并记住怎么写回去
// （LLM_IMAGE_GEN 返回的是 { result, testMode } 对象，不是字符串 —— 这就是"正文生图不更新"的原因）
function __stFindVarBox(obj, depth, path) {
  if (!obj || typeof obj !== "object" || (depth || 0) > 3) return null;
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], v = obj[k];
    var p = (path ? path + "." : "") + k;
    if (typeof v === "string") {
      if (v.indexOf("变量更新") >= 0) return { value: v, path: p, key: k, host: obj };
    } else if (v && typeof v === "object") {
      var found = __stFindVarBox(v, (depth || 0) + 1, p);
      if (found) return found;
    }
  }
  return null;
}

window.stChatu8Vars = {
  version: "1.3.1",

  // 生图 LLM 输出：摘掉 <变量更新> 块并写入该楼层，返回摘干净后的提示词
  // id 不给 = 写当前楼层（正在处理的那一楼）
  ingestMessage: function (mes, id, expand) {
    // latest 模式忽略传进来的旧楼层 id，一律写最新层
    var at = __stIngestId(id);
    var r = parseUpdate(mes);
    var out = { changed: r.clean !== mes, clean: r.clean, ok: false, wrote: false, error: r.error, raw: "", tried: 0 };
    var list = (r.candidates && r.candidates.length) ? r.candidates : (r.raw ? [{ text: r.raw }] : []);
    if (!list.length) return out; // 没有 <变量更新> 块
    var lastErr = "";
    // 逐个候选试：模型可能把格式模板也复述出来（<变量更新>json<变量更新>），第一个候选往往不是真 JSON
    for (var i = 0; i < list.length; i++) {
      var raw = String(list[i] && list[i].text != null ? list[i].text : "");
      if (!raw.trim()) continue;
      out.tried = out.tried + 1;
      // ① 先展开预设调用（此时还是模型原样写的文本，$...$ 里的引号没转义也能认）
      if (typeof expand === "function" && raw.indexOf("$") >= 0) {
        var uc = window.collectedCharacterNegatives;
        // 只把「预设调用 / 官方调用」交给插件展开器；$路径$ 指针（含多重调用、通配）原样存进变量，
        // 否则 processCharacterPrompt 会把指针也展开成 tag 写进存储（v1.0.9 及以前的 bug）
        var root0 = null;
        try { root0 = __stTagsAt(at); } catch (e) { root0 = null; }
        var guarded = function (span) {
          try { if (root0 && isVarPointer(root0, span)) return span; } catch (e) { }
          return expand(span);
        };
        try { raw = expandSpans(raw, guarded); } catch (e) { console.warn("[ChatU8 vars] expand patch failed", e); } finally { window.collectedCharacterNegatives = uc; }
      }
      // ② 再把 $...$ 里漏转义的引号补上，然后解析
      var patch;
      try { patch = parsePatchText(raw); }
      catch (e) { lastErr = String(e && e.message || e); continue; }
      var s = __stSys();
      var merged = mergeTags(__stTagsAt(at), patch);
      out.wrote = s.storage.writeAt(at, merged);
      out.ok = true;
      out.error = "";
      out.raw = raw.slice(0, 300);
      console.log("[ChatU8 vars] 写入楼层 " + at + "（读 " + __stReadId() + "）ok=" + out.wrote + " 后端=" + (window.TavernHelper ? "TavernHelper" : "chat.variables") + " 候选=" + (i + 1) + "/" + list.length);
      return out;
    }
    out.error = "parse: " + lastErr;
    out.raw = "";
    return out;
  },

  // 插件 LLM 入口的统一处理：字符串 / {result:...} / 嵌套对象都能吃
  // 返回 {ok, wrote, changed, clean, error, field, tried}；对象会就地写回摘干净的正文
  ingestLlm: function (out, id, kind, expand) {
    // 与 ingestMessage 同一套规则：latest 模式下一律写最新层
    var mid = __stIngestId(id);
    var empty = { ok: false, wrote: false, changed: false, clean: "", error: "", field: null, tried: 0, kind: kind || "" };
    if (typeof out === "string") {
      if (out.indexOf("变量更新") < 0) { empty.error = "没有 <变量更新> 块"; return empty; }
      var r = this.ingestMessage(out, mid, expand);
      r.field = null; r.kind = kind || "";
      return r;
    }
    if (!out || typeof out !== "object") { empty.error = "返回结果既不是字符串也不是对象"; return empty; }
    var box = __stFindVarBox(out, 0, "");
    if (!box) { empty.error = "没有 <变量更新> 块"; return empty; }
    var r2 = this.ingestMessage(box.value, mid, expand);
    r2.field = box.path; r2.kind = kind || "";
    if (r2.changed) { try { box.host[box.key] = r2.clean; } catch (e) { } }
    return r2;
  },

  // 生图前：把提示词里的 $路径$ 用【写楼层】的变量求值（官方 $...$ 调用原样穿过）
  // follow：写楼层 = 正在处理的这条消息（它的更新已经写进这一楼，所以这里读自己这一楼）
  // latest：写楼层 = 最新层
  render: function (text, id) {
    try {
      var s = __stSys();
      var at = (id == null) ? __stWriteId() : id;
      var root = __stTagsAt(at);
      var from = at;
      // v1.3.1：变量是按楼层的累积快照，写楼层很可能没有本层的 <变量更新>（或生图被排队后楼层漂移），
      // 此时只读死楼层会拿到空表 → $路径$ 全部不展开，表现为"正文 tag 不用于生图、当前计数 0、
      // 只剩固定预设"。改成往前找最近一份非空快照，这正是"读上一楼"的同一语义。
      if (!root || !Object.keys(root).length) {
        var hi = Math.max(at, __stLastId());
        var scanned = 0;
        for (var k = hi; k >= 0 && scanned < 400; k--, scanned++) {
          if (k === at) continue;
          var rk = __stTagsAt(k);
          if (rk && Object.keys(rk).length) { root = rk; from = k; break; }
        }
      }
      if (!root || !Object.keys(root).length) {
        try { console.warn("[ChatU8 vars] render: 楼层 " + at + " 及之前都没有变量，$路径$ 不展开（提示词会缺正文 tag）"); } catch (e0) { }
        return text;
      }
      if (from !== at) { try { console.warn("[ChatU8 vars] render: 楼层 " + at + " 无变量，改用楼层 " + from + " 的快照"); } catch (e1) { } }
      // v1.3.1 关键修复：NAI4/4.5 的多角色提示词用「;」分段：
      //   Scene Composition:...;Character 1 Prompt:...|centers:C3;Character 1 UC:...;
      // 而 evaluate() 按逗号拆段再用「, 」拼回去，会把所有「;」抹成「, 」，
      // 导致 parsePromptStringWithCoordinates 的正则（要求 ; 结尾）整段匹配失败 →
      // 解析结果 {"Scene Composition": ""} → 用于生成的 Tag 为空 → 只剩固定提示词预设。
      // 所以：文本里有「;」时，先把 ; 换成哨兵字符跑完求值，再换回来，保证结构逐字不变。
      var SEP = "\u0001";
      var src = String(text);
      if (src.indexOf(";") >= 0) {
        var out = evaluate(root, src.split(";").join(SEP), src.split(";").join(SEP));
        return String(out).split(SEP).join(";");
      }
      return evaluate(root, text, text);
    } catch (e) {
      console.warn("[ChatU8 vars] render failed", e);
      return text;
    }
  },

  // 楼层去向（调试用）：当前楼层 / 读哪一楼 / 写哪一楼 / 模式
  floor: function (id) {
    var cur = (id == null) ? __stCurId() : id;
    var h = null;
    try { h = window.__stChatu8VarsFloor || null; } catch (e) { h = null; }
    return { current: cur, read: __stReadId(id), write: __stWriteId(id), last: __stLastId(), mode: __stMode(), hint: h };
  },

  // ---------------- 楼层模式 v1.3.0 ----------------

  // 当前模式："follow"（默认）| "latest"
  getFloorMode: function () { return __stMode(); },

  // 切换模式：非法值回落 "follow"；写扩展设置 + 保存 + 同步设置页
  setFloorMode: function (mode) {
    var m = (mode === "latest") ? "latest" : "follow";
    try {
      var cfg = __stSettingsBox();
      if (cfg) cfg.varsFloorMode = m;
      var c = (window.SillyTavern && window.SillyTavern.getContext) ? window.SillyTavern.getContext() : null;
      if (c && typeof c.saveSettingsDebounced === "function") c.saveSettingsDebounced();
    } catch (e) { }
    try { __stSyncFloorUi(); } catch (e) { }
    return { ok: true, mode: m };
  },

  // 立刻看最新层的变量（只读，不改任何存储）
  // exact = 最新层自己有表；from = 实际取到表的那一层（没有则 -1）
  readLatest: function () {
    var to = -1, exact = false, from = -1, tags = {};
    try {
      to = __stLastId();
      if (to >= 0) {
        try { exact = !!__stSys().storage.readAt(to); } catch (e) { exact = false; }
        tags = __stTagsAt(to) || {};
        if (exact) from = to;
        else {
          try { var f = __stSys().storage.findLatest(to); from = (f && typeof f.messageId === "number") ? f.messageId : -1; }
          catch (e) { from = -1; }
        }
      }
    } catch (e) { }
    var s = "";
    try { s = JSON.stringify(tags); } catch (e) { s = ""; }
    return {
      ok: to >= 0,
      to: to,
      from: from,
      exact: exact,
      tags: tags,
      count: Object.keys(tags || {}).length,
      chars: s.length
    };
  },

  // 把当前生效的变量状态固化/更新到最新一层
  // from 缺省 = 当前楼层；from === to 时改取 to 之前最近一份快照（找不到仍用 to），任何情况都不抛
  commitLatest: function (fromId) {
    var to = -1, from = -1, wrote = false, tags = {};
    try {
      to = __stLastId();
      from = (fromId == null) ? __stCurId() : fromId;
      if (to >= 0) {
        var st = __stSys().storage;
        if (from === to) {
          var f = st.findLatest(to - 1);
          if (f && typeof f.messageId === "number" && f.messageId >= 0) from = f.messageId;
          else from = to;
        }
        tags = __stTagsAt(from) || {};
        wrote = !!st.writeAt(to, tags);
      }
    } catch (e) { wrote = false; }
    var s = "";
    try { s = JSON.stringify(tags); } catch (e) { s = ""; }
    return {
      ok: (to >= 0 && wrote),
      from: from,
      to: to,
      wrote: wrote,
      count: Object.keys(tags || {}).length,
      chars: s.length
    };
  },

  // 把模式 / 楼层 / 按钮 title 同步到设置页（DOM 不在就安全跳过）
  syncFloorUi: function () { return __stSyncFloorUi(); },

  tags: function (id) { return __stSys().tags(id); },

  // 进入聊天时初始化变量表（让结构与命名空间先存在）
  ensureStore: function (id) {
    try {
      var s = __stSys();
      var at = s.storage.readAt(id);
      if (at) {
        // 已有变量表：只做一次旧版清理（把历史遗留的 _v 去掉），不重建
        if (Object.prototype.hasOwnProperty.call(at, "_v")) {
          var clean = Object.assign({}, at);
          delete clean._v;
          return s.storage.writeAt(id, clean) ? "migrated" : "exists";
        }
        return "exists";
      }
      // 只建命名空间这一层，不预设任何结构（结构自己定）
      return s.storage.writeAt(id, {}) ? "created" : false;
    } catch (e) { return false; }
  },
  char: function (name, id) { return __stSys().char(name, id); },

  // 注入给模型的当前变量块（读【上一个消息楼层】）
  promptBlock: function (id) {
    var t = __stTagsAt(id == null ? __stReadId() : id);
    var view = this.viewText(undefined, id);
    var tail = (view && view !== "{}" && view !== "[]") ? "\n<当前变量视图>\n" + view + "\n</当前变量视图>" : "";
    return "\n<当前变量>\n" + JSON.stringify(t) + "\n</当前变量>" + tail;
  },


  // {{绘图变量}} -> 原始存储（给模型改：保留 $路径$ 指针原样）；读【上一个消息楼层】
  rawText: function (id) {
    try {
      return JSON.stringify(__stTagsAt(id == null ? __stReadId() : id));
    } catch (e) { return ""; }
  },

  // {{绘图变量视图}} -> 求值后的最终 tag（key 命中的角色才出现，指针展开）；读【上一个消息楼层】
  viewText: function (triggerText, id) {
    try {
      var t = __stTagsAt(id == null ? __stReadId() : id);
      var filtered = filterActive(t, triggerText);
      return JSON.stringify(filtered === undefined ? {} : filtered);
    } catch (e) { return ""; }
  },

  // 调试/测试用
  _internal: {
    createVarSystem: createVarSystem,
    parseUpdate: parseUpdate,
    parsePatchText: parsePatchText,
    expandSpans: expandSpans,
    isVarPointer: isVarPointer,
    repairQuotesInCalls: repairQuotesInCalls,
    mergeTags: mergeTags,
    evaluate: evaluate,
    createStorage: createStorage
  }
};

// ---------------- 设置页 DOM（v1.3.0） ----------------
// 设置页会被反复打开/重渲染，所以用 document 级事件委托 + 幂等标记；node 单测里没有 document，全部安全跳过

function __stDoc() {
  try { return (typeof document === "undefined") ? null : document; } catch (e) { return null; }
}
function __stEl(id) {
  var d = __stDoc();
  if (!d || typeof d.getElementById !== "function") return null;
  try { return d.getElementById(id); } catch (e) { return null; }
}
function __stModeLabel(mode) {
  return (mode === "latest") ? "始终最新层" : "跟随当前楼层";
}
// toast：window.toastr 有就用，没有/报错都静默跳过
function __stToast(level, msg) {
  try {
    var t = (typeof window !== "undefined") ? window.toastr : null;
    if (!t) return false;
    var fn = t[level];
    if (typeof fn !== "function") fn = t.info;
    if (typeof fn !== "function") return false;
    fn.call(t, msg);
    return true;
  } catch (e) { return false; }
}

// 把模式 / 楼层 / 按钮 title 同步到设置页（DOM 不在就安全跳过）
function __stSyncFloorUi() {
  if (!__stDoc()) return false;
  try {
    var mode = __stMode();
    var sel = __stEl("varsFloorMode");
    if (sel) sel.value = mode;
    var txt = __stEl("vars-floor-status");
    if (txt) txt.textContent = "当前楼层 " + __stCurId() + " · 读取 " + __stReadId() + " · 写 " + __stWriteId() + " · 模式 " + __stModeLabel(mode);
    var last = __stLastId();
    var suffix = (last >= 0) ? ("（最新层 " + last + "）") : "";
    var rd = __stEl("vars-read-latest");
    if (rd) rd.title = "立即读取最新一层的变量" + suffix;
    var wr = __stEl("vars-write-latest");
    if (wr) wr.title = "把当前变量状态写入最新一层" + suffix;
  } catch (e) { }
  return true;
}

// 「📥 读取最新层」：看最新层变量 -> toast -> 同步状态行
function __stFloorUiRead() {
  var r = window.stChatu8Vars.readLatest();
  var msg = "最新层 " + r.to + "：" + r.count + " 个角色 / " + r.chars + " 字";
  if (!r.exact && r.from >= 0) msg += "（取楼层 " + r.from + " 的快照）";
  __stToast(r.ok ? "success" : "warning", msg);
  __stSyncFloorUi();
  return r;
}
// 「📤 更新到最新层」：把当前生效状态写进最新层 -> toast -> 同步状态行
function __stFloorUiWrite() {
  var r = window.stChatu8Vars.commitLatest();
  var msg;
  if (r.ok) msg = "已把楼层 " + r.from + " 的变量更新到最新层 " + r.to + "（" + r.count + " 个字段）";
  else msg = "更新失败：没有可用的楼层（最新层 " + r.to + "）";
  __stToast(r.ok ? "success" : "error", msg);
  __stSyncFloorUi();
  return r;
}

// document 级事件委托（幂等：document 上打标记，重复调用只绑一次）
function __stBindFloorUi() {
  var d = __stDoc();
  if (!d || typeof d.addEventListener !== "function") return false;
  if (d.__stChatu8VarsFloorUiBound) return false;
  d.__stChatu8VarsFloorUiBound = true;
  d.addEventListener("change", function (ev) {
    try {
      var el = ev && ev.target;
      if (!el || el.id !== "varsFloorMode") return;
      var r = window.stChatu8Vars.setFloorMode(el.value);
      __stToast("info", "变量楼层模式：" + __stModeLabel(r.mode));
    } catch (e) { }
  }, true);
  d.addEventListener("click", function (ev) {
    try {
      var el = ev && ev.target;
      if (!el) return;
      var id = el.id || "";
      if (id !== "vars-read-latest" && id !== "vars-write-latest" && el.closest) {
        var hit = el.closest("#vars-read-latest, #vars-write-latest");
        id = hit ? hit.id : "";
      }
      if (id === "vars-read-latest") __stFloorUiRead();
      else if (id === "vars-write-latest") __stFloorUiWrite();
    } catch (e) { }
  }, true);
  return true;
}

// 模块加载后：DOM 已在就直接同步一次（设置页先于模块加载也有效）
try {
  if (__stDoc()) {
    __stBindFloorUi();
    __stSyncFloorUi();
  }
} catch (e) { }
/* ---- debug.js ---- */
// ---- 变量调试接口（控制台用）：读取 / 写入指定 JSON / 模拟模型回复 ----
// 注意：只提供 window.stChatu8VarsDebug 函数，不往页面里塞任何悬浮窗/按钮。
// 全部函数都接受可选的 sys 参数，便于在 node 里单测（不传就用全局 __stSys()）

function __stDbgSys(sys) {
  if (sys) return sys;
  return (typeof __stSys === "function") ? __stSys() : null;
}

// 当前楼层号（没有聊天时返回 -1）
function __stDbgLastId(sys) {
  var s = __stDbgSys(sys);
  if (!s) return -1;
  var id = s.storage.lastMessageId();
  return (id == null) ? -1 : id;
}

// 插件设置对象（进度日志/开关）
function __stDbgSettings(win) {
  var w = win || (typeof window !== "undefined" ? window : null);
  try { return w.SillyTavern.getContext().extensionSettings["st-chatu8"] || {}; } catch (e) { return {}; }
}

function __stDbgLog(n, win) {
  var es = __stDbgSettings(win);
  return String(es.log || "").split("\n").filter(function (x) { return x.indexOf("[变量]") >= 0; }).slice(-(n || 8));
}

// 楼层模式（读注入的 win，缺省全局 window）：缺失 / 非法一律回落 "follow"
function __stDbgMode(win) {
  try {
    var w = win || (typeof window !== "undefined" ? window : null);
    var c = (w && w.SillyTavern && w.SillyTavern.getContext) ? w.SillyTavern.getContext() : null;
    var cfg = (c && c.extensionSettings) ? c.extensionSettings["st-chatu8"] : null;
    return (cfg && cfg.varsFloorMode === "latest") ? "latest" : "follow";
  } catch (e) { return "follow"; }
}

// 楼层去向：当前楼层 / 读哪一楼（模型看到的）/ 写哪一楼（更新写进去的）/ 模式
function __stDbgFloor(sys, win) {
  var w = win || (typeof window !== "undefined" ? window : {});
  var vm = w.stChatu8Vars || (typeof window !== "undefined" ? window.stChatu8Vars : null);
  var out = { current: -1, read: -1, write: -1, last: -1, mode: "follow", hint: null, src: "" };
  try {
    out.mode = __stDbgMode(w);
    if (vm && typeof vm.floor === "function") {
      var r = vm.floor();
      if (r && r.mode == null) r.mode = out.mode;
      return r;
    }
    var s = __stDbgSys(sys);
    out.last = __stDbgLastId(s);
    out.current = out.last;
    if (out.mode === "latest") { out.read = out.last; out.write = out.last; }
    else { out.read = out.current > 0 ? out.current - 1 : -1; out.write = out.current; }
    out.hint = w.__stChatu8VarsFloor || null;
  } catch (e) { }
  return out;
}

// 一、整体状态：一眼看出「加载了没 / 后端是谁 / 楼层几 / 钩子挂上没」
function __stDbgInfo(sys, win) {
  var w = win || (typeof window !== "undefined" ? window : {});
  var s = __stDbgSys(sys);
  var fl = __stDbgFloor(s, w);
  var mid = fl.write;
  var exact = false, err = "";
  try { exact = (mid >= 0) ? !!(s && s.storage.readAt(mid)) : false; } catch (e) { err = String(e && e.message || e); }
  return {
    varsVersion: (w.stChatu8Vars && w.stChatu8Vars.version) || (typeof window !== "undefined" && window.stChatu8Vars ? window.stChatu8Vars.version : "?"),
    moduleLoaded: !!(w.stChatu8Vars || (typeof window !== "undefined" && window.stChatu8Vars)),
    backend: w.TavernHelper ? "TavernHelper(楼层变量)" : "chat.variables(降级)",
    // 读上一楼（模型看的）/ 写当前楼层（更新写的）
    floorCurrent: fl.current,
    floorRead: fl.read,
    floorWrite: fl.write,
    floorLast: fl.last,
    floorHint: fl.hint,
    floorMode: (fl && fl.mode) ? fl.mode : __stDbgMode(w),
    messageId: mid,
    floorHasStore: exact,
    storeKeys: (function () { try { return Object.keys((mid >= 0 && s && s.storage.readAt(mid)) || {}); } catch (e) { return []; } })(),
    enabled: __stDbgSettings(w).varsEnabled !== "false",
    hooked: w.__stChatu8VarsLlmHooked || [],
    llmHook: w.__stChatu8VarsLlmStats || null,
    expandAvailable: typeof w.__stChatu8ExpandPrompt === "function" ? true : false,
    // 变量是否自动附加到发给 LLM 的提示词末尾（可用 stChatu8VarsDebug.setInject(false) 关掉，改用 {{绘图变量}} 宏）
    autoInject: __stDbgSettings(w).varsInject !== "false",
    error: err,
    logTail: __stDbgLog(8, w)
  };
}

// 二、读取：楼层变量（命名空间 st-chatu8）+ 同一楼层的整张原始表
function __stDbgRead(id, sys, win) {
  var w = win || (typeof window !== "undefined" ? window : {});
  var s = __stDbgSys(sys);
  var fl = __stDbgFloor(s, w);
  var mid = (id == null) ? fl.write : id;
  var out = { id: mid, floor: fl, exact: false, source: "empty", store: null, fallback: null, prev: null, rawTable: null, error: "" };
  if (!s) { out.error = "变量系统未初始化"; return out; }
  try {
    var at = (mid >= 0) ? s.storage.readAt(mid) : null;
    out.exact = !!at;
    out.store = at || s.tags(mid);
    out.source = at ? "本楼层存储" : "向上继承最近楼层";
    if (!at && mid >= 0) { var f = s.storage.findLatest(mid); out.fallback = { from: f.messageId, tags: f.tags || {} }; }
    // 模型这一轮看到的是上一楼
    if (typeof s.prevTags === "function") { var p = fl.read; out.prev = { id: p, store: (p >= 0 ? s.prevTags(fl.current) : {}) }; }
    if (w.TavernHelper && mid >= 0) {
      var table = w.TavernHelper.getVariables({ type: "message", message_id: mid });
      out.rawTable = table || null;
    }
  } catch (e) { out.error = String(e && e.message || e); }
  return out;
}

// 三、只看不写：把模型回复里的 <变量更新> 逐个候选解析出来，直接暴露是哪一步的问题
function __stDbgAnalyze(text, sys, win) {
  var w = win || (typeof window !== "undefined" ? window : {});
  var out = { hasBlock: false, candidates: [], parsed: false, error: "", patch: null };
  try {
    var r = parseUpdate(String(text == null ? "" : text));
    out.hasBlock = r.clean !== text;
    out.error = r.error || "";
    var list = (r.candidates && r.candidates.length) ? r.candidates : (r.raw ? [{ text: r.raw }] : []);
    for (var i = 0; i < list.length; i++) {
      var raw = String(list[i] && list[i].text != null ? list[i].text : "");
      var item = { index: i, length: raw.length, head: raw.replace(/\s+/g, " ").slice(0, 60), expanded: false, parsed: false, error: "" };
      var body = raw;
      if (typeof w.__stChatu8ExpandPrompt === "function" && body.indexOf("$") >= 0) {
        try { body = expandSpans(body, w.__stChatu8ExpandPrompt); item.expanded = true; } catch (e) { item.error = "expand: " + String(e && e.message || e); }
      }
      try { item.patch = parsePatchText(body); item.parsed = true; out.parsed = true; out.patch = item.patch; }
      catch (e) { item.error = String(e && e.message || e); }
      out.candidates.push(item);
    }
    out.cleanHead = String(r.clean || "").replace(/\s+/g, " ").slice(0, 120);
  } catch (e) { out.error = String(e && e.message || e); }
  return out;
}

// 四、写入：把一段 JSON（字符串或对象）按 合并/覆盖 写进指定楼层
function __stDbgWrite(json, id, mode, sys) {
  var s = __stDbgSys(sys);
  var mid = (id == null) ? __stDbgLastId(s) : id;
  var out = { ok: false, id: mid, mode: mode || "merge", merged: null, error: "" };
  if (!s) { out.error = "变量系统未初始化"; return out; }
  if (mid < 0) { out.error = "没有打开的聊天（楼层号 " + mid + "）"; return out; }
  var patch;
  try { patch = (typeof json === "string") ? JSON.parse(json) : json; }
  catch (e) { out.error = "JSON 解析失败: " + String(e && e.message || e); return out; }
  if (!patch || typeof patch !== "object") { out.error = "需要一个 JSON 对象"; return out; }
  try {
    var next = (out.mode === "replace") ? patch : mergeTags(s.tags(mid), patch);
    out.merged = next;
    out.ok = !!s.storage.writeAt(mid, next);
    if (!out.ok) out.error = "写入被拒绝（storage.writeAt 返回 false）";
  } catch (e) { out.error = String(e && e.message || e); }
  return out;
}

// 五、模拟：把「模型原样回复」当真实生图返回来跑一遍完整管线（展开 -> 补引号 -> 解析 -> 合并 -> 写）
function __stDbgSimulate(text, id, sys, win) {
  var w = win || (typeof window !== "undefined" ? window : {});
  var s = __stDbgSys(sys);
  var mid = (id == null) ? __stDbgLastId(s) : id;
  var before = null;
  try { before = s ? s.storage.readAt(mid) : null; } catch (e) {}
  var vm = w.stChatu8Vars || (typeof window !== "undefined" ? window.stChatu8Vars : null);
  if (!vm || typeof vm.ingestMessage !== "function") return { ok: false, wrote: false, error: "变量模块未加载" };
  var r = vm.ingestMessage(String(text == null ? "" : text), mid, w.__stChatu8ExpandPrompt);
  var after = null;
  try { after = s ? s.storage.readAt(mid) : null; } catch (e) {}
  return { id: mid, ok: !!r.ok, wrote: !!r.wrote, tried: r.tried, error: r.error || "", cleaned: String(r.clean || "").slice(0, 200), before: before, after: after };
}

function __stDbgReadAll(sys) {
  var s = __stDbgSys(sys);
  var out = [];
  if (!s) return out;
  var w = (typeof window !== "undefined") ? window : {};
  var len = 0;
  try { len = w.SillyTavern.getContext().chat.length; } catch (e) { return out; }
  for (var i = 0; i < len; i++) {
    var at = null;
    try { at = s.storage.readAt(i); } catch (e) { continue; }
    if (!at) continue;
    out.push({ id: i, keys: Object.keys(at), bytes: JSON.stringify(at).length });
  }
  return out;
}

// ---- 对外调试接口：window.stChatu8VarsDebug（只有控制台函数，不往页面里塞任何悬浮窗）----
window.stChatu8VarsDebug = {
  version: "1.3.0",
  info: function () { return __stDbgInfo(); },
  floor: function (id) { return __stDbgFloor(__stDbgSys(), undefined); },
  // 楼层模式：setMode 转调主模块；readLatest / commitLatest 转调同名方法
  setMode: function (mode) {
    try {
      var vm = window.stChatu8Vars;
      if (!vm || typeof vm.setFloorMode !== "function") return { ok: false, mode: __stDbgMode(), error: "变量模块未加载" };
      return vm.setFloorMode(mode);
    } catch (e) { return { ok: false, mode: __stDbgMode(), error: String(e && e.message || e) }; }
  },
  readLatest: function () {
    var empty = { ok: false, to: -1, from: -1, exact: false, tags: {}, count: 0, chars: 0, error: "" };
    try {
      var vm = window.stChatu8Vars;
      if (!vm || typeof vm.readLatest !== "function") { empty.error = "变量模块未加载"; return empty; }
      return vm.readLatest();
    } catch (e) { empty.error = String(e && e.message || e); return empty; }
  },
  commitLatest: function (fromId) {
    var empty = { ok: false, from: -1, to: -1, wrote: false, count: 0, chars: 0, error: "" };
    try {
      var vm = window.stChatu8Vars;
      if (!vm || typeof vm.commitLatest !== "function") { empty.error = "变量模块未加载"; return empty; }
      return vm.commitLatest(fromId);
    } catch (e) { empty.error = String(e && e.message || e); return empty; }
  },
  read: function (id) { return __stDbgRead(id); },
  readAll: function () { return __stDbgReadAll(); },
  analyze: function (text) { return __stDbgAnalyze(text); },
  simulate: function (text, id) { return __stDbgSimulate(text, id); },
  merge: function (json, id) { return __stDbgWrite(json, id, "merge"); },
  write: function (json, id, mode) { return __stDbgWrite(json, id, mode || "replace"); },
  clear: function (id) { return __stDbgWrite({}, id, "replace"); },
  // 自动注入开关：setInject(false) = 不自动附加变量，改用 {{绘图变量}} / {{绘图激活变量}} 宏自己放位置
  setInject: function (on) {
    try {
      var c = window.SillyTavern.getContext();
      var cfg = c.extensionSettings["st-chatu8"];
      cfg.varsInject = on ? "true" : "false";
      try { if (c.saveSettingsDebounced) c.saveSettingsDebounced(); } catch (e) { }
      return { ok: true, autoInject: cfg.varsInject !== "false" };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  },
  log: function (n) { return __stDbgLog(n); }
};

})();
