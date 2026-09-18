/**
 * MinerU 云端 API 客户端（单文件形态）：申请上传位、上传、轮询解析结果。
 *
 * 接口规格对位 mineru.net 精准解析 API v4 的「本地文件批量上传解析」那一组：HTTP 层异常如实抛出，
 * 由作业机收进 job 的 error——不在这吞。
 *
 * 那组接口是「一批多文件」，这个件一作业一文件：数组长度恒为 1，语义不变。
 */

import { readFile } from 'node:fs/promises'

const API_BASE = 'https://mineru.net/api/v4'

/** 云端单文件上限 200MB（另有 200 页上限——页数要解 PDF 才知道，本地只挡大小） */
export const MAX_FILE_BYTES = 200 * 1024 * 1024

/** 解析任务的终态，到达任一即不再变化 */
const TERMINAL_STATES = new Set(['done', 'failed'])

/** 云端正在干活的状态——只有这两态会判停滞；排队（waiting-file / pending）不判 */
const WORKING_STATES = new Set(['running', 'converting'])

const REQUEST_TIMEOUT_MS = 60 * 1000
const UPLOAD_TIMEOUT_MS = 600 * 1000

const TOKEN_HINT = 'token 无效或过期：去 mineru.net 的 API 管理页换一个，再 settings.set { section: "mineru", key: "token", value: "…" }'

/** 业务错误码 → 调用方照着就能做的那句话。没列的只报 code 与 msg */
const HINTS: Readonly<Record<string, string>> = {
  A0202: TOKEN_HINT,
  A0211: TOKEN_HINT,
  '-60005': '文件超过 200MB，拆小了再提',
  '-60006': '文件超过 200 页，拆成几份再提',
  '-60018': '今天的解析任务数到上限了，明天再提',
  // 任务留存有时限（实测 ≥14h 还查得回，见 probes/2609181225_batch-shape），过期后续取也取不回
  '-60012': '云端任务已过期，续取不回——重新提交，重花一次额度是唯一路径',
}

/** MinerU 回业务错误（回包 code / msgCode 非 0）或回包形状不对时抛 */
export class MineruError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MineruError'
  }
}

/** 解析中的进度，云端只在 running 时给。字段名对位 API 原始 JSON 键，不改写 */
export interface ExtractProgress {
  readonly extracted_pages: number
  readonly total_pages: number
}

/** 单文件的解析结果。字段名对位 API 原始 JSON 键，不改写 */
export interface FileResult {
  readonly file_name: string
  readonly state: string
  readonly full_zip_url: string | null
  readonly err_msg: string | null
  readonly extract_progress: ExtractProgress | null
}

export function isDone(result: FileResult): boolean {
  return result.state === 'done'
}

