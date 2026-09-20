import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Service } from 'cordis'
import { isRecord, requireKernel, type GwbContext } from '@godcreator/gwb-plugin-api'
// 只为激活 commands / data / skills / settings 四个件给 cordis Context 加的服务名。
// type-only，运行期不欠它们；static inject 那三个名字靠这些声明才有类型
import type {} from '@godcreator/gwb-commands'
import type {} from '@godcreator/gwb-data'
import type {} from '@godcreator/gwb-settings'
import type {} from '@godcreator/gwb-skills'
import { downloadExtract } from './core/extract.js'
import { MAX_FILE_BYTES, isDone, poll, requestUpload, upload, type FileResult } from './core/mineru.js'

/**
 * pdf2md 服务：MinerU 云端转换的作业机。**submit 秒回、后台跑完落盘**——
 * 命令是页面等着的一次调用，分钟级的云端解析绝不能在线等；作业号先回，终态经
 * `gwbKernel.emit` 推一条事件。
 *
 * **件叫 gwb-mineru、服务叫 gwbPdf2md——名字不对应是有意的**（对着本仓惯例
 * 「服务名跟件名走」的唯一例外）：件名说**谁在干活**（MinerU 引擎），服务名与
 * 命令前缀说**干的是什么**（pdf2md）。消费方 inject 的永远是 `gwbPdf2md`。
 *
 * 零库概念：输入一个 PDF 绝对路径、一个输出目录，产出完整 markdown + images/ 原样落
 * outDir（markdown 文件名、语言判定、文件清单记在作业上）。「归档副本、成品位命名」那套
 * 篇目录布局是调用方（如 papers）的私有约定，不在这儿。
 *
 * 三个邻居服务走 `static inject` 硬依赖（gwb-node-cli 的同款姿势）：settings（token）、
 * data（作业账）、commands（命令那面）。缺谁这个件不挂——比挂上之后半身不遂好查。
 * 用的时候一律 `this.own.<服务>` 现取。**设置项必须在 init 里 define**：不声明的话
 * get 永远回 undefined——实机撞过一轮，症状是「token 明明在 settings.json 里，
 * 命令却报没配」。
 */

const PLUGIN_NAME = 'gwb-mineru'
/** 命令登记的 plugin 字段认包名 */
const PACKAGE_NAME = '@godcreator/gwb-mineru'
const JOBS_DOC = 'jobs'

/** 轮询节奏与上限（秒）：5 秒一问；云端干活时进度停滞 10 分钟判失败；连排队在内总上限 1 小时 */
const POLL_INTERVAL_S = 5
const POLL_STALL_S = 600
const POLL_TIMEOUT_S = 3600

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
  /** 云端报来的解析进度（running 时才有；done 时补满） */
  readonly progress?: { readonly extractedPages: number; readonly totalPages: number }
  /** 转换成功后交出的三样 */
  readonly markdown?: string
  readonly lang?: 'zh' | 'en'
  readonly files?: readonly string[]
}

/** 一次提交里的一条：一个 PDF 进、一个 outDir 出 */
export interface Pdf2mdSubmitInput {
  readonly input: string
  readonly outDir: string
}

/** 消费方拿到的那一格。写 `inject: ['gwbPdf2md']` 才有 */
export interface GwbPdf2mdApi {
  /**
   * 提交一批转换作业（一作业一文件）。验完全部文件与目录、落完账才返回——**返回不是完成**，
   * 成败看 get(id) 的 state。作业各自独立、**同时开跑**（云端各转各的，谁先完谁先落）。
   * 传半个坏形状进来是整批拒，不落半批账
   */
  submit(files: readonly Pdf2mdSubmitInput[]): Promise<Pdf2mdJob[]>
  /** 查一条。没有这个 id 回 undefined */
  get(id: string): Pdf2mdJob | undefined
  /** 此刻账上的全部作业，新的在前 */
  list(): Pdf2mdJob[]
}

/** 设置：一枚凭据。节名跟 cordis.yml 条目 id 走（mineru），声明在 init 里——不声明的话 get 永远回 undefined（实机撞过） */
const TOKEN_DEF = {
  key: 'token',
  title: 'MinerU Token',
  type: 'secret',
  description: 'MinerU 云端转换的 API token，https://mineru.net 申请',
} as const

function nowIso(): string {
  return new Date().toISOString()
}

