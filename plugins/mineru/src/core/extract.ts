/**
 * 下载结果 zip 并原样解进 outDir：完整 markdown + images/，不加任何库概念。
 *
 * 三条硬规矩都在这一层：
 * - **围栏**：全量 entry 先统一校验——白名单只有根下那份 markdown 与严格 `images/` 子树；盘符/冒号、
 *   绝对路径、`..` 段、反斜杠、控制字符，以及按真实路径解析后跑出落点根的一律拒。**全过了才落盘**
 *   （不边写边判：绝不出现「前面几个文件已经写了才发现后面越界」）。被拒报出是哪条 entry、犯的哪条。
 * - **原子提交**：先解进工作根里的 staging，解完整体 rename 进 outDir——outDir 要么是上一版、要么是
 *   完整的新版，半个产出不留在里面。outDir 已有产物时默认拒，显式 overwrite 才覆盖（旧产物先备份）。
 * - **归档落盘**：原始 zip 在工作根留一份（`archive-<作业号>.zip`）。解包失败/中断后凭它重新解包，
 *   不必再花一次云端额度。
 *
 * zip 内部结构沿用老仓 archive.ts 认的那套：优先 full.md，否则要求 .md 唯一，歧义即抛。
 * 语言判定（CJK 占比）也在这一层——它是通用文本分析，跟论文库没有关系；
 * 调用方（如 papers）拿 lang 去定自己的成品命名。
 *
 * 「归档副本 + 成品位」那套篇目录布局是 papers 的私有约定，不在这儿——
 * 这个件只交出原料。
 */

import AdmZip from 'adm-zip'
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'

const DOWNLOAD_TIMEOUT_MS = 600 * 1000
const PREFERRED_MARKDOWN_NAME = 'full.md'

/** 工作根的名字：outDir 同级的 `.<outDir 名>.pdf2md`——staging、归档、备份都住这儿 */
const WORK_SUFFIX = '.pdf2md'
/** 提交中途的账：崩在两次 rename 之间时，下一次开工凭它把旧产物搬回去 */
const JOURNAL_NAME = 'commit-journal.json'

/** zip 结构不符合预期（找不到 markdown、或候选不唯一）时抛 */
export class ArchiveError extends Error {
  /** 归档已经落盘时带上它的绝对路径——失败后凭它重新解包，不必再问云端要 */
  readonly archive: string | undefined

  constructor(message: string, options: { readonly archive?: string } = {}) {
    super(message)
    this.name = 'ArchiveError'
    this.archive = options.archive
  }
}

/** 一条 entry 犯的哪条围栏 */
export type EntryRejectReason =
  | 'empty'
  | 'control'
  | 'backslash'
  | 'colon'
  | 'absolute'
  | 'dotdot'
  | 'duplicate'
  | 'shape'
  | 'escape'

const REASON_TEXT: Readonly<Record<EntryRejectReason, string>> = {
  empty: '空名字：归一后一个路径段都不剩',
  control: '名字里有控制字符',
  backslash: '名字里有反斜杠——Windows 上它也是路径分隔符，落点说不清',
  colon: '名字里有冒号——盘符（C:）或 NTFS 备用数据流',
  absolute: '绝对路径：以分隔符或盘符开头，不落在 outDir 里',
  dotdot: '有 .. 段——解析后会跑到 outDir 外面',
  duplicate: '两条 entry 归一后是同一个落点',
  shape: '落点既是文件、又是另一条的父目录',
  escape: '按真实路径解析后跑出了落点根（软链 / 目录联接件的绕法）',
}

/** 某条 entry 不合格时抛。说清是哪条、犯的哪条 */
export class EntryRejectedError extends ArchiveError {
  readonly entry: string
  readonly reason: EntryRejectReason

  constructor(entry: string, reason: EntryRejectReason, options: { readonly archive?: string } = {}) {
    super(`结果 zip 里这条 entry 不能落盘：${JSON.stringify(entry)}——${REASON_TEXT[reason]}`, options)
    this.name = 'EntryRejectedError'
    this.entry = entry
    this.reason = reason
  }
}

/** 提交点到不了位时抛（outDir 已有产物而没开 overwrite、outDir 是个文件）：outDir 一个字节没动 */
export class CommitRejectedError extends ArchiveError {
  readonly outDir: string

  constructor(outDir: string, detail: string, options: { readonly archive?: string } = {}) {
    super(`outDir 没动：${outDir}——${detail}`, options)
    this.name = 'CommitRejectedError'
    this.outDir = outDir
  }
}

export interface ExtractOptions {
  /** 作业号：staging 与归档按它分家 */
  readonly jobId: string
  /** outDir 里已有产物时怎么办：默认拒；true 才覆盖，旧产物先挪进工作根的备份目录 */
  readonly overwrite?: boolean
}

