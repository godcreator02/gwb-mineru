import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Service } from 'cordis'
import type { GwbContext } from '@godcreator/gwb-kernel-desktop'
import { isRecord, requireKernel } from './vocab.js'
// 空的类型 import 只为让四个插件的 `declare module 'cordis'` 生效，ctx 上才有 gwbCommands / gwbData / gwbSettings / gwbSkills 的类型
import type {} from '@godcreator/gwb-commands'
import type {} from '@godcreator/gwb-data'
import type {} from '@godcreator/gwb-settings'
import type {} from '@godcreator/gwb-skills'
import { ArchiveError, downloadExtract, extractArchive, type ExtractResult } from './core/extract.js'
import { MAX_FILE_BYTES, isDone, poll, requestUpload, upload, type FileResult } from './core/mineru.js'

/** 日志名，也是 `job-settled` 事件的 `source` */
const PLUGIN_NAME = 'gwb-mineru'
const JOBS_DOC_NAME = 'jobs'

const POLL_INTERVAL_SECONDS = 5
const POLL_STALL_LIMIT_SECONDS = 600
const POLL_TOTAL_LIMIT_SECONDS = 3600

export type JobState = 'queued' | 'uploading' | 'running' | 'done' | 'failed' | 'interrupted'

/** 一条作业的账。落盘就是它——只装可序列化的东西 */
export interface Pdf2mdJob {
  readonly id: string
  readonly input: string
  readonly outDir: string
  readonly state: JobState
  readonly createdAt: string
  readonly updatedAt: string
  readonly error?: string
  readonly batchId?: string
  /** 提交时带了覆盖：outDir 里原有的产物已先挪进备份目录（`backup`） */
  readonly overwrite?: boolean
  /** 云端报来的解析进度（running 时才有；done 时补满） */
  readonly progress?: { readonly extractedPages: number; readonly totalPages: number }
  /** 转换成功后交出的三样 */
  readonly markdown?: string
  readonly lang?: 'zh' | 'en'
  readonly files?: readonly string[]
  /** 白名单外、没搬的那些 entry（zip 根上的 layout.json 之类）——列出来，不静默丢 */
  readonly skipped?: readonly string[]
  /** 原始 zip 的落盘副本：重新解包凭它（pdf2md.recover），不必再花一次云端额度 */
  readonly archive?: string
  /** 产物是怎么落进 outDir 的：created 全新；replaced 把上一版挪进 backup 后覆盖 */
  readonly commit?: 'created' | 'replaced'
  /** commit 为 replaced 时，上一版产物挪去的备份目录 */
  readonly backup?: string
}

/** 一次提交里的一条：一个 PDF 进、一个 outDir 出 */
export interface Pdf2mdSubmitInput {
  readonly input: string
  readonly outDir: string
  /**
   * outDir 里已有产物时怎么办。默认拒（整批当场拒，一个字节都不动）；true 才覆盖——
   * 旧产物先整体挪进工作根备份，再提交新版
   */
  readonly overwrite?: boolean
}

/** 消费方拿到的服务接口。写 `inject: ['gwbPdf2md']` 才有 */
export interface GwbPdf2mdApi {
  /**
   * 提交一批转换作业（一作业一文件）。验完全部文件与目录、落完账才返回——**返回不是完成**，
   * 成败看 get(id) 的 state。作业各自独立、**同时开跑**（云端各转各的，谁先完谁先落）。
   * 有一条参数形状不对就整批拒，不写半批账；两条作业指向同一个 outDir 也整批拒
   * （一个 outDir 一次只落一个作业的产物）
   */
  submit(files: readonly Pdf2mdSubmitInput[]): Promise<Pdf2mdJob[]>
  /**
   * 凭作业盘上那份原始 zip 重新解包进它的 outDir：零云端、零额度。只对 failed / interrupted
   * 且账上有归档的作业有效——解包阶段掉链子时，不必为了同一份结果再花一次云端解析
   */
  recover(id: string): Promise<Pdf2mdJob>
  /** 查一条。没有这个 id 回 undefined */
  get(id: string): Pdf2mdJob | undefined
  /** 此刻账上的全部作业，新的在前 */
  list(): Pdf2mdJob[]
}