/** 错误连同 cause 一起说：fetch 失败时真原因（ECONNRESET、连接超时之类）只在 cause 里 */
function describeError(err: unknown): string {
  if (!(err instanceof Error) || err.cause === undefined) return String(err)
  const cause = err.cause
  if (!(cause instanceof Error)) return `${String(err)}（${String(cause)}）`
  const code = (cause as { code?: unknown }).code
  const withCode = typeof code === 'string' && !cause.message.includes(code) ? `${cause.message} ${code}` : cause.message
  return `${String(err)}（${withCode}）`
}

export default class GwbMineru extends Service implements GwbPdf2mdApi {
  /** settings / data / commands 三个硬依赖缺谁不挂 */
  static inject = ['gwbCommands', 'gwbSettings', 'gwbData']

  /**
   * 提供方自己的 ctx。方法里的 `this.ctx` 是**消费者**的——作业的命脉（定时器、
   * 落账、收尾）全挂在提供方身上，消费者卸载不该带走一个还在跑的转换
   */
  private readonly own: GwbContext
  private readonly info: (message: string) => void
  private readonly warn: (message: string) => void
  /** 作业账：id → 记录。落盘经 gwbData */
  private readonly table = new Map<string, Pdf2mdJob>()
  private readonly controllers = new Map<string, AbortController>()
  private jobSeq = 0
  /** 作业账写盘一个接一个：同一个文件并发 rename，Windows 上会 EPERM */
  private saving: Promise<void> = Promise.resolve()
  /** 最近一次落盘的失败；写成了清空。submit 靠它兑现「账落不了盘整批拒」 */
  private lastPersistError: unknown = undefined
  /** 启动对账那一次。submit 先等它——不等的话首笔账可能赶在旧账载入前落盘，把旧账冲掉 */
  private loadPromise: Promise<void> = Promise.resolve()

  constructor(ctx: GwbContext) {
    super(ctx, 'gwbPdf2md')
    this.own = ctx
    const logger = ctx.logger(PLUGIN_NAME)
    this.info = (message: string): void => logger.info(message)
    this.warn = (message: string): void => logger.warn(message)
  }

  [Service.init](): void {
    // 件卸载：还在跑的作业全部打断、记 interrupted——不丢账、不假装还在跑
    this.own.effect(() => () => {
      for (const controller of this.controllers.values()) controller.abort()
      void this.settleInterrupted().catch(() => undefined)
    })

    // 声明那一格设置。define 回注销函数，effect 包着走自动摘
    this.own.effect(() => this.own.gwbSettings.define(TOKEN_DEF))

    const cli = this.own.gwbCommands
    if (cli === undefined) return
    this.own.effect(() =>
      cli.register(
        { name: 'pdf2md.submit', description: '提交一批 PDF 转 markdown 作业：{ files: [{ input, outDir }, …] }。秒回作业号数组；作业各自独立同时跑，成败看 pdf2md.status', plugin: PACKAGE_NAME },
        async (args) => {
          const raw = isRecord(args) ? args : {}
          const files = raw['files']
          if (!Array.isArray(files) || files.length === 0) throw new Error('pdf2md.submit 要 { files: [{ input, outDir }, …] } 非空数组')
          const parsed: Pdf2mdSubmitInput[] = []
          for (const one of files) {
            if (!isRecord(one) || typeof one['input'] !== 'string' || typeof one['outDir'] !== 'string') {
              throw new Error('files 里每一项都得是 { input, outDir }（绝对路径）')
            }
            parsed.push({ input: one['input'], outDir: one['outDir'] })
          }
          return this.submit(parsed)
        },
      ),
    )
    this.own.effect(() =>
      cli.register({ name: 'pdf2md.jobs', description: '全部转换作业（新的在前）', plugin: PACKAGE_NAME }, () => ({
        count: this.table.size,
        jobs: this.list(),
      })),
    )
    this.own.effect(() =>
      cli.register({ name: 'pdf2md.status', description: '查一条转换作业：{ id }。云端解析中带 progress（已解析页 / 总页）', plugin: PACKAGE_NAME }, (args) => {
        const raw = isRecord(args) ? args : {}
        const id = raw['id']
        if (typeof id !== 'string' || id === '') throw new Error('pdf2md.status 要 { id: string }')
        const job = this.get(id)
        if (job === undefined) throw new Error(`没有这个作业：${id}`)
        return job
      }),
    )

    // 说明书那一格，局部注入：没装 skills 件的 home 里作业机照常挂
    this.own.inject(['gwbSkills'], (scoped) => {
      scoped.effect(() => scoped.gwbSkills.register(new URL('../skills/', import.meta.url)))
    })

    // 启动对账：上一次运行留下的非终态作业，如今没人再轮询了。promise 存下来给
    // submit 当门槛——旧账没对完之前收新作业，首笔落账会把还没载入的旧账冲掉
    this.loadPromise = this.load().catch(() => undefined)
    this.info('mineru 作业机就绪（ctx.gwbPdf2md，件 gwb-mineru）')
  }

