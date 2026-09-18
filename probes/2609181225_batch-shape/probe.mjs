// 问：MinerU v4「本地文件批量上传解析」一批多文件的真实形状——
//    1) 一个 batchId 带多个文件，extract_result 是不是每文件一条、file_urls 与 files 顺序对不对
//    2) 云端对一批内部是并行还是串行（各文件 running 窗口叠不叠、总墙钟 vs 已知逐篇串行）
//    3) 一批里混一个坏文件（随机字节 .pdf），其余文件活不活得成——部分失败形状，决定将来批量 API 的粒度
//    4) 各文件在 waiting-file / pending 里停多久——排队停留时长，决定要不要给排队态设独立上限
// 跑：先 $env:MINERU_TOKEN = '<token>'（不设就拒跑；输出里不打印 token）
//     node probe.mjs batch <runs前缀> <pdf> <pdf> …      一批多文件，顺序 PUT、5 秒一轮询、总上限 20 分钟
//     node probe.mjs poison <runs前缀> <好pdf> <好pdf>    自动生成坏文件夹在中间：好、坏、好
//     真扣 MinerU 额度。产出落 runs/<前缀>-timeline.txt 与 <前缀>-summary.txt
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const API_BASE = 'https://mineru.net/api/v4'
const POLL_INTERVAL_S = 5
const POLL_CAP_S = 20 * 60
const REQUEST_TIMEOUT_MS = 60_000
const UPLOAD_TIMEOUT_MS = 600_000
const QUEUE_STATES = new Set(['waiting-file', 'pending'])
const WORK_STATES = new Set(['running', 'converting'])
const TERMINAL_STATES = new Set(['done', 'failed'])
const RUNS = path.join(import.meta.dirname, 'runs')

const token = process.env.MINERU_TOKEN
if (!token) throw new Error('先设 MINERU_TOKEN（输出里不会打印它）')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ts = () => new Date().toISOString()

/** 读 JSON 回包取 data。业务错（code / msgCode 非 0）连码带 msg 抛出 */
async function readData(resp) {
  const text = await resp.text()
  let body
  try { body = JSON.parse(text) } catch { throw new Error(`HTTP ${resp.status} 非 JSON：${text.slice(0, 200)}`) }
  const code = body?.code ?? body?.msgCode
  if (resp.ok && code === 0) return body?.data ?? {}
  throw new Error(`HTTP ${resp.status} code=${String(code)} msg=${String(body?.msg)}：${text.slice(0, 300)}`)
}