export interface ExtractResult {
  /** outDir 里那份完整 markdown 的文件名（如 full.md） */
  readonly markdown: string
  /** 正文语言判定：CJK 字数×3 ≥ ASCII 字母数判 zh（老仓口径原样） */
  readonly lang: 'zh' | 'en'
  /** 解出来的全部文件，相对 outDir 的 POSIX 路径 */
  readonly files: readonly string[]
  /** 白名单外、但没犯围栏的条目（zip 根上的 layout.json 之类）——列出来，不静默丢 */
  readonly skipped: readonly string[]
  /** 原始 zip 的落盘副本（工作根里）：重新解包凭它，不必再问云端 */
  readonly archive: string
  /** 这次提交的结果：created 全新产物；replaced 覆盖了旧产物（旧的在 backup） */
  readonly commit: 'created' | 'replaced'
  /** 覆盖时旧产物挪去的备份目录 */
  readonly backup?: string
}

const CJK = /[一-鿿]/g
const ASCII_LETTER = /[a-zA-Z]/g
const CONTROL = /[\u0000-\u001f\u007f]/

function countMatches(re: RegExp, body: string): number {
  return [...body.matchAll(re)].length
}

export function isChineseDominant(body: string): boolean {
  return countMatches(CJK, body) * 3 >= countMatches(ASCII_LETTER, body)
}

/** 下载 zip → 落进工作根留一份 → 解出 markdown 与 images/，原子提交进 outDir */
export async function downloadExtract(zipUrl: string, outDir: string, options: ExtractOptions): Promise<ExtractResult> {
  const root = path.resolve(outDir)
  const resp = await fetch(zipUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`下载结果 zip 失败：HTTP ${String(resp.status)} ${resp.statusText}`)
  const bytes = Buffer.from(await resp.arrayBuffer())

  // 先落盘再见解包：解包失败/中断时，这份归档就是不用重花额度的凭据
  const work = workDirFor(root)
  await mkdir(work, { recursive: true })
  const archive = path.join(work, `archive-${safeSegment(options.jobId)}.zip`)
  const partial = `${archive}.part`
  await writeFile(partial, bytes)
  await rename(partial, archive) // 半截 zip 不冒充归档

  return extractArchive(archive, root, options)
}

