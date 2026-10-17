# compress/ — 图片缓存「压缩加强」编码器模块

给 st-chatu8 用的纯前端压缩模块：WASM 编码器跑在 Web Worker 里，图片数据不离开浏览器，不上传、不发请求。

| 输入 | 编码器 | 许可证 |
| --- | --- | --- |
| PNG / JPEG / WebP 的解码与重编码 | [oxipng](https://github.com/shssoichiro/oxipng)、[MozJPEG](https://github.com/mozilla/mozjpeg)、[libwebp](https://chromium.googlesource.com/webm/libwebp) | MIT / IJG+BSD-3-Clause+zlib / BSD-3-Clause |

包装层 `@jsquash/*`、`wasm-feature-detect` 为 Apache-2.0。**产物里没有任何 GPL/LGPL/AGPL 代码**
（pngquant、gifsicle 均未引入）。许可证原文随产物放在 `licenses/`。

## 目录

| 路径 | 说明 |
| --- | --- |
| `st-chatu8-compress.js` | 主线程 API（IIFE，挂 `window.stChatu8Compress`） |
| `worker.js` | Web Worker（内含三个编码器的胶水层） |
| `wasm/*.wasm` | 编码器二进制（oxipng / MozJPEG / libwebp non-SIMD + SIMD） |
| `checksums.json` | 构建时生成的逐文件 sha256 清单 |
| `src/`、`build.mjs`、`package.json` | 源码与构建脚本，仅在需要重新构建时使用（插件运行时不读取） |

## API

```js
const api = await loadCompressModule();          // 插件内部：<script> 懒加载
await api.load();                                 // 预加载 worker 与 wasm（幂等，永不 reject）
api.supported();                                  // { png, jpeg, webp } —— 初始化失败如实为 false
const r = await api.compress(blob, { level: 'balanced', allowFormatChange: true });
// r = { ok:true, blob, codec, mime, before, after, outputFormat, hasAlpha, formatChanged }
//   | { ok:false, reason: 'unsupported' | 'not-smaller' | 'format-change-disabled' | ... }
api.terminate();                                  // 释放 worker
```

- `level`：`'lossless'` | `'balanced'`（默认） | `'max'`。插件按钮用 `balanced`。
- 默认（`allowFormatChange` 缺省）**输入格式 == 输出格式**，绝不改 MIME。
- `allowFormatChange: true`（插件缓存压缩用）：
  - PNG **有透明像素** → 只走 oxipng，输出仍是 PNG（透明不会变黑）；
  - PNG **无透明像素** → **先跑便宜的 MozJPEG（q88 / 4:4:4 / progressive）**；若 JPEG 已压到原图的 40% 以下（即省 ≥60%）就直接采用并**跳过 oxipng**（无损重压缩不可能反超这一档），否则再跑 oxipng 取两者更小的。结果里的 `skippedPngOptimise: true` 表示走了这条捷径；
  - JPEG / WebP 输入行为不变；**永远不输出 WebP**（插件读取侧仍按 PNG/JPEG 处理）。
- GIF、APNG、动态 WebP、视频等一律 `{ ok:false, reason:'unsupported' }`；压不小返回 `not-smaller`。
- 所有编码在 Worker 内完成；`load()` 之前不创建 Worker、不下载任何 wasm。

## 集成方式

插件在首次点击「压缩加强」时才用一次性 `<script src="${extensionFolderPath}/compress/st-chatu8-compress.js">` 加载本模块。
资源目录解析顺序：`load({ base })` → `window.stChatu8CompressBase` → `document.currentScript.src` → 兜底相对路径。

wasm 一律 `fetch(url).arrayBuffer()` + `WebAssembly.instantiate()`，**不使用 `instantiateStreaming`**
（SillyTavern 静态服务不保证 `.wasm` 的 `Content-Type`；实测以 `application/octet-stream` 返回也能正常工作）。

## 重新构建

```bash
npm install          # 需要 @jsquash/{jpeg,oxipng,png,webp} 与 esbuild
node build.mjs       # 产物写入 ./dist/
# 把 dist/ 里的文件覆盖回本目录（st-chatu8-compress.js / worker.js / wasm/ / licenses/ / manifest.json→checksums.json）
```

## 提速（v1.1.0）

PNG→JPEG 路径改成"先跑便宜的、够好就跳过贵的"：

| 样本 | 旧（oxipng + MozJPEG 都跑） | 新（跳过 oxipng） | 输出字节 |
| --- | ---: | ---: | --- |
| illustration-1024.png（无 alpha） | ~1,495 ms | **269 ms**（5.6×） | 80,318 B（不变） |
| illustration-2048.png（无 alpha） | ~5,807 ms | **761 ms**（7.6×） | 255,448 B（不变） |
| illustration-alpha-1024.png（有 alpha） | 518 ms | 518 ms（不变，仍只走 oxipng） | 157,040 B（不变） |

画质与输出字节完全不变（仍是 q88 / 4:4:4 / progressive），只是省掉了那次"数学上不可能赢"的 oxipng。

## 实测（合成插画，Node 与 headless Chrome 双份数据）

| 输入 | 档位 | 原始 | 输出 | 节省 |
| --- | --- | ---: | ---: | ---: |
| PNG 1024²（无 alpha） | 保持 PNG | 1,258,077 | 1,004,122 | 20.2% |
| PNG 1024²（无 alpha） | 转 JPEG balanced | 1,258,077 | **80,318** | **93.6%** |
| PNG 2048²（无 alpha） | 转 JPEG balanced | 4,913,271 | **255,448** | **94.8%** |
| PNG 1024²（有 alpha） | 只 oxipng | 204,645 | 157,040 | 23.3% |
| JPEG 1024² | MozJPEG balanced | 189,777 | 43,216 | 77.2% |
| WebP 1024² | libwebp balanced | 209,360 | 19,312 | 90.8% |

主线程：压缩 2048² PNG 期间页面心跳最大间隔 3.4 ms、longtask 0 次（对照组故意阻塞 300 ms 会被抓到）。
`load()` 冷启动 50–72 ms；未点击按钮时 Worker 构造 0 次、wasm 请求 0 次。
## 提速的正确性守卫（v1.1.1）

跳过 oxipng 需要**同时**满足两个条件：

1. JPEG 已压到原图 **40%** 以下（要赢它，无损重压缩得再省掉一大半）；
2. 原 PNG **≥ 0.5 字节/像素**（"稠密图"——PNG 熵编码本就没优势、oxipng 通常只再省 10~30%）。

反例（实测）：1024² 平滑渐变 PNG（0.096 B/px），JPEG 28,987 B 却输给 oxipng 的 19,608 B，
所以低密度 PNG 一律照旧跑 oxipng 再比较。

## v1.2.0：并行 + 校验下沉 + 免拷贝 + 极速模式

### 新增选项（`compress(input, options)`）

| 选项 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `verify` | `'auto' \| true \| false` | `true` | `true`=一定校验；`'auto'`=**只在换格式时**校验；`false`=不校验 |
| `fast` | bool | `false` | 极速模式：PNG 一律不跑 oxipng（见下） |
| `concurrency` | number \| `'auto'` | `'auto'` | 并发上限；`'auto'` 由 `computeBaseSlots()` 决定 |

`input` 可以是 `Blob` / `ArrayBuffer` / `Uint8Array`（后两者直接 transfer，省一次拷贝）。
返回值新增 `bytes`（**输出字节本体，零拷贝，优先用它**）、`verified`、`fastMode`、`poolSize`、`dims`；
`blob` 改为惰性 getter（不访问就不产生拷贝，兼容旧调用方）。
新增失败 reason：`'verify-failed'`、`'fast-mode-skip'`。

### 池策略（自适应 + 内存预算背压）

```
base   = clamp(1, hardwareConcurrency - 1, 4)      // 桌面 16 线程 → 4
base   = 手机 ? min(base, 2) : base                 // 手机默认 2（大小核 / 发热 / 内存）
budget = 手机 ? 96MB : 256MB
cost   = 8 * width * height + inputBytes            // 尺寸从文件头解析，不解码
准入    = running < 并发上限 && (在飞字节 + cost <= budget || 当前空闲)
```

- 尺寸解析（PNG IHDR / JPEG SOF / WebP VP8·VP8L·VP8X）在 `src/sniff.js` 的 `imageDimensions()`。
- 单个 worker 初始化失败只缩小池，不影响其余；全部失败才返回 `codec-unavailable`。
- 建池请求串行化，避免并发首次调用各自建一池。

### 校验下沉

输出解码校验（`createImageBitmap`）从**主线程**移到 **worker 内部**：主线程不再为每张图解码，
既省掉 0.2~0.5s/张，也不再产生长任务。失败返回 `{ ok:false, reason:'verify-failed' }`，调用方按"跳过"处理。

### 极速模式 `fast: true`

| 输入 | 行为 |
| --- | --- |
| PNG 有透明像素（解码确认） | 不编码，`{ ok:false, reason:'fast-mode-skip' }`（原样保留） |
| PNG 无透明像素 | 只跑 MozJPEG；**永不跑 oxipng** |
| PNG 解码失败 | `fast-mode-skip`（保守） |
| level = `lossless` | **不转 JPEG**（无损优先的承诺不能被极速模式推翻）；此时极速模式对 PNG 等于「原样保留」 |
| JPEG / WebP | 与普通模式相同 |

只影响**尚未压缩过**的图片；已带 `compress` 标记的一律跳过（避免二次画质损失）。

### 实测并发扩展（本机 Ryzen 9 5900HX / 16 线程 / headless Chromium 143）

4 张 700² PNG（每张单 worker 约 559 ms）：

| 并发 | 总墙钟（3 次） | 实际并发峰值 | 相对串行 |
| --- | --- | --- | --- |
| 1（串行） | 2551 ms | 1 | 1.00× |
| 2 | 1776 / 1758 / 2184 / 1387 ms | 2 / 2 / 2 | **1.44×** |
| 4 | 958 / 826 / 1116 / 933 ms | 4 / 4 / 4 | **2.66×** |

并发不改变输出字节（差分测试逐字节比对通过）。手机端受大小核与发热限制，2 路预期 1.4~1.7×。