/** 一批申请 N 个上传位。回 { batchId, urls }（urls 顺序对位 files） */
async function requestBatch(names) {
  const resp = await fetch(`${API_BASE}/file-urls/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model_version: 'vlm',
      enable_formula: true,
      enable_table: true,
      language: 'ch',
      files: names.map((name) => ({ name, is_ocr: false })),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const data = await readData(resp)
  if (typeof data.batch_id !== 'string' || !Array.isArray(data.file_urls) || data.file_urls.length !== names.length) {
    throw new Error(`回包形状不对：${JSON.stringify(data).slice(0, 300)}`)
  }
  return { batchId: data.batch_id, urls: data.file_urls }
}

/** PUT 一个文件到预签名 URL（不带 Content-Type，与件里一致）。回耗时秒 */
async function putFile(url, filePath) {
  const started = Date.now()
  const resp = await fetch(url, { method: 'PUT', body: await readFile(filePath), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`PUT ${path.basename(filePath)}：HTTP ${resp.status} ${resp.statusText}`)
  return (Date.now() - started) / 1000
}

/** 取一批的 extract_result：[{file_name, state, extract_progress, err_msg}] */
async function pollOnce(batchId) {
  const resp = await fetch(`${API_BASE}/extract-results/batch/${batchId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const data = await readData(resp)
  if (!Array.isArray(data.extract_result)) throw new Error(`轮询回包里没有 extract_result：${JSON.stringify(data).slice(0, 300)}`)
  return data.extract_result
}

/** 顺序 PUT + 轮询到全终态。写 timeline，回逐文件状态史与最终 extract_result */
async function runBatch(label, entries, timelinePath) {
  await appendFile(timelinePath, `# ${ts()}  ${label}：${entries.map((e) => `${e.name}<-${path.basename(e.pdf)}`).join('  ')}\n`)
  const startedAt = Date.now()
  const { batchId, urls } = await requestBatch(entries.map((e) => e.name))
  await appendFile(timelinePath, `# batchId ${batchId}\n`)

  for (let i = 0; i < entries.length; i++) {
    const secs = await putFile(urls[i], entries[i].pdf)
    await appendFile(timelinePath, `# PUT ${entries[i].name} 完成，耗时 ${secs.toFixed(1)}s（第 ${i + 1}/${entries.length} 个，顺序传）\n`)
  }

  /** name → [{t, state, pages}]，只记变化的拍 */
  const history = new Map(entries.map((e) => [e.name, []]))
  let final = []
  for (;;) {
    const rows = await pollOnce(batchId)
    final = rows
    const cols = []
    let working = 0
    for (const e of entries) {
      const row = rows.find((r) => r.file_name === e.name)
      if (row === undefined) { cols.push(`${e.name}:?`); continue }
      const pages = row.extract_progress ? `${row.extract_progress.extracted_pages}/${row.extract_progress.total_pages}` : ''
      cols.push(`${e.name}:${row.state}${pages && !TERMINAL_STATES.has(row.state) ? pages : ''}`)
      if (WORK_STATES.has(row.state)) working++
      const seen = history.get(e.name)
      const mark = `${row.state}:${pages}`
      if (seen.at(-1)?.mark !== mark) seen.push({ t: Date.now(), mark, state: row.state })
    }
    await appendFile(timelinePath, `${ts()} | ${cols.join(' | ')} | working=${working}\n`)
    const states = rows.map((r) => r.state)
    if (rows.length === entries.length && states.every((s) => TERMINAL_STATES.has(s))) break
    if ((Date.now() - startedAt) / 1000 > POLL_CAP_S) { await appendFile(timelinePath, `# 超过总上限 ${POLL_CAP_S}s，停\n`); break }
    await sleep(POLL_INTERVAL_S * 1000)
  }
  return { batchId, history, final, wallS: (Date.now() - startedAt) / 1000 }
}

/** 逐文件：排队停留（首见 → 首进干活态/终态）、干活窗口、终态与 err */
function analyze(result, entries) {
  const lines = [`# ${ts()}  汇总（总墙钟 ${result.wallS.toFixed(1)}s，含申请位与顺序 PUT）`]
  let maxWorking = 0
  for (const e of entries) {
    const seen = result.history.get(e.name) ?? []
    const first = seen[0]
    const firstWork = seen.find((h) => WORK_STATES.has(h.state))
    const terminal = seen.at(-1)
    const finalRow = result.final.find((r) => r.file_name === e.name)
    const queueS = first && firstWork ? (firstWork.t - first.t) / 1000 : terminal && first ? (terminal.t - first.t) / 1000 : -1
    const workS = firstWork && terminal ? (terminal.t - firstWork.t) / 1000 : -1
    lines.push(`${e.name}: 终态=${terminal?.state ?? '?'} 排队停留≈${queueS.toFixed(0)}s 干活≈${workS.toFixed(0)}s err=${finalRow?.err_msg ?? ''}`)
  }
  // 云端内部并行度：各文件「首进干活态 → 终态」窗口两两交叠的对数
  const windows = entries.map((e) => {
    const seen = result.history.get(e.name) ?? []
    const w = seen.find((h) => WORK_STATES.has(h.state))
    const t = seen.at(-1)
    return w && t ? [w.t, t.t] : null
  }).filter(Boolean)
  let overlapPairs = 0
  for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++) {
    const [a1, a2] = windows[i]; const [b1, b2] = windows[j]
    if (a1 < b2 && b1 < a2) overlapPairs++
  }
  lines.push(`干活窗口交叠的文件对数：${overlapPairs}/${windows.length > 1 ? (windows.length * (windows.length - 1)) / 2 : 0}（0 = 云端对这批也是逐个转）`)
  lines.push(`最终 extract_result：${JSON.stringify(result.final.map(({ full_zip_url, ...rest }) => ({ ...rest, zip: full_zip_url ? '有' : '无' })))}`)
  return lines.join('\n') + '\n'
}

const [mode, prefix, ...pdfs] = process.argv.slice(2)
if (!mode) throw new Error('用法：node probe.mjs batch|poison <runs前缀> <pdf…> | fetch <runs前缀> <batchId…>')
if (mode === 'fetch') {
  // 问：终态之后多久还查得回——resume 的成立前提（-60012 task not found or expire 说过期这回事，量真实窗口）
  await mkdir(RUNS, { recursive: true })
  const lines = [`# ${ts()}  查老批次：${pdfs.join(' ')}`]
  for (const batchId of pdfs) {
    try {
      const rows = await pollOnce(batchId)
      lines.push(`${batchId}：查得回——${JSON.stringify(rows.map((r) => ({ state: r.state, zip: r.full_zip_url ? '有' : '无', err: r.err_msg })))}`)
    } catch (err) {
      lines.push(`${batchId}：查不回——${String(err)}`)
    }
  }
  await writeFile(path.join(RUNS, `${prefix}-fetch.txt`), lines.join('\n') + '\n')
  console.log(lines.slice(1).join('\n'))
}
if (mode !== 'fetch') {
if (!prefix || pdfs.length === 0) throw new Error('用法：node probe.mjs batch|poison <runs前缀> <pdf…>')
await mkdir(RUNS, { recursive: true })
const timelinePath = path.join(RUNS, `${prefix}-timeline.txt`)
let entries
if (mode === 'batch') {
  entries = pdfs.map((pdf, i) => ({ name: `f${i + 1}-${path.basename(pdf)}`, pdf }))
} else if (mode === 'poison') {
  if (pdfs.length !== 2) throw new Error('poison 要正好两个好 pdf：好、坏、好')
  const corrupt = path.join(os.tmpdir(), `mineru-corrupt-${Date.now()}.pdf`)
  await writeFile(corrupt, randomBytes(64 * 1024))
  entries = [
    { name: `good1-${path.basename(pdfs[0])}`, pdf: pdfs[0] },
    { name: 'poison-random-bytes.pdf', pdf: corrupt },
    { name: `good2-${path.basename(pdfs[1])}`, pdf: pdfs[1] },
  ]
} else throw new Error(`不认识的模式：${mode}`)

const result = await runBatch(mode === 'poison' ? '部分失败批（中间混随机字节坏文件）' : '纯好文件批', entries, timelinePath)
await writeFile(path.join(RUNS, `${prefix}-summary.txt`), analyze(result, entries))
console.log(`总墙钟 ${result.wallS.toFixed(1)}s；细节见 runs/${prefix}-timeline.txt 与 ${prefix}-summary.txt`)
}
