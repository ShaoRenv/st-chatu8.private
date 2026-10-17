// st-chatu8-compress 构建脚本：esbuild 打 IIFE + 拷贝 wasm 到 dist/wasm/
import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const wasmOut = path.join(dist, 'wasm');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const BANNER = `/*! st-chatu8-compress v${pkg.version} | WASM 图像压缩模块（PNG/JPEG/WebP）
 * 本地计算，不联网。第三方编码器许可见 THIRD-PARTY-LICENSES.md
 * codecs: oxipng (MIT) / MozJPEG (IJG+BSD-style) / libwebp (BSD-3-Clause)
 */`;

// wasm 源文件 → dist 目标名（与 src/codec.js 的 WASM_FILES 一一对应）
const WASM = [
  ['node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm', 'mozjpeg_enc.wasm'],
  ['node_modules/@jsquash/webp/codec/enc/webp_enc.wasm', 'webp_enc.wasm'],
  ['node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm', 'webp_enc_simd.wasm'],
  ['node_modules/@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm', 'squoosh_oxipng_bg.wasm'],
];

// 随产物分发上游许可证原文（BSD/MIT 要求二进制分发保留版权与许可声明）
const LICENSES = [
  ['node_modules/@jsquash/oxipng/codec/LICENSE.codec.md', 'oxipng-MIT.txt'],
  ['node_modules/@jsquash/webp/codec/LICENSE.codec.md', 'libwebp-BSD-3-Clause.txt'],
  ['node_modules/@jsquash/jpeg/codec/LICENSE.codec.md', 'mozjpeg-libjpeg-turbo.txt'],
  ['node_modules/@jsquash/jpeg/LICENSE', 'jsquash-Apache-2.0.txt'],
  ['node_modules/wasm-feature-detect/LICENSE', 'wasm-feature-detect-Apache-2.0.txt'],
];

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100', 'edge100', 'safari16', 'firefox110'],
  charset: 'utf8',
  legalComments: 'none',
  minify: false,
  sourcemap: false,
  banner: { js: BANNER },
  logLevel: 'warning',
  define: {
    // esbuild 打包时把 import.meta.url 固定住（IIFE 里没有它；wasm 路径一律由 locateFile 提供）
    'import.meta.url': '"about:blank"',
    // 硬性要求：绝不使用 instantiateStreaming（SillyTavern 不保证 .wasm 的 Content-Type）。
    // 置为 undefined 后，esbuild 会把第三方胶水里所有 WebAssembly.instantiateStreaming
    // （含 wasm-bindgen 的 Response 分支）替换掉，产物在源码层面就不再依赖流式实例化。
    'WebAssembly.instantiateStreaming': 'undefined',
  },
  supported: { 'top-level-await': false },
};

async function main() {
  await mkdir(wasmOut, { recursive: true });

  const api = await build({
    ...common,
    entryPoints: [path.join(root, 'src/api.js')],
    outfile: path.join(dist, 'st-chatu8-compress.js'),
    minify: false,
  });
  const worker = await build({
    ...common,
    entryPoints: [path.join(root, 'src/worker.js')],
    outfile: path.join(dist, 'worker.js'),
    minify: false,
  });

  for (const [from, name] of WASM) {
    await copyFile(path.join(root, from), path.join(wasmOut, name));
  }

  const licenseOut = path.join(dist, 'licenses');
  await mkdir(licenseOut, { recursive: true });
  for (const [from, name] of LICENSES) {
    await copyFile(path.join(root, from), path.join(licenseOut, name));
  }

  const targets = [
    'st-chatu8-compress.js',
    'worker.js',
    ...WASM.map(([, n]) => path.join('wasm', n)),
    ...LICENSES.map(([, n]) => path.join('licenses', n)),
  ];
  const manifest = { version: pkg.version, builtAt: new Date().toISOString(), files: [] };
  for (const rel of targets) {
    const abs = path.join(dist, rel);
    const buf = await readFile(abs);
    describe(rel, buf.length);
    manifest.files.push({ path: rel.split(path.sep).join('/'), bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
  }
  await writeFile(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('build ok →', dist);
  void api; void worker; void stat;
}

function describe(rel, bytes) {
  console.log('  ' + rel.split(path.sep).join('/').padEnd(30) + String(bytes).padStart(9) + ' B');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
