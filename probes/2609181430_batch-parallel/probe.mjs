// 问：MinerU 的批与并行到底什么逻辑——为 0.5.0「submit 收数组、批作传输层、尽可能并行」定案
//    A) 批内并行度：一批 5 篇，云端是同时转还是排队转（各文件 running 窗口叠不叠、总墙钟 vs 单篇）
//    B) 批间并行：两个 batch 同时报名、上传共用一条全局道（一个传完传下一个），全不全过、两批时间线怎么交
//    C) 并发 PUT 复现：5 个单文件批并发报名并发 PUT——0.3.0 那场 fetch failed 事故的原始形状，验根因
// 跑：$env:MINERU_TOKEN = '<token>' 后
//   node probe.mjs one   <runs前缀> <pdf×5>                一批多文件，顺序 PUT，一个轮询循环
//   node probe.mjs two   <runs前缀> <pdf×3> -- <pdf×3>      两批并发，各报名各轮询，PUT 全上全局道
//   node probe.mjs burst <runs前缀> <pdf×5>                 5 个单文件批全并发（报名+PUT+轮询各跑各的）
//   真扣 MinerU 额度（A、B 用没转过的论文；C 复用 A 的——它测网络层，缓存不影响 PUT）。产出落 runs/。
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const API_BASE = 'https://mineru.net/api/v4'
const POLL_INTERVAL_S = 5
const POLL_CAP_S = 20 * 60
const REQUEST_TIMEOUT_MS = 60_000
const UPLOAD_TIMEOUT_MS = 600_000
const WORK_STATES = new Set(['running', 'converting'])
const TERMINAL_STATES = new Set(['done', 'failed'])
const RUNS = path.join(import.meta.dirname, 'runs')

const token = process.env.MINERU_TOKEN
if (!token) throw new Error('先设 MINERU_TOKEN（输出里不打印它）')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ts = () => new Date().toISOString()

async function readData(resp) {
  const text = await resp.text()
  let body
  try { body = JSON.parse(text) } catch { throw new Error(`HTTP ${resp.status} 非 JSON：${text.slice(0, 200)}`) }
  const code = body?.code ?? body?.msgCode
  if (resp.ok && code === 0) return body?.data ?? {}
  throw new Error(`HTTP ${resp.status} code=${String(code)} msg=${String(body?.msg)}：${text.slice(0, 300)}`)
}

async function requestBatch(names) {
  const resp = await fetch(`${API_BASE}/file-urls/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model_version: 'vlm', enable_formula: true, enable_table: true, language: 'ch', files: names.map((name) => ({ name, is_ocr: false })) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const data = await readData(resp)
  if (typeof data.batch_id !== 'string' || !Array.isArray(data.file_urls) || data.file_urls.length !== names.length) {
    throw new Error(`回包形状不对：${JSON.stringify(data).slice(0, 300)}`)
  }
  return { batchId: data.batch_id, urls: data.file_urls }
}

async function putFile(url, filePath) {
  const started = Date.now()
  const resp = await fetch(url, { method: 'PUT', body: await readFile(filePath), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`PUT ${path.basename(filePath)}：HTTP ${resp.status} ${resp.statusText}`)
  return (Date.now() - started) / 1000
}

async function pollOnce(batchId) {
  const resp = await fetch(`${API_BASE}/extract-results/batch/${batchId}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const data = await readData(resp)
  if (!Array.isArray(data.extract_result)) throw new Error(`轮询回包里没有 extract_result：${JSON.stringify(data).slice(0, 300)}`)
  return data.extract_result
}

/** 一个批的轮询循环：5 秒一问，记每文件状态史，全终态收工。写 timeline，回历史与最终回包 */
async function pollBatch(label, batchId, names, timelinePath) {
  await appendFile(timelinePath, `# ${ts()}  ${label} 批 ${batchId} 开始轮询：${names.join('  ')}\n`)
  const startedAt = Date.now()
  const history = new Map(names.map((n) => [n, []]))
  let final = []
  for (;;) {
    const rows = await pollOnce(batchId)
    final = rows
    const cols = []
    for (const name of names) {
      const row = rows.find((r) => r.file_name === name)
      if (row === undefined) { cols.push(`${name}:?`); continue }
      const pages = row.extract_progress ? `${row.extract_progress.extracted_pages}/${row.extract_progress.total_pages}` : ''
      cols.push(`${name}:${row.state}${pages && !TERMINAL_STATES.has(row.state) ? pages : ''}`)
      const seen = history.get(name)
      const mark = `${row.state}:${pages}`
      if (seen.at(-1)?.mark !== mark) seen.push({ t: Date.now(), mark, state: row.state })
    }
    await appendFile(timelinePath, `${ts()} | ${cols.join(' | ')}\n`)
    const states = rows.map((r) => r.state)
    if (rows.length === names.length && states.every((s) => TERMINAL_STATES.has(s))) break
    if ((Date.now() - startedAt) / 1000 > POLL_CAP_S) { await appendFile(timelinePath, `# 超过总上限 ${POLL_CAP_S}s，停\n`); break }
    await sleep(POLL_INTERVAL_S * 1000)
  }
  return { history, final, wallS: (Date.now() - startedAt) / 1000 }
}

function summarize(result, names) {
  const lines = [`# ${ts()}  汇总（轮询墙钟 ${result.wallS.toFixed(1)}s）`]
  const windows = []
  for (const name of names) {
    const seen = result.history.get(name) ?? []
    const first = seen[0]
    const firstWork = seen.find((h) => WORK_STATES.has(h.state))
    const terminal = seen.at(-1)
    const finalRow = result.final.find((r) => r.file_name === name)
    const queueS = first && firstWork ? (firstWork.t - first.t) / 1000 : terminal && first ? (terminal.t - first.t) / 1000 : -1
    const workS = firstWork && terminal ? (terminal.t - firstWork.t) / 1000 : -1
    if (firstWork && terminal) windows.push([firstWork.t, terminal.t, name])
    lines.push(`${name}: 终态=${terminal?.state ?? '?'} 排队≈${queueS.toFixed(0)}s 干活≈${workS.toFixed(0)}s err=${finalRow?.err_msg ?? ''}`)
  }
  let overlapPairs = 0
  for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++) {
    if (windows[i][0] < windows[j][1] && windows[j][0] < windows[i][1]) overlapPairs++
  }
  lines.push(`干活窗口交叠对数：${overlapPairs}/${windows.length > 1 ? (windows.length * (windows.length - 1)) / 2 : 0}（>0 = 云端批内确实并行）`)
  return lines.join('\n')
}