/** 节名由设置插件按条目 id 算出（mineru）。不在 init 里 define，get 永远回 undefined、不报错 */
const TOKEN_SETTING_DEF = {
  key: 'token',
  title: 'MinerU Token',
  type: 'secret',
  description: 'MinerU 云端转换的 API token，https://mineru.net 申请',
} as const

function nowIso(): string {
  return new Date().toISOString()
}

function isInFlight(state: JobState): boolean {
  return state === 'queued' || state === 'uploading' || state === 'running'
}

function isSettled(state: JobState): boolean {
  return state === 'done' || state === 'failed' || state === 'interrupted'
}

function extractOptionsFor(job: Pdf2mdJob): { jobId: string; overwrite?: boolean } {
  return { jobId: job.id, ...(job.overwrite === true ? { overwrite: true } : {}) }
}

function jobFieldsFromExtractResult(extracted: ExtractResult): Partial<Pdf2mdJob> {
  return {
    markdown: extracted.markdown,
    lang: extracted.lang,
    files: [...extracted.files],
    skipped: [...extracted.skipped],
    archive: extracted.archive,
    commit: extracted.commit,
    ...(extracted.backup !== undefined ? { backup: extracted.backup } : {}),
  }
}

/** fetch 失败时真原因（ECONNRESET、连接超时之类）只在 cause 里 */
function describeErrorWithCause(err: unknown): string {
  if (!(err instanceof Error) || err.cause === undefined) return String(err)
  const cause = err.cause
  if (!(cause instanceof Error)) return `${String(err)}（${String(cause)}）`
  const code = (cause as { code?: unknown }).code
  const causeWithCode = typeof code === 'string' && !cause.message.includes(code) ? `${cause.message} ${code}` : cause.message
  return `${String(err)}（${causeWithCode}）`
}

export default class GwbMineru extends Service implements GwbPdf2mdApi {
  static inject = ['gwbCommands', 'gwbSettings', 'gwbData']

  /** 方法里的 `this.ctx` 是消费者的；作业的定时器、记账、清理都登记在这个提供方上下文上，消费者卸载带不走在跑的作业 */
  private readonly providerContext: GwbContext
  private readonly logInfo: (message: string) => void
  private readonly logWarn: (message: string) => void
  private readonly jobsById = new Map<string, Pdf2mdJob>()
  /** 键是 `path.resolve` 归一后的 outDir */
  private readonly jobIdByClaimedOutDir = new Map<string, string>()
  private readonly abortControllerByJobId = new Map<string, AbortController>()
  private jobSequence = 0
  /** 作业账写盘排成一条链：同一个文件并发 rename，Windows 上会 EPERM */
  private ledgerWriteChain: Promise<void> = Promise.resolve()
  private lastLedgerWriteError: unknown = undefined
  /** submit 先等它：首笔账赶在旧账载入前落盘，会把旧账冲掉 */
  private startupReconcile: Promise<void> = Promise.resolve()

  constructor(ctx: GwbContext) {
    super(ctx, 'gwbPdf2md')
    this.providerContext = ctx
    const logger = ctx.logger(PLUGIN_NAME)
    this.logInfo = (message: string): void => logger.info(message)
    this.logWarn = (message: string): void => logger.warn(message)
  }

