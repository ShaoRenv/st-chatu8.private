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
  - PNG **无透明像素** → oxipng 与 MozJPEG（q88 / 4:4:4 / progressive）各算一遍，取更小的，`mime` 如实返回；
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