/** 申请一个上传位。回 [batch_id, upload_url] */
export async function requestUpload(token: string, name: string): Promise<[string, string]> {
  const resp = await fetch(`${API_BASE}/file-urls/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model_version: 'vlm',
      enable_formula: true,
      enable_table: true,
      // ch 是云端缺省：中英混合
      language: 'ch',
      files: [{ name, is_ocr: false }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const data = await readData(resp)
  const batchId = data['batch_id']
  const urls = data['file_urls']
  if (typeof batchId !== 'string' || !Array.isArray(urls) || typeof urls[0] !== 'string') {
    throw new MineruError('申请上传位的回包形状不对（缺 batch_id 或 file_urls）')
  }
  return [batchId, urls[0]]
}

/** 把 PDF 二进制 PUT 到预签名 URL（不带 Content-Type，见接口规格） */
export async function upload(uploadUrl: string, pdfPath: string): Promise<void> {
  const resp = await fetch(uploadUrl, {
    method: 'PUT',
    body: await readFile(pdfPath),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })
  if (!resp.ok) throw new Error(`HTTP ${String(resp.status)} ${resp.statusText}`)
}

export interface PollOptions {
  /** 两次轮询的间隔，秒 */
  readonly interval: number
  /** 云端干活时（running / converting）状态与已解析页数都不动的上限，秒 */
  readonly stallTimeout: number
  /** 从开始轮询算起的总上限（含排队），秒 */
  readonly timeout: number
  /** 每拿到一个非终态回包调一次——作业机拿它记进度 */
  readonly onProgress: (result: FileResult) => void
  /** 作业被收走（件卸载）时先让它醒，别等满一轮间隔 */
  readonly signal: AbortSignal
}

/** 轮询到终态。被打断抛 AbortError；停滞或超总上限结算为 failed（err_msg 说明是哪一种） */
export async function poll(token: string, batchId: string, options: PollOptions): Promise<FileResult> {
  const headers = { Authorization: `Bearer ${token}` }
  const url = `${API_BASE}/extract-results/batch/${batchId}`
  const startedAt = Date.now()
  let mark = ''
  let markedAt = startedAt
  for (;;) {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const data = await readData(resp)
    const rawResults = data['extract_result']
    if (!Array.isArray(rawResults) || rawResults.length === 0) {
      throw new MineruError('轮询回包里没有 extract_result')
    }
    const result = toResult(rawResults[0])
    if (TERMINAL_STATES.has(result.state)) return result
    options.onProgress(result)

    const now = Date.now()
    const nextMark = `${result.state}:${String(result.extract_progress?.extracted_pages ?? '')}`
    if (nextMark !== mark) {
      mark = nextMark
      markedAt = now
    } else if (WORKING_STATES.has(result.state) && now - markedAt >= options.stallTimeout * 1000) {
      return giveUp(result, `云端解析停滞：${String(options.stallTimeout)}s 内状态与已解析页数都没动`)
    }
    if (now - startedAt >= options.timeout * 1000) {
      return giveUp(result, `轮询超时：${String(options.timeout)}s 内没解析完`)
    }
    await sleep(options.interval * 1000, options.signal)
  }
}

function giveUp(result: FileResult, reason: string): FileResult {
  return { ...result, state: 'failed', full_zip_url: null, err_msg: `${reason}（云端可能还在跑，只是没人再取结果）` }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason instanceof Error ? signal.reason : new Error('作业被打断'))
      },
      { once: true },
    )
  })
}

/**
 * 读 JSON 回包取 data。业务错抛 MineruError——token 错走 HTTP 401、键叫 msgCode 不叫 code，
 * 所以先认回包再认状态码；认不出回包的非 2xx 抛 HTTP 错
 */
async function readData(resp: Response): Promise<Record<string, unknown>> {
  const text = await resp.text()
  const body = parseRecord(text)
  const code = body?.['code'] ?? body?.['msgCode']
  if (resp.ok && code === 0) return asRecord(body?.['data']) ?? {}
  if (code !== undefined && code !== 0) {
    const hint = HINTS[String(code)]
    const msg = typeof body?.['msg'] === 'string' ? body['msg'] : ''
    throw new MineruError(`MinerU 返回错误：code=${String(code)} msg=${msg}${hint === undefined ? '' : `。${hint}`}`)
  }
  throw new Error(`HTTP ${String(resp.status)} ${resp.statusText}：${text.slice(0, 200)}`)
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function toResult(raw: unknown): FileResult {
  const parsed = raw as {
    file_name: string
    state: string
    full_zip_url?: string | null
    err_msg?: string | null
    extract_progress?: { extracted_pages?: unknown; total_pages?: unknown } | null
  }
  const progress = parsed.extract_progress
  return {
    file_name: parsed.file_name,
    state: parsed.state,
    full_zip_url: parsed.full_zip_url ?? null,
    err_msg: parsed.err_msg || null,
    extract_progress:
      typeof progress?.extracted_pages === 'number' && typeof progress.total_pages === 'number'
        ? { extracted_pages: progress.extracted_pages, total_pages: progress.total_pages }
        : null,
  }
}