/** C：一条并发车道——报名、PUT、轮询各跑各的，错误连 cause 记下来 */
async function burstLane(idx, pdf, timelinePath) {
  const name = `f${idx}-${path.basename(pdf)}`
  try {
    const { batchId, urls } = await requestBatch([name])
    const putS = await putFile(urls[0], pdf)
    const rows = await pollOnce(batchId)
    for (;;) {
      const fresh = await pollOnce(batchId)
      const row = fresh.find((r) => r.file_name === name)
      if (row !== undefined && TERMINAL_STATES.has(row.state)) {
        await appendFile(timelinePath, `${ts()} | ${name}: PUT ${putS.toFixed(1)}s → ${row.state}${row.err_msg ? `（${row.err_msg}）` : ''}\n`)
        return `${name}: ${row.state}`
      }
      await sleep(POLL_INTERVAL_S * 1000)
    }
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? ` cause:${String(err.cause)}` : ''
    await appendFile(timelinePath, `${ts()} | ${name}: 炸了 ${String(err)}${cause}\n`)
    return `${name}: FAILED ${String(err).slice(0, 120)}${cause}`
  }
}

const [mode, prefix, ...argv] = process.argv.slice(2)
if (!mode || !prefix) throw new Error('用法：node probe.mjs one|two|burst <runs前缀> <pdf…>')
await mkdir(RUNS, { recursive: true })

if (mode === 'one' || mode === 'two') {
  const groups = mode === 'one' ? [argv] : (() => {
    const cut = argv.indexOf('--')
    if (cut < 1) throw new Error('two 要两组 pdf，中间用 -- 隔开')
    return [argv.slice(0, cut), argv.slice(cut + 1)]
  })()
  const t0 = Date.now()
  const batches = []
  // 两批同时报名（报名并发没前科）；C 阶段才是并发 PUT 的对照组
  for (let g = 0; g < groups.length; g++) {
    batches.push({ names: groups[g].map((pdf, i) => `b${g + 1}f${i + 1}-${path.basename(pdf)}`), pdfs: groups[g] })
  }
  const allocated = []
  for (const b of batches) allocated.push(await requestBatch(b.names))
  // 全局上传道：所有批的 PUT 排同一条链，一个传完传下一个
  const timelinePath = path.join(RUNS, `${prefix}-timeline.txt`)
  await appendFile(timelinePath, `# ${ts()}  ${mode === 'two' ? '两批并发' : '一批'}：${batches.map((b, i) => `批${i + 1}[${b.names.join(',')}]`).join(' + ')}\n`)
  let lane = Promise.resolve()
  for (let g = 0; g < batches.length; g++) {
    for (let i = 0; i < batches[g].pdfs.length; i++) {
      const url = allocated[g].urls[i]
      const pdf = batches[g].pdfs[i]
      const name = batches[g].names[i]
      lane = lane.then(async () => {
        const s = await putFile(url, pdf)
        await appendFile(timelinePath, `# ${ts()}  PUT ${name} 完成 ${s.toFixed(1)}s（全局道）\n`)
      })
    }
  }
  await lane
  const polls = batches.map((b, g) => pollBatch(`批${g + 1}`, allocated[g].batchId, b.names, timelinePath))
  const results = await Promise.all(polls)
  const summary = [`# ${ts()}  总墙钟（报名+全部 PUT+全部终态）${((Date.now() - t0) / 1000).toFixed(1)}s`]
  results.forEach((r, g) => { summary.push(`## 批${g + 1}`); summary.push(summarize(r, batches[g].names)) })
  await writeFile(path.join(RUNS, `${prefix}-summary.txt`), summary.join('\n') + '\n')
  console.log(summary.join('\n'))
} else if (mode === 'burst') {
  if (argv.length < 2) throw new Error('burst 要至少两个 pdf')
  const timelinePath = path.join(RUNS, `${prefix}-timeline.txt`)
  await appendFile(timelinePath, `# ${ts()}  并发 ${String(argv.length)} 路：报名、PUT、轮询各跑各的（0.3.0 事故的原始形状）\n`)
  const outcomes = await Promise.all(argv.map((pdf, i) => burstLane(i + 1, pdf, timelinePath)))
  const ok = outcomes.filter((o) => o.endsWith('done')).length
  const lines = [`# ${ts()}  ${ok}/${String(argv.length)} done`, ...outcomes]
  await writeFile(path.join(RUNS, `${prefix}-summary.txt`), lines.join('\n') + '\n')
  console.log(lines.join('\n'))
} else throw new Error(`不认识的模式：${mode}`)