/** 从盘上那份归档解进 outDir：围栏全量校验 → staging 解包 → 原子提交。零网络、零云端额度 */
export async function extractArchive(archive: string, outDir: string, options: ExtractOptions): Promise<ExtractResult> {
  const root = path.resolve(outDir)
  const work = workDirFor(root)
  await mkdir(work, { recursive: true })
  await rollbackInterruptedCommit(work, root)

  const bundle = new AdmZip(await readFile(archive))
  const entries = bundle.getEntries().filter((entry) => !entry.isDirectory)
  const markdownName = findMarkdown(entries, archive)
  const rawMarkdown = bundle.getEntry(markdownName)?.getData()
  if (rawMarkdown === undefined) throw new ArchiveError(`zip 里读不出 ${markdownName} 的内容`, { archive })
  if (splitEntryName(markdownName, archive).length !== 1) {
    throw new ArchiveError(`markdown 不在 zip 根下：${markdownName}——这个件只认根下那份（如 full.md）`, { archive })
  }

  // 全量校验先做完：一条不合格就整包不落盘，绝不「写了几个才发现后面越界」
  const staged = path.join(work, `staged-${safeSegment(options.jobId)}`)
  const { copy, skipped } = planEntries(entries, markdownName, staged, archive)

  await rm(staged, { recursive: true, force: true })
  await mkdir(staged, { recursive: true })
  try {
    // 真实路径校验要一个存在的根（staging 自己先立起来——它是我们的暂存区，outDir 此刻一个字节没动），
    // 全部落点过完这一关，才开始往里写
    for (const file of copy) assertRealInside(staged, file.target, file.name, archive)
    for (const file of copy) {
      await mkdir(path.dirname(file.target), { recursive: true })
      await writeFile(file.target, bundle.getEntry(file.name)?.getData() ?? Buffer.alloc(0))
    }
    if (!copy.some((file) => file.rel === markdownName)) {
      throw new ArchiveError('解包后 markdown 不见了——staging 状态不可信', { archive })
    }

    const committed = await publish(staged, root, work, options.overwrite === true, archive)
    const lang = isChineseDominant(rawMarkdown.toString('utf8')) ? 'zh' : 'en'
    return {
      markdown: markdownName,
      lang,
      files: copy.map((file) => file.rel),
      skipped,
      archive,
      commit: committed.commit,
      ...(committed.backup !== undefined ? { backup: committed.backup } : {}),
    }
  } catch (err) {
    // 残骸不留：归档还在，重来一遍就是（outDir 此刻仍是上一版，一个字节没动）
    await rm(staged, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

/** outDir 同级的工作根：staging、归档、备份都住这儿。调用方随时可以整个删掉——在跑的作业除外 */
function workDirFor(outDir: string): string {
  const name = path.basename(outDir) || 'out'
  return path.join(path.dirname(outDir), `.${name}${WORK_SUFFIX}`)
}

/** 归一成一段能进文件名的短标识：作业号是我们自己造的，但这条函数是公开面，别信外面递进来的东西 */
function safeSegment(raw: string): string {
  const cleaned = raw.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'job' : cleaned
}

interface PlannedFile {
  /** zip 里的原名（读内容用） */
  readonly name: string
  /** 相对 outDir 的 POSIX 路径（落盘清单用） */
  readonly rel: string
  /** staging 里的落点 */
  readonly target: string
}

/** 全量过一遍围栏，分拣出「搬」与「不搬」；不合格的当场抛，一个字节都还没写 */
function planEntries(
  entries: readonly { readonly entryName: string }[],
  markdownName: string,
  staged: string,
  archive: string,
): { copy: PlannedFile[]; skipped: string[] } {
  const copy: PlannedFile[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const name = entry.entryName
    const parts = splitEntryName(name, archive)
    const rel = parts.join('/')
    // 白名单：根下那份 markdown 本体，与严格 images/ 子树下的东西；zip 根上的其余杂项（layout.json 之类）不搬
    const isMarkdown = parts.length === 1 && rel === markdownName
    const isImage = parts[0] === 'images' && parts.length >= 2
    if (!isMarkdown && !isImage) {
      skipped.push(name)
      continue
    }
    if (seen.has(rel)) throw new EntryRejectedError(name, 'duplicate', { archive })
    seen.add(rel)
    copy.push({ name, rel, target: path.join(staged, ...parts) })
  }
  for (const file of copy) {
    const parts = file.rel.split('/')
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (seen.has(parts.slice(0, depth).join('/'))) throw new EntryRejectedError(file.name, 'shape', { archive })
    }
  }
  return { copy, skipped }
}

/** 一条 entry 名字过围栏，归一成路径段；不合格抛 EntryRejectedError（哪条、犯的哪条都在里面） */
function splitEntryName(name: string, archive: string): string[] {
  const reject = (reason: EntryRejectReason): never => {
    throw new EntryRejectedError(name, reason, { archive })
  }
  if (name === '') reject('empty')
  if (CONTROL.test(name)) reject('control')
  if (name.includes('\\')) reject('backslash')
  if (name.includes(':')) reject('colon')
  if (name.startsWith('/') || path.isAbsolute(name)) reject('absolute')
  const parts = name.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (parts.includes('..')) reject('dotdot')
  if (parts.length === 0) reject('empty')
  return parts
}

/**
 * 落点必须在 root 里。按**最近已存在祖先**做一次真实路径校验：父目录还不存在时，realpath 它最近的
 * 那个祖先、再把剩下的段拼回来——软链 / 目录联接件绕出来的落点在这一步露馅。
 */
function assertRealInside(root: string, target: string, entry: string, archive: string): void {
  const rootReal = realpathSync.native(root)
  let anchor = target
  const rest: string[] = []
  for (;;) {
    try {
      anchor = realpathSync.native(anchor)
      break
    } catch {
      const parent = path.dirname(anchor)
      if (parent === anchor) break
      rest.unshift(path.basename(anchor))
      anchor = parent
    }
  }
  const real = path.resolve(anchor, ...rest)
  const rel = path.relative(rootReal, real)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new EntryRejectedError(entry, 'escape', { archive })
  }
}

/**
 * 提交点：staging 整体 rename 进 outDir——要么上一版、要么完整的新版，没有中间态。
 * outDir 已有产物时默认拒；显式 overwrite 才把旧的挪去工作根备份、再上新的。
 * 每一步都可能撞上「另一条作业刚落进同一个目录」：撞上一律翻成结构化拒，说清 outDir 没动
 */
async function publish(
  staged: string,
  outDir: string,
  work: string,
  overwrite: boolean,
  archive: string,
): Promise<{ commit: 'created' | 'replaced'; backup?: string }> {
  const existing = await stat(outDir).catch(() => undefined)
  if (existing === undefined) {
    await renameOrConflict(staged, outDir, archive)
    return { commit: 'created' }
  }
  if (!existing.isDirectory()) {
    throw new CommitRejectedError(outDir, '它是个文件，不是目录', { archive })
  }
  const leftovers = await readdir(outDir).catch(() => undefined)
  if (leftovers === undefined || leftovers.length === 0) {
    // 空目录：先把它挪开再上新的。挪的这一下也可能被并发的那条抢了先——抢输不算错，
    // 只要它已经不在了就继续，rename 那关还会再兜一道
    try {
      await rmdir(outDir)
    } catch (err) {
      if (await exists(outDir)) {
        throw new CommitRejectedError(outDir, `提交点没过去：空 outDir 没挪开——${String(err)}`, { archive })
      }
    }
    await renameOrConflict(staged, outDir, archive)
    return { commit: 'created' }
  }
  if (!overwrite) {
    throw new CommitRejectedError(
      outDir,
      `里面已经有 ${String(leftovers.length)} 项东西，这条作业没带 overwrite——要覆盖就显式说（旧产物会先挪进工作根备份）`,
      { archive },
    )
  }

  const backup = path.join(work, `backup-${stamp()}`)
  const journal = path.join(work, JOURNAL_NAME)
  await writeFile(journal, JSON.stringify({ outDir, backup, staged, at: new Date().toISOString() }))
  try {
    await rename(outDir, backup)
  } catch (err) {
    await rm(journal, { force: true }).catch(() => undefined)
    throw new CommitRejectedError(outDir, `提交点没过去：旧产物没挪进备份——${String(err)}`, { archive })
  }
  try {
    await rename(staged, outDir)
  } catch (err) {
    // 宁可退回上一版，也不留半份：旧产物搬回去，journal 清掉
    await rename(backup, outDir).catch(() => undefined)
    await rm(journal, { force: true }).catch(() => undefined)
    throw new CommitRejectedError(outDir, `提交失败，已退回上一版（旧产物在 ${backup}）：${String(err)}`, { archive })
  }
  await rm(journal, { force: true }).catch(() => undefined)
  return { commit: 'replaced', backup }
}

/**
 * 上一次提交崩在两次 rename 之间时，工作根里留着 journal：把旧产物搬回 outDir 再继续。
 * 宁可退回上一版，也不给调用方一个「产物不见了」的目录。
 */
async function rollbackInterruptedCommit(work: string, outDir: string): Promise<void> {
  const journal = path.join(work, JOURNAL_NAME)
  const raw = await readFile(journal, 'utf8').catch(() => undefined)
  if (raw === undefined) return
  await rm(journal, { force: true }).catch(() => undefined)
  const parsed = parseJournal(raw)
  if (parsed === undefined) return
  if (await exists(outDir)) return // 崩在清 journal 之前：提交其实成了
  const backup = await exists(parsed.backup)
  if (backup) await rename(parsed.backup, outDir).catch(() => undefined)
}

/** 提交点那一步 rename：outDir 在查过之后、rename 之前被别人占了（多半是另一条作业刚落进来）时，
 *  Windows 给的是 EPERM/EEXIST——翻成结构化拒，说清 outDir 一个字节没动 */
async function renameOrConflict(staged: string, outDir: string, archive: string): Promise<void> {
  try {
    await rename(staged, outDir)
  } catch (err) {
    throw new CommitRejectedError(
      outDir,
      `提交这一瞬间它被占了（outDir 现在不是空的，多半是另一条作业刚落进同一个目录）：${String(err)}`,
      { archive },
    )
  }
}

function parseJournal(raw: string): { backup: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const backup = (parsed as { backup?: unknown }).backup
    return typeof backup === 'string' ? { backup } : undefined
  } catch {
    return undefined
  }
}

async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined)) !== undefined
}

function stamp(): string {
  return new Date().toISOString().replaceAll(/[-:TZ.]/g, '').slice(0, 14)
}

function findMarkdown(entries: readonly { entryName: string }[], archive: string): string {
  for (const entry of entries) {
    if (zipBasename(entry.entryName) === PREFERRED_MARKDOWN_NAME) return entry.entryName
  }
  const markdowns = entries.map((e) => e.entryName).filter((name) => name.endsWith('.md'))
  if (markdowns.length === 0) throw new ArchiveError('结果 zip 内未找到 markdown 文件', { archive })
  if (markdowns.length > 1) {
    throw new ArchiveError(
      `结果 zip 内无 full.md 且有多个 markdown 候选，无法唯一定位：${markdowns.join('、')}`,
      { archive },
    )
  }
  return markdowns[0] ?? ''
}

function zipBasename(name: string): string {
  const parts = name.split('/').filter(Boolean)
  return parts.length > 0 ? (parts[parts.length - 1] ?? name) : name
}
