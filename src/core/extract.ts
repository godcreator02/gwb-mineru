/**
 * 下载结果 zip 并原样解进 outDir：完整 markdown + images/，不加任何库概念。
 *
 * zip 内部结构沿用老仓 archive.ts 认的那套：优先 full.md，否则要求 .md 唯一，歧义即抛。
 * 语言判定（CJK 占比）也在这一层——它是通用文本分析，跟论文库没有关系；
 * 调用方（如 papers）拿 lang 去定自己的成品命名。
 *
 * 「归档副本 + 成品位」那套篇目录布局是 papers 的私有约定，不在这儿——
 * 这个件只交出原料。
 */

import AdmZip from 'adm-zip'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DOWNLOAD_TIMEOUT_MS = 600 * 1000
const PREFERRED_MARKDOWN_NAME = 'full.md'

/** zip 结构不符合预期（找不到 markdown、或候选不唯一）时抛 */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveError'
  }
}

export interface ExtractResult {
  /** outDir 里那份完整 markdown 的文件名（如 full.md） */
  readonly markdown: string
  /** 正文语言判定：CJK 字数×3 ≥ ASCII 字母数判 zh（老仓口径原样） */
  readonly lang: 'zh' | 'en'
  /** 解出来的全部文件，相对 outDir 的 POSIX 路径 */
  readonly files: readonly string[]
}

const CJK = /[一-鿿]/g
const ASCII_LETTER = /[a-zA-Z]/g

function countMatches(re: RegExp, body: string): number {
  return [...body.matchAll(re)].length
}

export function isChineseDominant(body: string): boolean {
  return countMatches(CJK, body) * 3 >= countMatches(ASCII_LETTER, body)
}

/** 下载 zip → 解出 markdown 与 images/，原样落 outDir */
export async function downloadExtract(zipUrl: string, outDir: string): Promise<ExtractResult> {
  const resp = await fetch(zipUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`下载结果 zip 失败：HTTP ${String(resp.status)} ${resp.statusText}`)
  const bundle = new AdmZip(Buffer.from(await resp.arrayBuffer()))

  const entries = bundle.getEntries().filter((entry) => !entry.isDirectory)
  const markdownName = findMarkdown(entries)
  const rawMarkdown = bundle.getEntry(markdownName)?.getData()
  if (rawMarkdown === undefined) throw new ArchiveError(`zip 里读不出 ${markdownName} 的内容`)

  const files: string[] = []
  await mkdir(outDir, { recursive: true })
  for (const entry of entries) {
    const name = entry.entryName
    // 只认 markdown 本体与 images/ 下的东西；zip 根上的其余杂项（layout.json 之类）不搬
    const parts = name.split('/').filter(Boolean)
    const isMarkdown = parts.length === 1 && name === markdownName
    const isImage = parts.includes('images')
    if (!isMarkdown && !isImage) continue
    const target = path.join(outDir, ...parts)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, entry.getData())
    files.push(parts.join('/'))
  }
  if (!files.includes(markdownName)) throw new ArchiveError('解包后 markdown 不见了——outDir 状态不可信')

  const lang = isChineseDominant(rawMarkdown.toString('utf8')) ? 'zh' : 'en'
  return { markdown: markdownName, lang, files }
}

function findMarkdown(entries: readonly { entryName: string }[]): string {
  for (const entry of entries) {
    if (zipBasename(entry.entryName) === PREFERRED_MARKDOWN_NAME) return entry.entryName
  }
  const markdowns = entries.map((e) => e.entryName).filter((name) => name.endsWith('.md'))
  if (markdowns.length === 0) throw new ArchiveError('结果 zip 内未找到 markdown 文件')
  if (markdowns.length > 1) {
    throw new ArchiveError(`结果 zip 内无 full.md 且有多个 markdown 候选，无法唯一定位：${markdowns.join('、')}`)
  }
  return markdowns[0] ?? ''
}

function zipBasename(name: string): string {
  const parts = name.split('/').filter(Boolean)
  return parts.length > 0 ? (parts[parts.length - 1] ?? name) : name
}