  /**
   * 提交一批转换作业。验完全部、落完账才返回——**返回不是完成**，作业各自独立、同时开跑。
   * 传坏形状（路径不是绝对、文件不存在、超 200MB、token 没配）整批当场拒，不落半批账；
   * 账落不了盘也整批拒并撤回入列——回了作业号就是「跨重启查得到」的承诺，兑现不了就别回。
   * 这里的同步段只有本地验证与一次落账（毫秒级）——「秒回」约束挡的是分钟级云端解析，不冲突
   */
  async submit(files: readonly Pdf2mdSubmitInput[]): Promise<Pdf2mdJob[]> {
    if (!Array.isArray(files) || files.length === 0) throw new Error('submit 要 files: [{ input, outDir }, …] 非空数组')
    const token = this.token()
    if (token === undefined) throw new Error('MinerU token 没配——先在设置里填，或 settings.set { section: "mineru", key: "token", value: "…" }')
    for (const one of files) {
      if (!path.isAbsolute(one.input)) throw new Error(`input 得是绝对路径：${one.input}`)
      if (!path.isAbsolute(one.outDir)) throw new Error(`outDir 得是绝对路径：${one.outDir}`)
      const fileStat = await stat(one.input).catch(() => undefined)
      if (fileStat === undefined || !fileStat.isFile()) throw new Error(`input 不是个能读的文件：${one.input}`)
      if (fileStat.size > MAX_FILE_BYTES) throw new Error(`input 超过 MinerU 单文件上限 200MB，拆小了再提：${one.input}`)
    }
    await Promise.all([...new Set(files.map((f) => f.outDir))].map((outDir) => mkdir(outDir, { recursive: true })))
    await this.loadPromise

    const at = nowIso()
    const jobs = files.map((one) => {
      const id = `${at.replaceAll(/[-:TZ.]/g, '').slice(0, 14)}-${String(++this.jobSeq)}`
      const job: Pdf2mdJob = { id, input: one.input, outDir: one.outDir, state: 'queued', createdAt: at, updatedAt: at }
      this.table.set(id, job)
      this.info(`作业 ${id} 入列：${path.basename(one.input)} → ${one.outDir}`)
      return job
    })
    await this.persist()
    if (this.lastPersistError !== undefined) {
      // 撤账再拒：内存账当场干净。盘上多写的几条 queued 无人开跑，重启对账会标 interrupted
      for (const job of jobs) this.table.delete(job.id)
      throw new Error(`作业账落不了盘，这批不收（重试前先看数据盘）：${describeError(this.lastPersistError)}`)
    }
    for (const job of jobs) this.start(job, token)
    return jobs
  }

  get(id: string): Pdf2mdJob | undefined {
    return this.table.get(id)
  }

