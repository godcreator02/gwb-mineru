// 问：0.5.0 的数组 submit 在真机上成不成——
//    1) 一次交 3 篇，作业各自独立同时跑：抽样里「同时在跑」应到过 ≥2，最后 3 条全 done
//    2) 数组里混一个坏路径：整批当场拒（ok:false），账上不多不少没有半批
// 跑：node probe.mjs <pdf1> <pdf2> <pdf3>   —— home 跑着 0.5.0；真扣 MinerU 额度（3 × 页数）
// 产出落 runs/：01-timeline.txt（每秒抽样）、02-final.txt（三条终态）、03-reject.txt（坏路径回执）
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = 'mineru-2609172219'
const CDP = path.join(process.env.APPDATA, 'gwb-kernel', 'homes', 'default', 'node_modules', '@godcreator', 'gwb-devkit', 'bin', 'cdp.mjs')
const RUNS = path.join(import.meta.dirname, 'runs')
mkdirSync(RUNS, { recursive: true })
const TERMINAL = new Set(['done', 'failed', 'interrupted'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ts = () => new Date().toISOString()

const cmd = (command, args = {}) => {
  let out
  try {
    out = execFileSync('node', [CDP, HOME, 'cmd', command, JSON.stringify(args)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (err) {
    out = err.stdout ?? ''
  }
  if (out === '') throw new Error(`cdp 没回东西：${command}`)
  return JSON.parse(out)['回执']
}

const pdfs = process.argv.slice(2)
if (pdfs.length !== 3) throw new Error('node probe.mjs <pdf1> <pdf2> <pdf3>')
const outRoot = mkdtempSync(path.join(os.tmpdir(), 'mineru-parallel-'))
const files = pdfs.map((pdf, i) => ({ input: pdf, outDir: path.join(outRoot, `f${i + 1}`) }))

const before = cmd('pdf2md.jobs').data.count
const submitted = cmd('pdf2md.submit', { files })
if (!submitted.ok) throw new Error(`submit 失败：${submitted.error}`)
const ids = submitted.data.map((j) => j.id)
const timeline = path.join(RUNS, '01-timeline.txt')
writeFileSync(timeline, `# ${ts()}  数组交 3 篇：${ids.join(' ')}（交前账上 ${String(before)} 条）\n# 每行：采样时刻 | 各作业状态 | 同时在跑（uploading/running）的个数\n`)

let maxActive = 0
for (;;) {
  const jobs = cmd('pdf2md.jobs').data.jobs.filter((j) => ids.includes(j.id))
  const states = ids.map((id) => jobs.find((j) => j.id === id)?.state ?? '?')
  const active = states.filter((s) => s === 'uploading' || s === 'running').length
  maxActive = Math.max(maxActive, active)
  appendFileSync(timeline, `${ts()} | ${states.join(' ')} | ${String(active)}\n`)
  if (states.every((s) => TERMINAL.has(s))) break
  await sleep(1000)
}
const finalJobs = cmd('pdf2md.jobs').data.jobs.filter((j) => ids.includes(j.id))
writeFileSync(path.join(RUNS, '02-final.txt'), `# ${ts()}  三条终态（同时在跑峰值 ${String(maxActive)}）\n${JSON.stringify(finalJobs, null, 2)}\n`)
appendFileSync(timeline, `# 同时在跑峰值：${String(maxActive)}\n`)

// 坏路径混进数组：整批拒，账不多
const countBefore = cmd('pdf2md.jobs').data.count
const rejected = cmd('pdf2md.submit', { files: [{ input: 'D:/没有这个文件.pdf', outDir: path.join(outRoot, 'bad') }, { input: pdfs[0], outDir: path.join(outRoot, 'good') }] })
const countAfter = cmd('pdf2md.jobs').data.count
const lines = [
  `# ${ts()}  数组里混坏路径`,
  `回执 ok:${String(rejected.ok)}${rejected.ok ? '' : ` error:${rejected.error}`}`,
  `账上条数 前${String(countBefore)} 后${String(countAfter)}（应相等）`,
]
writeFileSync(path.join(RUNS, '03-reject.txt'), lines.join('\n') + '\n')
console.log(lines.join('\n'))
console.log(`终态：${finalJobs.map((j) => j.state).join(' ')}；同时在跑峰值 ${String(maxActive)}`)