  [Service.init](): void {
    this.providerContext.effect(() => () => {
      for (const controller of this.abortControllerByJobId.values()) controller.abort()
      void this.markInFlightJobsInterrupted().catch(() => undefined)
    })

    this.providerContext.effect(() => this.providerContext.gwbSettings.define(TOKEN_SETTING_DEF))

    const commandBus = this.providerContext.gwbCommands
    if (commandBus === undefined) return
    this.providerContext.effect(() =>
      commandBus.register(
        { name: 'pdf2md.submit', description: '提交一批 PDF 转 markdown 作业，秒回作业号，作业各自独立同时跑', usage: '参数 { files: [{ input, outDir, overwrite? }, …] }：files 非空，input 是存在的 PDF 绝对路径（不超 200MB），outDir 是绝对路径；outDir 里已有产物默认整批拒，overwrite: true 才覆盖（旧产物先备份）；同批两条同一个 outDir、或 outDir 被在跑的作业占着，也整批拒。回作业数组 [{ id, input, outDir, state: "queued", createdAt, updatedAt, overwrite? }]——返回不是完成，成败看 pdf2md.status', effect: 'external' },
        async (args) => {
          const raw = isRecord(args) ? args : {}
          const files = raw['files']
          if (!Array.isArray(files) || files.length === 0) throw new Error('pdf2md.submit 要 { files: [{ input, outDir }, …] } 非空数组')
          const parsed: Pdf2mdSubmitInput[] = []
          for (const one of files) {
            if (!isRecord(one) || typeof one['input'] !== 'string' || typeof one['outDir'] !== 'string') {
              throw new Error('files 里每一项都得是 { input, outDir }（绝对路径）')
            }
            const overwrite = one['overwrite']
            if (overwrite !== undefined && typeof overwrite !== 'boolean') throw new Error('files 里 overwrite 是布尔值（要不要覆盖已有的 outDir）')
            parsed.push({ input: one['input'], outDir: one['outDir'], ...(overwrite === true ? { overwrite: true } : {}) })
          }
          return this.submit(parsed)
        },
      ),
    )
    this.providerContext.effect(() =>
      commandBus.register({ name: 'pdf2md.jobs', description: '全部转换作业（新的在前）', usage: '无参数。回 { count, jobs: [作业, …] }，作业形状同 pdf2md.status 的回执', effect: 'read' }, () => ({
        count: this.jobsById.size,
        jobs: this.list(),
      })),
    )
    this.providerContext.effect(() =>
      commandBus.register({ name: 'pdf2md.status', description: '查一条转换作业', usage: '参数 { id }（非空字符串）。回那条作业 { id, input, outDir, state: queued|uploading|running|done|failed|interrupted, createdAt, updatedAt, error?, batchId?, overwrite?, progress?: { extractedPages, totalPages }, markdown?, lang?: zh|en, files?, skipped?, archive?, commit?: created|replaced, backup? }，云端解析中才带 progress；没有这个 id 报错', effect: 'read' }, (args) => {
        const raw = isRecord(args) ? args : {}
        const id = raw['id']
        if (typeof id !== 'string' || id === '') throw new Error('pdf2md.status 要 { id: string }')
        const job = this.get(id)
        if (job === undefined) throw new Error(`没有这个作业：${id}`)
        return job
      }),
    )
    this.providerContext.effect(() =>
      commandBus.register(
        { name: 'pdf2md.recover', description: '用作业盘上那份原始 zip 重新解包进它的 outDir，不再花云端额度', usage: '参数 { id }（非空字符串）。只对 failed / interrupted、账上有 archive 且归档文件还在的作业有效，outDir 被别的作业占着时拒。回解包后的那条作业（state: "done"，形状同 pdf2md.status 的回执）；解包失败报错，作业记 failed', effect: 'write' },
        async (args) => {
          const raw = isRecord(args) ? args : {}
          const id = raw['id']
          if (typeof id !== 'string' || id === '') throw new Error('pdf2md.recover 要 { id: string }')
          return this.recover(id)
        },
      ),
    )

    this.providerContext.inject(['gwbSkills'], (scoped) => {
      scoped.effect(() => scoped.gwbSkills.register(new URL('../skills/', import.meta.url)))
    })

    this.startupReconcile = this.loadLedgerMarkingLeftoversInterrupted().catch(() => undefined)
    this.logInfo('mineru 作业机就绪（ctx.gwbPdf2md，插件 gwb-mineru）')
  }