  list(): Pdf2mdJob[] {
    return [...this.table.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** token 现取现读：settings 改值不重挂件就生效 */
  private token(): string | undefined {
    const value = this.own.gwbSettings?.get('token')
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  /** 一条作业的全链：报名 → 上传 → 轮询 → 下载解包，每步落账，终态推 UI 事件。
   * 作业各跑各的、互不排队——云端本来就是一个任务一个任务地转 */
  private start(job: Pdf2mdJob, token: string): void {
    void this.run(job, token).catch(async (err: unknown) => {
      // run 自己管状态收尾，这里只兜「run 自己炸了」的那种没人接的异常
      this.warn(`作业 ${job.id} 的执行链炸了：${describeError(err)}`)
      await this.finish(job.id, 'failed', undefined, describeError(err))
    })
  }

  private async run(job: Pdf2mdJob, token: string): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    try {
      await this.finish(job.id, 'uploading')
      const fileName = path.basename(job.input)
      const [batchId, uploadUrl] = await requestUpload(token, fileName)
      await this.finish(job.id, 'uploading', { batchId })
      await upload(uploadUrl, job.input)

      await this.finish(job.id, 'running')
      const result: FileResult = await poll(token, batchId, {
        interval: POLL_INTERVAL_S,
        stallTimeout: POLL_STALL_S,
        timeout: POLL_TIMEOUT_S,
        onProgress: (pending) => this.noteProgress(job.id, pending),
        signal: controller.signal,
      })
      if (!isDone(result)) {
        await this.finish(job.id, 'failed', undefined, result.err_msg ?? `解析状态 ${result.state}`)
        return
      }

      const extracted = await downloadExtract(result.full_zip_url ?? '', job.outDir)
      const seen = this.get(job.id)?.progress
      await this.finish(job.id, 'done', {
        markdown: extracted.markdown,
        lang: extracted.lang,
        files: [...extracted.files],
        ...(seen !== undefined ? { progress: { extractedPages: seen.totalPages, totalPages: seen.totalPages } } : {}),
      })
      this.info(`作业 ${job.id} 转换完成：${extracted.markdown}（${extracted.lang}，${String(extracted.files.length)} 个文件）`)
    } finally {
      this.controllers.delete(job.id)
    }
  }

  /** 轮询回包带来的进度：变了才落账，没变不写盘。只记账不推事件 */
  private noteProgress(id: string, result: FileResult): void {
    const cloud = result.extract_progress
    const prev = this.table.get(id)
    if (cloud === null || prev === undefined) return
    if (prev.progress?.extractedPages === cloud.extracted_pages && prev.progress.totalPages === cloud.total_pages) return
    const progress = { extractedPages: cloud.extracted_pages, totalPages: cloud.total_pages }
    this.table.set(id, { ...prev, progress, updatedAt: nowIso() })
    void this.persist()
  }

  /** 状态推进 + 落账。终态事件在**账落盘之后**才发——事件说「完成了」，账就得已经写上 */
  private async finish(id: string, state: JobState, extra?: Partial<Pdf2mdJob>, error?: string): Promise<void> {
    const prev = this.table.get(id)
    if (prev === undefined) return
    const next: Pdf2mdJob = { ...prev, ...extra, state, updatedAt: nowIso(), ...(error !== undefined ? { error } : {}) }
    this.table.set(id, next)
    await this.persist()
    if (state === 'done' || state === 'failed') {
      requireKernel(this.own).emit({
        source: PLUGIN_NAME,
        type: 'job-settled',
        jobId: id,
        ok: state === 'done',
        outDir: next.outDir,
        ...(next.error !== undefined ? { error: next.error } : {}),
      })
      if (state === 'failed') this.warn(`作业 ${id} 失败：${next.error ?? '没说原因'}`)
    }
  }

  /** 作业账落盘，排队写：每次写的是轮到那一刻的整张账。失败不抛（后台链还在跑），
   *  记进 lastPersistError 给 submit 当拒收依据 */
  private persist(): Promise<void> {
    this.saving = this.saving.then(async () => {
      try {
        await this.own.gwbData?.writeDoc(JOBS_DOC, { jobs: this.list() })
        this.lastPersistError = undefined
      } catch (err: unknown) {
        this.lastPersistError = err
        this.warn(`作业账落盘失败（继续在内存里跑）：${String(err)}`)
      }
    })
    return this.saving
  }

  /** 启动对账：把上次留下的非终态作业标 interrupted */
  private async load(): Promise<void> {
    const doc = await this.own.gwbData?.readDoc(JOBS_DOC).catch(() => undefined)
    if (!isRecord(doc) || !Array.isArray(doc['jobs'])) return
    let changed = false
    for (const raw of doc['jobs']) {
      if (!isRecord(raw)) continue
      const record = raw as unknown as Pdf2mdJob
      if (typeof record.id !== 'string' || typeof record.input !== 'string') continue
      if (record.state === 'queued' || record.state === 'uploading' || record.state === 'running') {
        this.table.set(record.id, { ...record, state: 'interrupted', updatedAt: nowIso(), error: '宿主重启，作业没人接着跑' })
        changed = true
      } else {
        this.table.set(record.id, record)
      }
    }
    if (changed) {
      this.info(`启动对账：${String(this.table.size)} 条作业入账，其中非终态已标 interrupted`)
      await this.persist()
    } else if (this.table.size > 0) {
      this.info(`启动对账：${String(this.table.size)} 条作业入账`)
    }
  }

  private async settleInterrupted(): Promise<void> {
    let changed = false
    for (const job of this.table.values()) {
      if (job.state === 'queued' || job.state === 'uploading' || job.state === 'running') {
        this.table.set(job.id, { ...job, state: 'interrupted', updatedAt: nowIso(), error: '件卸载，作业被打断' })
        changed = true
      }
    }
    if (changed) await this.persist()
  }
}

declare module 'cordis' {
  interface Context {
    gwbPdf2md: GwbPdf2mdApi
  }
}
