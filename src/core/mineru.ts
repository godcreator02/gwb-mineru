/**
 * MinerU 云端 API 客户端（单文件形态）：申请上传位、上传、轮询解析结果。
 *
 * 接口规格沿用老仓 god-papers 的 mineru.ts（对位 docs/mineru-api.md）：HTTP 层异常如实抛出，
 * 由作业机收进 job 的 error——不在这吞。
 *
 * 老仓是「一批多文件」，这个件一作业一文件：数组长度恒为 1，语义不变。
 */

import { readFile } from 'node:fs/promises'

const API_BASE = 'https://mineru.net/api/v4'

/** 解析任务的终态，到达任一即不再变化 */
const TERMINAL_STATES = new Set(['done', 'failed'])

const REQUEST_TIMEOUT_MS = 60 * 1000
const UPLOAD_TIMEOUT_MS = 600 * 1000

/** MinerU 回业务错误（HTTP 200 但 code 非 0）时抛 */
export class MineruError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MineruError'
  }
}

/** 单文件的解析结果。字段名对位 API 原始 JSON 键，不改写 */
export interface FileResult {
  readonly file_name: string
  readonly state: string
  readonly full_zip_url: string | null
  readonly err_msg: string | null
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
      language: 'en',
      files: [{ name, is_ocr: false }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  raiseForStatus(resp)
  const data = unwrap(await resp.json())
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
  raiseForStatus(resp)
}

export interface PollOptions {
  /** 两次轮询的间隔，秒 */
  readonly interval: number
  /** 整批轮询上限，秒 */
  readonly timeout: number
  /** 作业被收走（件卸载）时先让它醒，别等满一轮间隔 */
  readonly signal: AbortSignal
}

/** 轮询到终态。被打断抛 AbortError；超时结算为 failed（err_msg 说明超时） */
export async function poll(token: string, batchId: string, options: PollOptions): Promise<FileResult> {
  const headers = { Authorization: `Bearer ${token}` }
  const url = `${API_BASE}/extract-results/batch/${batchId}`
  const deadline = Date.now() + options.timeout * 1000
  for (;;) {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    raiseForStatus(resp)
    const data = unwrap(await resp.json())
    const rawResults = data['extract_result']
    if (!Array.isArray(rawResults) || rawResults.length === 0) {
      throw new MineruError('轮询回包里没有 extract_result')
    }
    const result = toResult(rawResults[0])
    if (TERMINAL_STATES.has(result.state)) return result
    if (Date.now() >= deadline) {
      return {
        file_name: result.file_name,
        state: 'failed',
        full_zip_url: null,
        err_msg: `轮询超时（${String(options.timeout)}s），未在时限内完成解析`,
      }
    }
    await sleep(options.interval * 1000, options.signal)
  }
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

function raiseForStatus(resp: Response): void {
  if (!resp.ok) throw new Error(`HTTP ${String(resp.status)} ${resp.statusText}`)
}

function unwrap(body: unknown): Record<string, unknown> {
  const parsed = body as { code?: number; msg?: string; data?: unknown }
  if (parsed.code !== 0) {
    throw new MineruError(`MinerU 返回错误：code=${String(parsed.code)} msg=${parsed.msg}`)
  }
  return parsed.data as Record<string, unknown>
}

function toResult(raw: unknown): FileResult {
  const parsed = raw as { file_name: string; state: string; full_zip_url?: string | null; err_msg?: string | null }
  return {
    file_name: parsed.file_name,
    state: parsed.state,
    full_zip_url: parsed.full_zip_url ?? null,
    err_msg: parsed.err_msg || null,
  }
}
