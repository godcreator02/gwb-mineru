import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * node 侧构建：esbuild 把 adm-zip 打包进产物，构建产物里的包名 import 只剩 node 内置模块与 cordis（宿主提供，外置）。
 * 三个入口各出一个文件（dist/index.js 是插件入口，dist/core/*.js 给 tests/ 单独 import），共用的代码拆进 dist/chunks/，
 * 所以同一个类在两个入口里是同一份。类型声明由 tsc 在这之后单独输出（tsconfig.build.json）。
 */
const here = path.dirname(fileURLToPath(import.meta.url))

// chunk 文件名带哈希，上一次构建留下的旧 chunk 会随 files 白名单一起发出去，先清空
fs.rmSync(path.join(here, 'dist'), { recursive: true, force: true })

await build({
  entryPoints: ['src/index.ts', 'src/core/extract.ts', 'src/core/mineru.ts'],
  outdir: 'dist',
  outbase: 'src',
  chunkNames: 'chunks/[name]-[hash]',
  splitting: true,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['cordis'],
  // adm-zip 是 CommonJS，里面 require 了 node 内置模块；ESM 产物里没有 require，由这一行补上
  banner: { js: "import { createRequire as createRequireForBundledCommonJs } from 'node:module'\nconst require = createRequireForBundledCommonJs(import.meta.url)" },
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  absWorkingDir: here,
})

console.log('[gwb-mineru] dist/index.js、dist/core/*.js ← src/（adm-zip 已打包）')
