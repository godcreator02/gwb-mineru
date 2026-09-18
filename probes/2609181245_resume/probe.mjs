// 问：0.4.0 的 resume 在真机上成不成——
//    1) failed 且 uploaded 的作业，resume 后凭原 batchId 取回云端结果翻 done，不重花额度（batchId 不变）
//    2) 账上落盘的重启对账之后（home 重启过）resume 仍然成立
//    3) 挡得住不该续的：done 的、没 uploaded 的（0.3.x 老账）都给一句照着能做的话
// 跑（分段，配合 home 停起）：
//   node probe.mjs submit <pdf绝对路径>            —— home 跑着；真扣一次额度，等 done 落 runs/01
//   （停 home：taskkill home 的 pid；再起：GWB_HOME=mineru-2609172219 带 --remote-debugging-port=9405）
//   node probe.mjs ledger-fail <jobId>             —— home 停着；把账上这条改成 failed（演练超时结算）
//   node probe.mjs resume <jobId>                  —— home 重启后；resume 并等到终态落 runs/03
//   node probe.mjs reject <jobId…>                 —— 对不该续的作业试 resume，落 runs/04
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const HOME = 'mineru-2609172219'
const CDP = path.join(process.env.APPDATA, 'gwb-kernel', 'homes', 'default', 'node_modules', '@godcreator', 'gwb-devkit', 'bin', 'cdp.mjs')
const LEDGER = path.join(process.env.APPDATA, 'gwb-kernel', 'homes', HOME, 'data', 'mineru', 'jobs.json')
const RUNS = path.join(import.meta.dirname, 'runs')
const TERMINAL = new Set(['done', 'failed', 'interrupted'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ts = () => new Date().toISOString()

const cmd = (command, args = {}) => {
  // cdp 对回执 ok:false 的命令退非零——reject 那组要的就是失败回执，接住不炸
  let out
  try {
    out = execFileSync('node', [CDP, HOME, 'cmd', command, JSON.stringify(args)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (err) {
    out = err.stdout ?? ''
  }
  if (out === '') throw new Error(`cdp 没回东西：${command}`)
  return { out, receipt: JSON.parse(out)['回执'] }
}
const jobOf = (id) => cmd('pdf2md.jobs').receipt.data.jobs.find((j) => j.id === id)
const waitTerminal = async (id) => {
  for (;;) {
    const job = jobOf(id)
    if (job !== undefined && TERMINAL.has(job.state)) return job
    await sleep(3000)
  }
}

const [mode, ...rest] = process.argv.slice(2)
await mkdir(RUNS, { recursive: true })

if (mode === 'submit') {
  const outDir = path.join(process.env.TEMP ?? '/tmp', `mineru-resume-${Date.now()}`)
  const { receipt } = cmd('pdf2md.submit', { input: rest[0], outDir })
  if (!receipt.ok) throw new Error(`submit 失败：${receipt.error}`)
  const id = receipt.data.id
  const done = await waitTerminal(id)
  if (done.state !== 'done') throw new Error(`没跑成：${JSON.stringify(done)}`)
  await writeFile(path.join(RUNS, '01-submit-done.txt'), `# ${ts()}  submit 后跑到 done\n${JSON.stringify(done, null, 2)}\n`)
  console.log(`done：${id}（batchId ${done.batchId}，uploaded ${String(done.uploaded)}）—— 停 home 后跑 ledger-fail ${id}`)
} else if (mode === 'ledger-fail') {
  const [, doc] = [null, JSON.parse(await readFile(LEDGER, 'utf8'))]
  const job = doc.jobs.find((j) => j.id === rest[0])
  if (job === undefined) throw new Error(`账上没有 ${rest[0]}`)
  await writeFile(path.join(RUNS, '02-before-fail.txt'), `# ${ts()}  改账前\n${JSON.stringify(job, null, 2)}\n`)
  const poisoned = { ...job, state: 'failed', error: '轮询超时：3600s 内没解析完（演练：云端可能还在跑，只是没人再取结果）' }
  for (const key of ['markdown', 'lang', 'files', 'progress']) delete poisoned[key]
  doc.jobs = doc.jobs.map((j) => (j.id === job.id ? poisoned : j))
  await writeFile(LEDGER, JSON.stringify(doc, null, 2))
  console.log(`账上 ${job.id} 已演练成 failed（batchId 与 uploaded 保留）—— 重启 home 后跑 resume ${job.id}`)
} else if (mode === 'resume') {
  const { receipt } = cmd('pdf2md.resume', { id: rest[0] })
  if (!receipt.ok) throw new Error(`resume 被拒：${receipt.error}`)
  const settled = await waitTerminal(rest[0])
  await writeFile(path.join(RUNS, '03-resume.txt'), `# ${ts()}  resume 回执\n${JSON.stringify(receipt, null, 2)}\n# 等到的终态\n${JSON.stringify(settled, null, 2)}\n`)
  console.log(`resume 后终态：${settled.state}（batchId ${settled.batchId}，markdown ${settled.markdown ?? '-'}）`)
} else if (mode === 'reject') {
  const lines = [`# ${ts()}  对不该续的作业喊 resume`]
  for (const id of rest) {
    const { receipt } = cmd('pdf2md.resume', { id })
    lines.push(`${id} → ok:${String(receipt.ok)}${receipt.ok ? '' : ` error:${receipt.error}`}`)
  }
  await writeFile(path.join(RUNS, '04-rejects.txt'), lines.join('\n') + '\n')
  console.log(lines.slice(1).join('\n'))
} else {
  throw new Error('用法：node probe.mjs submit <pdf> | ledger-fail <id> | resume <id> | reject <id…>')
}