  async submit(files: readonly Pdf2mdSubmitInput[]): Promise<Pdf2mdJob[]> {
    if (!Array.isArray(files) || files.length === 0) throw new Error('submit 要 files: [{ input, outDir }, …] 非空数组')
    const token = this.readTokenNow()
    if (token === undefined) throw new Error('MinerU token 没配——先在本地设置界面填，或用 credentials.copy / credentials.import 配置 mineru.token；用 credentials.status 查看状态')

    // 占位必须在第一个 await 之前：两个并发 submit 不能都验到「这个 outDir 空着」
    const jobs = this.newQueuedJobs(files)
    let claimedOutDirKeys: string[] = []
    try {
      claimedOutDirKeys = this.claimOutDirs(jobs)
      await this.assertSubmissionsAcceptable(files)
      await this.startupReconcile
      await this.enterJobsIntoLedger(jobs)
    } catch (err) {
      for (const key of claimedOutDirKeys) this.jobIdByClaimedOutDir.delete(key)
      throw err
    }
    for (const job of jobs) this.startInBackground(job, token)
    return jobs
  }

  async recover(id: string): Promise<Pdf2mdJob> {
    const job = this.jobsById.get(id)
    if (job === undefined) throw new Error(`没有这个作业：${id}`)
    if (job.state === 'done') throw new Error(`作业 ${id} 已经是 done，产物就在 ${job.outDir}，不用重新解包`)
    if (isInFlight(job.state)) {
      throw new Error(`作业 ${id} 还在跑（${job.state}），别插手——等它落定（pdf2md.status { id: "${id}" }）再说`)
    }
    const archive = job.archive
    if (archive === undefined) {
      throw new Error(`作业 ${id} 还没下载过结果 zip，盘上没有归档——要结果只能重新 pdf2md.submit 一次（会再花一次云端额度）`)
    }
    const archiveStat = await stat(archive).catch(() => undefined)
    if (archiveStat === undefined || !archiveStat.isFile()) throw new Error(`作业 ${id} 的归档不在了：${archive}——工作根被清过就重新解包不了，只能重新 submit`)

    const outDirKey = path.resolve(job.outDir)
    const holderJobId = this.jobIdByClaimedOutDir.get(outDirKey)
    if (holderJobId !== undefined) {
      throw new Error(`outDir 正被作业 ${holderJobId} 占着：${job.outDir}——等它落定再来`)
    }
    this.jobIdByClaimedOutDir.set(outDirKey, id)
    try {
      const extracted = await extractArchive(archive, job.outDir, extractOptionsFor(job))
      await this.updateJobAndPersist(id, 'done', jobFieldsFromExtractResult(extracted))
      this.logInfo(`作业 ${id} 用盘上归档重新解包完成：${extracted.markdown}（${extracted.lang}，${extracted.commit}）`)
    } catch (err) {
      await this.updateJobAndPersist(id, 'failed', undefined, describeErrorWithCause(err))
      throw err
    } finally {
      this.releaseOutDirClaim(job.outDir, id)
    }
    return this.jobsById.get(id) ?? job
  }

  get(id: string): Pdf2mdJob | undefined {
    return this.jobsById.get(id)
  }

