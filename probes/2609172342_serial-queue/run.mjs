// 问：0.3.0 的作业机是不是真串行——同时交 3 个作业，任何时刻最多一个不在 queued / 终态；3 个都 done
// 跑：node run.mjs <隔离 home 名> <一份小 PDF 的绝对路径>   —— 那个 home 里装着 gwb-mineru 且 token 已配；真扣 MinerU 额度（3 × 页数）
// 产出落系统临时目录；每秒一次 pdf2md.jobs 的抽样落 runs/01-timeline.txt，最后的作业账落 runs/02-jobs.txt

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [home, pdf] = process.argv.slice(2)
if (!home || !pdf) throw new Error('node run.mjs <home> <pdf 绝对路径>')
const CDP = path.join(process.env.APPDATA, 'gwb-kernel', 'homes', 'default', 'node_modules', '@godcreator', 'gwb-devkit', 'bin', 'cdp.mjs')
const RUNS = path.join(import.meta.dirname, 'runs')
mkdirSync(RUNS, { recursive: true })
const timeline = path.join(RUNS, '01-timeline.txt')

const cmd = (command, args = {}) => {
  const out = execFileSync('node', [CDP, home, 'cmd', command, JSON.stringify(args)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return { out, receipt: JSON.parse(out)['回执'] }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const outRoot = mkdtempSync(path.join(os.tmpdir(), 'mineru-serial-'))
const ids = []
for (const n of [1, 2, 3]) {
  const { receipt } = cmd('pdf2md.submit', { input: pdf, outDir: path.join(outRoot, `job${n}`) })
  if (!receipt.ok) throw new Error(`submit 失败：${receipt.error}`)
  ids.push(receipt.data.id)
}
writeFileSync(timeline, `# ${new Date().toISOString()}  交了 3 个作业：${ids.join(' ')}  输入 ${pdf}\n# 每行：采样时刻 | 各作业状态 | 同时在跑（非 queued 非终态）的个数\n`)

const TERMINAL = new Set(['done', 'failed', 'interrupted'])
let maxActive = 0
for (;;) {
  const { receipt } = cmd('pdf2md.jobs')
  const jobs = receipt.data.jobs.filter((j) => ids.includes(j.id))
  const states = ids.map((id) => jobs.find((j) => j.id === id)?.state ?? '?')
  const active = states.filter((s) => s !== 'queued' && !TERMINAL.has(s)).length
  maxActive = Math.max(maxActive, active)
  appendFileSync(timeline, `${new Date().toISOString()} | ${states.join(' ')} | ${active}\n`)
  if (states.every((s) => TERMINAL.has(s))) break
  await sleep(1000)
}
const { out } = cmd('pdf2md.jobs')
writeFileSync(path.join(RUNS, '02-jobs.txt'), `# ${new Date().toISOString()}  pdf2md.jobs\n${out}`)
appendFileSync(timeline, `# 最多同时在跑：${maxActive}\n`)
console.log(`最多同时在跑 ${maxActive} 个；时间线见 runs/01-timeline.txt`)