  list(): Pdf2mdJob[] {
    return [...this.jobsById.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** 每次用时现读：settings 改值后不用重新加载插件就生效 */
  private readTokenNow(): string | undefined {
    const value = this.providerContext.gwbSettings?.get('token')
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  private newQueuedJobs(files: readonly Pdf2mdSubmitInput[]): Pdf2mdJob[] {
    const at = nowIso()
    const jobs: Pdf2mdJob[] = []
    for (const one of files) {
      if (typeof one?.input !== 'string' || typeof one?.outDir !== 'string') {
        throw new Error('files 里每一项都得是 { input, outDir }（绝对路径）')
      }
      const id = `${at.replaceAll(/[-:TZ.]/g, '').slice(0, 14)}-${String(++this.jobSequence)}`
      jobs.push({
        id,
        input: one.input,
        outDir: one.outDir,
        state: 'queued',
        createdAt: at,
        updatedAt: at,
        ...(one.overwrite === true ? { overwrite: true } : {}),
      })
    }
    return jobs
  }

  /** 先查完整批再一起占：有一条冲突就一个都不占。返回占下的键 */
  private claimOutDirs(jobs: readonly Pdf2mdJob[]): string[] {
    const jobIdByOutDirInThisBatch = new Map<string, string>()
    for (const job of jobs) {
      const outDirKey = path.resolve(job.outDir)
      const twinJobId = jobIdByOutDirInThisBatch.get(outDirKey)
      if (twinJobId !== undefined) {
        throw new Error(`这批里两条作业（${twinJobId} 与 ${job.id}）瞄着同一个 outDir：${job.outDir}——一个 outDir 一次只落一个作业的产物，分开交或各给一个目录`)
      }
      const holderJobId = this.jobIdByClaimedOutDir.get(outDirKey)
      if (holderJobId !== undefined) {
        throw new Error(`outDir 正被作业 ${holderJobId} 占着：${job.outDir}——等它落定（pdf2md.status { id: "${holderJobId}" }）再交，或换个目录`)
      }
      jobIdByOutDirInThisBatch.set(outDirKey, job.id)
    }
    const claimedOutDirKeys: string[] = []
    for (const job of jobs) {
      const outDirKey = path.resolve(job.outDir)
      this.jobIdByClaimedOutDir.set(outDirKey, job.id)
      claimedOutDirKeys.push(outDirKey)
    }
    return claimedOutDirKeys
  }

  private async assertSubmissionsAcceptable(files: readonly Pdf2mdSubmitInput[]): Promise<void> {
    for (const one of files) {
      if (!path.isAbsolute(one.input)) throw new Error(`input 得是绝对路径：${one.input}`)
      if (!path.isAbsolute(one.outDir)) throw new Error(`outDir 得是绝对路径：${one.outDir}`)
      const inputStat = await stat(one.input).catch(() => undefined)
      if (inputStat === undefined || !inputStat.isFile()) throw new Error(`input 不是个能读的文件：${one.input}`)
      if (inputStat.size > MAX_FILE_BYTES) throw new Error(`input 超过 MinerU 单文件上限 200MB，拆小了再提：${one.input}`)
      await this.assertOutDirAcceptsNewJob(one.outDir, one.overwrite === true)
    }
  }

  private async assertOutDirAcceptsNewJob(outDir: string, overwrite: boolean): Promise<void> {
    const outDirStat = await stat(outDir).catch(() => undefined)
    if (outDirStat === undefined) return
    if (!outDirStat.isDirectory()) throw new Error(`outDir 是个文件，不是目录：${outDir}`)
    if (overwrite) return
    const leftovers = await readdir(outDir)
    if (leftovers.length > 0) {
      throw new Error(`outDir 里已经有 ${String(leftovers.length)} 项东西：${outDir}——要覆盖就在这条里写 "overwrite": true（旧产物先整体备份到工作根），或者换一个空目录`)
    }
  }

  /** 账落不了盘就撤回入列再拒。盘上可能已多写了几条 queued，没人开跑，重启对账会标 interrupted */
  private async enterJobsIntoLedger(jobs: readonly Pdf2mdJob[]): Promise<void> {
    for (const job of jobs) {
      this.jobsById.set(job.id, job)
      this.logInfo(`作业 ${job.id} 入列：${path.basename(job.input)} → ${job.outDir}${job.overwrite === true ? '（覆盖：旧产物先备份）' : ''}`)
    }
    await this.writeLedger()
    if (this.lastLedgerWriteError !== undefined) {
      for (const job of jobs) this.jobsById.delete(job.id)
      throw new Error(`作业账落不了盘，这批不收（重试前先看数据盘）：${describeErrorWithCause(this.lastLedgerWriteError)}`)
    }
  }

  /** 只放自己占的那一格：别人的作业占着时不许顶掉 */
  private releaseOutDirClaim(outDir: string, id: string): void {
    const outDirKey = path.resolve(outDir)
    if (this.jobIdByClaimedOutDir.get(outDirKey) === id) this.jobIdByClaimedOutDir.delete(outDirKey)
  }

  private startInBackground(job: Pdf2mdJob, token: string): void {
    void this.runFullChain(job, token).catch(async (err: unknown) => {
      this.logWarn(`作业 ${job.id} 的执行链抛出异常：${describeErrorWithCause(err)}`)
      await this.updateJobAndPersist(job.id, 'failed', undefined, describeErrorWithCause(err))
    })
  }

  private async runFullChain(job: Pdf2mdJob, token: string): Promise<void> {
    const controller = new AbortController()
    this.abortControllerByJobId.set(job.id, controller)
    try {
      const batchId = await this.uploadToCloud(job, token)
      const result = await this.pollCloudResult(job, token, batchId, controller.signal)
      if (!isDone(result)) {
        await this.updateJobAndPersist(job.id, 'failed', undefined, result.err_msg ?? `解析状态 ${result.state}`)
        return
      }

      const extracted = await this.downloadAndExtractOrSettleFailed(job, result.full_zip_url ?? '')
      if (extracted === undefined) return
      const lastSeenProgress = this.get(job.id)?.progress
      await this.updateJobAndPersist(job.id, 'done', {
        ...jobFieldsFromExtractResult(extracted),
        ...(lastSeenProgress !== undefined ? { progress: { extractedPages: lastSeenProgress.totalPages, totalPages: lastSeenProgress.totalPages } } : {}),
      })
      this.logInfo(`作业 ${job.id} 转换完成：${extracted.markdown}（${extracted.lang}，${String(extracted.files.length)} 个文件，${extracted.commit}）`)
    } finally {
      this.abortControllerByJobId.delete(job.id)
    }
  }

  /** 回云端给的 batchId */
  private async uploadToCloud(job: Pdf2mdJob, token: string): Promise<string> {
    await this.updateJobAndPersist(job.id, 'uploading')
    const [batchId, uploadUrl] = await requestUpload(token, path.basename(job.input))
    await this.updateJobAndPersist(job.id, 'uploading', { batchId })
    await upload(uploadUrl, job.input)
    return batchId
  }

  private async pollCloudResult(job: Pdf2mdJob, token: string, batchId: string, signal: AbortSignal): Promise<FileResult> {
    await this.updateJobAndPersist(job.id, 'running')
    return poll(token, batchId, {
      interval: POLL_INTERVAL_SECONDS,
      stallTimeout: POLL_STALL_LIMIT_SECONDS,
      timeout: POLL_TOTAL_LIMIT_SECONDS,
      onProgress: (pending) => this.recordCloudProgress(job.id, pending),
      signal,
    })
  }

  /** 回 undefined 时这条作业已经记成 failed；归档已落盘的，账上带着归档路径 */
  private async downloadAndExtractOrSettleFailed(job: Pdf2mdJob, zipUrl: string): Promise<ExtractResult | undefined> {
    try {
      return await downloadExtract(zipUrl, job.outDir, extractOptionsFor(job))
    } catch (err) {
      const archive = err instanceof ArchiveError ? err.archive : undefined
      await this.updateJobAndPersist(job.id, 'failed', archive !== undefined ? { archive } : undefined, describeErrorWithCause(err))
      return undefined
    }
  }

  private recordCloudProgress(id: string, result: FileResult): void {
    const cloudProgress = result.extract_progress
    const previous = this.jobsById.get(id)
    if (cloudProgress === null || previous === undefined) return
    if (previous.progress?.extractedPages === cloudProgress.extracted_pages && previous.progress.totalPages === cloudProgress.total_pages) return
    const progress = { extractedPages: cloudProgress.extracted_pages, totalPages: cloudProgress.total_pages }
    this.jobsById.set(id, { ...previous, progress, updatedAt: nowIso() })
    void this.writeLedger()
  }

  /** 终态事件在账落盘之后才发：事件说「完成了」，账就得已经写上 */
  private async updateJobAndPersist(id: string, state: JobState, extra?: Partial<Pdf2mdJob>, error?: string): Promise<void> {
    const previous = this.jobsById.get(id)
    if (previous === undefined) return
    const next: Pdf2mdJob = { ...previous, ...extra, state, updatedAt: nowIso(), ...(error !== undefined ? { error } : {}) }
    this.jobsById.set(id, next)
    if (isSettled(state)) this.releaseOutDirClaim(next.outDir, id)
    await this.writeLedger()
    if (state === 'done' || state === 'failed') {
      requireKernel(this.providerContext).emit({
        source: PLUGIN_NAME,
        type: 'job-settled',
        jobId: id,
        ok: state === 'done',
        outDir: next.outDir,
        ...(next.error !== undefined ? { error: next.error } : {}),
      })
      if (state === 'failed') this.logWarn(`作业 ${id} 失败：${next.error ?? '没说原因'}`)
    }
  }

  /** 每次写轮到那一刻的整张账。失败不抛（后台链还在跑），submit 看 lastLedgerWriteError 决定拒收 */
  private writeLedger(): Promise<void> {
    this.ledgerWriteChain = this.ledgerWriteChain.then(async () => {
      try {
        await this.providerContext.gwbData?.writeDoc(JOBS_DOC_NAME, { jobs: this.list() })
        this.lastLedgerWriteError = undefined
      } catch (err: unknown) {
        this.lastLedgerWriteError = err
        this.logWarn(`作业账落盘失败（继续在内存里跑）：${String(err)}`)
      }
    })
    return this.ledgerWriteChain
  }

  private async loadLedgerMarkingLeftoversInterrupted(): Promise<void> {
    const doc = await this.providerContext.gwbData?.readDoc(JOBS_DOC_NAME).catch(() => undefined)
    if (!isRecord(doc) || !Array.isArray(doc['jobs'])) return
    let anyLeftoverMarked = false
    for (const raw of doc['jobs']) {
      if (!isRecord(raw)) continue
      const record = raw as unknown as Pdf2mdJob
      if (typeof record.id !== 'string' || typeof record.input !== 'string') continue
      if (isInFlight(record.state)) {
        this.jobsById.set(record.id, { ...record, state: 'interrupted', updatedAt: nowIso(), error: '宿主重启，作业没人接着跑' })
        anyLeftoverMarked = true
      } else {
        this.jobsById.set(record.id, record)
      }
    }
    if (anyLeftoverMarked) {
      this.logInfo(`启动对账：${String(this.jobsById.size)} 条作业入账，其中非终态已标 interrupted`)
      await this.writeLedger()
    } else if (this.jobsById.size > 0) {
      this.logInfo(`启动对账：${String(this.jobsById.size)} 条作业入账`)
    }
  }

  private async markInFlightJobsInterrupted(): Promise<void> {
    let anyJobMarked = false
    for (const job of this.jobsById.values()) {
      if (isInFlight(job.state)) {
        this.jobsById.set(job.id, { ...job, state: 'interrupted', updatedAt: nowIso(), error: '插件卸载，作业被打断' })
        this.releaseOutDirClaim(job.outDir, job.id)
        anyJobMarked = true
      }
    }
    if (anyJobMarked) await this.writeLedger()
  }
}

declare module 'cordis' {
  interface Context {
    gwbPdf2md: GwbPdf2mdApi
  }
}
