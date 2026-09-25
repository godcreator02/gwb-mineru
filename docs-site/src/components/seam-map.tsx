'use client'

import { useState, type KeyboardEvent } from 'react'

type ModuleId = 'runner' | 'client' | 'extract'

interface Box {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly title: string
  readonly code: string
  /** 属于本插件哪个模块；外面的东西没有 */
  readonly module?: ModuleId
}

interface Seam {
  readonly n: number
  readonly from: string
  readonly to: string
  /** 折线的点，首尾落在两端方块的边上 */
  readonly points: readonly (readonly [number, number])[]
  /** 编号圆圈的位置 */
  readonly badge: readonly [number, number]
  readonly onDisk: boolean
  readonly title: string
  readonly contract: string
}

const MODULE_FRAMES: readonly { id: ModuleId; x: number; y: number; w: number; h: number; label: string }[] = [
  { id: 'runner', x: 266, y: 190, w: 644, h: 212, label: '作业机 · src/index.ts' },
  { id: 'client', x: 266, y: 420, w: 314, h: 170, label: '云端客户端 · src/core/mineru.ts' },
  { id: 'extract', x: 596, y: 420, w: 314, h: 170, label: '解包 · src/core/extract.ts' },
]

const BOXES: readonly Box[] = [
  { id: 'agent', x: 490, y: 12, w: 190, h: 40, title: 'agent · 页面', code: 'MCP 入口 run / window.gwb' },
  { id: 'page', x: 700, y: 12, w: 200, h: 40, title: '页面', code: 'window.gwb.on' },
  { id: 'consumer', x: 280, y: 80, w: 190, h: 52, title: '消费方插件', code: '如 gwb-paper-fetch' },
  { id: 'bus', x: 490, y: 80, w: 190, h: 52, title: '命令总线', code: 'gwb-commands' },
  { id: 'kernel', x: 700, y: 80, w: 200, h: 52, title: '内核', code: 'gwbKernel.emit' },
  { id: 'settings', x: 20, y: 220, w: 200, h: 52, title: '设置插件', code: 'gwb-settings' },
  { id: 'data', x: 20, y: 280, w: 200, h: 52, title: '数据插件', code: 'gwb-data' },
  { id: 'skills', x: 20, y: 340, w: 200, h: 52, title: '说明书插件（可选）', code: 'gwb-skills' },
  { id: 'service', x: 280, y: 222, w: 190, h: 48, title: '服务 gwbPdf2md', code: 'submit · recover · get · list', module: 'runner' },
  { id: 'commands', x: 490, y: 222, w: 190, h: 48, title: '命令 pdf2md.*', code: 'submit · status · jobs · recover', module: 'runner' },
  { id: 'settled', x: 700, y: 222, w: 196, h: 48, title: '终态事件', code: 'job-settled', module: 'runner' },
  { id: 'ledger', x: 280, y: 282, w: 190, h: 48, title: '作业账', code: 'jobsById → writeLedger', module: 'runner' },
  { id: 'chain', x: 490, y: 282, w: 190, h: 48, title: '一条作业的全链', code: 'runFullChain', module: 'runner' },
  { id: 'claims', x: 700, y: 282, w: 196, h: 48, title: 'outDir 占用', code: 'jobIdByClaimedOutDir', module: 'runner' },
  { id: 'skill', x: 280, y: 342, w: 190, h: 48, title: '说明书', code: 'skills/pdf2md/SKILL.md', module: 'runner' },
  { id: 'upload', x: 282, y: 452, w: 282, h: 36, title: '申请上传位 · 上传', code: 'requestUpload · upload', module: 'client' },
  { id: 'poll', x: 282, y: 494, w: 282, h: 36, title: '轮询到终态', code: 'poll', module: 'client' },
  { id: 'errors', x: 282, y: 536, w: 282, h: 36, title: '回包认错', code: 'readResponseData → MineruError', module: 'client' },
  { id: 'unzip', x: 612, y: 452, w: 282, h: 36, title: '下载 · 从归档解', code: 'downloadExtract · extractArchive', module: 'extract' },
  { id: 'fence', x: 612, y: 494, w: 282, h: 36, title: '围栏', code: 'splitEntryNameThroughFence', module: 'extract' },
  { id: 'commit', x: 612, y: 536, w: 282, h: 36, title: '提交点', code: 'commitStagedIntoOutDir', module: 'extract' },
  { id: 'cloud', x: 266, y: 632, w: 314, h: 56, title: 'MinerU 云端', code: 'mineru.net API v4 · 预签名上传 · 结果 zip' },
  { id: 'work', x: 596, y: 632, w: 150, h: 56, title: '工作根', code: '.<outDir 名>.pdf2md/' },
  { id: 'out', x: 760, y: 632, w: 150, h: 56, title: 'outDir', code: 'full.md + images/' },
]

const SEAMS: readonly Seam[] = [
  {
    n: 1, from: 'consumer', to: 'service', points: [[375, 132], [375, 222]], badge: [375, 176], onDisk: false,
    title: '消费方插件 → 服务',
    contract: 'inject gwbPdf2md；submit(files) 回 Pdf2mdJob[]（state 是 queued，返回不是完成），recover(id)、get(id)、list()。形状是本包导出的 GwbPdf2mdApi 与 Pdf2mdJob。',
  },
  {
    n: 2, from: 'bus', to: 'commands', points: [[585, 132], [585, 222]], badge: [585, 176], onDisk: false,
    title: '命令总线 → 四条命令',
    contract: 'init 里 gwbCommands.register 四条：pdf2md.submit { files }、pdf2md.status { id }、pdf2md.jobs、pdf2md.recover { id }。回执是作业记录，形状同 Pdf2mdJob。',
  },
  {
    n: 3, from: 'settings', to: 'service', points: [[220, 246], [280, 246]], badge: [250, 246], onDisk: false,
    title: '设置插件 → 服务',
    contract: 'init 里 define { key: "token", type: "secret" }；submit 时 get("token") 现读。节名 mineru 由设置插件按条目 id 算出。',
  },
  {
    n: 4, from: 'data', to: 'ledger', points: [[220, 306], [280, 306]], badge: [250, 306], onDisk: false,
    title: '数据插件 → 作业账',
    contract: 'writeDoc("jobs", { jobs: Pdf2mdJob[] }) 每次写整张账，排成一条链；启动时 readDoc("jobs") 对账，非终态标 interrupted。',
  },
  {
    n: 5, from: 'settled', to: 'kernel', points: [[798, 222], [798, 132]], badge: [798, 176], onDisk: false,
    title: '终态事件 → 内核',
    contract: 'emit({ source: "gwb-mineru", type: "job-settled", jobId, ok, outDir, error? })，只在 done / failed 时发，账落盘之后才发。',
  },
  {
    n: 6, from: 'skills', to: 'skill', points: [[220, 366], [280, 366]], badge: [250, 366], onDisk: false,
    title: '说明书插件 → 说明书',
    contract: '局部注入 gwbSkills，register(包里的 skills/ 目录)。没装说明书插件时作业机照常加载。',
  },
  {
    n: 7, from: 'chain', to: 'upload', points: [[540, 330], [540, 452]], badge: [540, 410], onDisk: false,
    title: '全链 → 云端客户端',
    contract: 'requestUpload(token, 文件名) → [batchId, uploadUrl]；upload(uploadUrl, pdf 路径)；poll(token, batchId, { interval, stallTimeout, timeout, onProgress, signal }) → FileResult。',
  },
  {
    n: 8, from: 'chain', to: 'unzip', points: [[640, 330], [640, 452]], badge: [640, 410], onDisk: false,
    title: '全链 → 解包',
    contract: 'downloadExtract(zipUrl, outDir, { jobId, overwrite? }) 或 extractArchive(归档, outDir, …) → ExtractResult；失败抛 ArchiveError 一族，归档已落盘时带 archive 路径。',
  },
  {
    n: 9, from: 'poll', to: 'cloud', points: [[422, 590], [422, 632]], badge: [422, 611], onDisk: false,
    title: '云端客户端 → MinerU',
    contract: 'POST /file-urls/batch 申请上传位，PUT 预签名地址传 PDF，GET /extract-results/batch/{batchId} 轮询。回包 code / msgCode 非 0 抛 MineruError。',
  },
  {
    n: 10, from: 'unzip', to: 'cloud', points: [[612, 470], [588, 470], [588, 660], [580, 660]], badge: [588, 540], onDisk: false,
    title: '解包 → 结果 zip',
    contract: 'GET 云端给的 full_zip_url，600 秒超时；非 2xx 直接抛错，这时还没有归档。',
  },
  {
    n: 11, from: 'unzip', to: 'work', points: [[671, 590], [671, 632]], badge: [671, 611], onDisk: true,
    title: '解包 ⇢ 工作根',
    contract: 'archive-<作业号>.zip（先写 .part 再改名）、staged-<作业号>/、backup-<时间>/、commit-journal.json，都在 outDir 同级的 .<outDir 名>.pdf2md/ 里。',
  },
  {
    n: 12, from: 'commit', to: 'out', points: [[835, 590], [835, 632]], badge: [835, 611], onDisk: true,
    title: '提交点 ⇢ outDir',
    contract: 'staging 整体改名成 outDir：full.md + images/。outDir 已有东西默认拒，overwrite 时旧产物先整个挪进备份。',
  },
]

const BOX_BY_ID = new Map(BOXES.map((box) => [box.id, box]))

function seamTouchesModule(seam: Seam, module: ModuleId): boolean {
  return BOX_BY_ID.get(seam.from)?.module === module || BOX_BY_ID.get(seam.to)?.module === module
}

function activateOnEnterOrSpace(event: KeyboardEvent, activate: () => void): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    activate()
  }
}

export function SeamMap() {
  const [selectedSeam, setSelectedSeam] = useState<number | null>(null)
  const [selectedModule, setSelectedModule] = useState<ModuleId | null>(null)
  const seam = SEAMS.find((one) => one.n === selectedSeam)

  const seamIsLit = (one: Seam): boolean =>
    selectedSeam !== null ? one.n === selectedSeam : selectedModule !== null ? seamTouchesModule(one, selectedModule) : true
  const boxIsLit = (box: Box): boolean => {
    if (selectedSeam !== null) return box.id === seam?.from || box.id === seam?.to
    if (selectedModule !== null) {
      return box.module === selectedModule || SEAMS.some((one) => seamTouchesModule(one, selectedModule) && (one.from === box.id || one.to === box.id))
    }
    return true
  }
  const boxIsEnd = (box: Box): boolean => selectedSeam !== null && (box.id === seam?.from || box.id === seam?.to)

  const pickSeam = (n: number): void => {
    setSelectedModule(null)
    setSelectedSeam((current) => (current === n ? null : n))
  }
  const pickModule = (id: ModuleId): void => {
    setSelectedSeam(null)
    setSelectedModule((current) => (current === id ? null : id))
  }

  return (
    <figure className="not-prose my-6">
      <div className="grid gap-3">
        <svg viewBox="0 0 930 700" className="w-full h-auto select-none" role="img" aria-label="gwb-mineru 的接缝图">
          <defs>
            <marker id="seam-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="fill-fd-muted-foreground" />
            </marker>
          </defs>

          <rect x={250} y={160} width={670} height={444} rx={14} className="fill-none stroke-fd-border" strokeWidth={1.5} />
          <text x={262} y={180} className="fill-fd-muted-foreground" fontSize={12}>
            插件 @godcreator/gwb-mineru
          </text>

          {MODULE_FRAMES.map((frame) => {
            const lit = selectedModule === null ? selectedSeam === null : selectedModule === frame.id
            return (
              <g
                key={frame.id}
                role="button"
                tabIndex={0}
                aria-pressed={selectedModule === frame.id}
                onClick={() => pickModule(frame.id)}
                onKeyDown={(event) => activateOnEnterOrSpace(event, () => pickModule(frame.id))}
                className="cursor-pointer outline-none"
              >
                <rect
                  x={frame.x}
                  y={frame.y}
                  width={frame.w}
                  height={frame.h}
                  rx={10}
                  strokeDasharray="6 5"
                  strokeWidth={1.5}
                  className="fill-transparent transition-[stroke,opacity] duration-300 motion-reduce:transition-none"
                  style={{ stroke: selectedModule === frame.id ? 'var(--seam-accent)' : 'var(--seam-frame)', opacity: lit || selectedModule === frame.id ? 1 : 0.55 }}
                />
                <text x={frame.x + 14} y={frame.y + 18} fontSize={12.5} fontWeight={600} className="fill-fd-foreground">
                  {frame.label}
                </text>
              </g>
            )
          })}

          <line x1={585} y1={52} x2={585} y2={80} strokeWidth={1.2} markerEnd="url(#seam-arrow)" className="stroke-fd-muted-foreground" />
          <line x1={800} y1={80} x2={800} y2={52} strokeWidth={1.2} markerEnd="url(#seam-arrow)" className="stroke-fd-muted-foreground" />

          {SEAMS.map((one) => {
            const lit = seamIsLit(one)
            const chosen = selectedSeam === one.n
            return (
              <polyline
                key={`line-${String(one.n)}`}
                points={one.points.map(([x, y]) => `${String(x)},${String(y)}`).join(' ')}
                fill="none"
                strokeWidth={chosen ? 2.6 : 1.6}
                strokeDasharray={one.onDisk ? '5 4' : undefined}
                markerEnd="url(#seam-arrow)"
                className="transition-[stroke,opacity] duration-300 motion-reduce:transition-none"
                style={{ stroke: chosen ? 'var(--seam-accent)' : 'var(--seam-line)', opacity: lit ? 1 : 0.18 }}
              />
            )
          })}

          {BOXES.map((box) => {
            const lit = boxIsLit(box)
            const end = boxIsEnd(box)
            const outside = box.module === undefined
            return (
              <g key={box.id} className="transition-opacity duration-300 motion-reduce:transition-none" style={{ opacity: lit ? 1 : 0.28 }}>
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx={outside ? 6 : 5}
                  strokeWidth={end ? 2 : 1}
                  className={`transition-[stroke,fill] duration-300 motion-reduce:transition-none ${outside ? 'fill-fd-muted' : 'fill-fd-card'}`}
                  style={{ stroke: end ? 'var(--seam-accent)' : 'var(--seam-frame)', fill: end ? 'var(--seam-accent-soft)' : undefined }}
                />
                <text x={box.x + 10} y={box.y + (box.h > 44 ? 20 : 16)} fontSize={12} fontWeight={600} className="fill-fd-foreground">
                  {box.title}
                </text>
                <text x={box.x + 10} y={box.y + (box.h > 44 ? 38 : 30)} fontSize={10.5} fontFamily="var(--font-mono, monospace)" className="fill-fd-muted-foreground">
                  {box.code}
                </text>
              </g>
            )
          })}

          {SEAMS.map((one) => {
            const chosen = selectedSeam === one.n
            const [cx, cy] = one.badge
            return (
              <g
                key={`badge-${String(one.n)}`}
                role="button"
                tabIndex={0}
                aria-label={`接缝 ${String(one.n)}：${one.title}`}
                aria-pressed={chosen}
                onClick={() => pickSeam(one.n)}
                onKeyDown={(event) => activateOnEnterOrSpace(event, () => pickSeam(one.n))}
                className="cursor-pointer outline-none transition-opacity duration-300 motion-reduce:transition-none"
                style={{ opacity: seamIsLit(one) ? 1 : 0.35 }}
              >
                <circle
                  cx={cx}
                  cy={cy}
                  r={11}
                  strokeWidth={1.5}
                  className="transition-[fill,stroke] duration-300 motion-reduce:transition-none"
                  style={{ fill: chosen ? 'var(--seam-accent)' : 'var(--seam-badge)', stroke: 'var(--seam-accent)' }}
                />
                <text x={cx} y={cy + 4} textAnchor="middle" fontSize={11} fontWeight={700} style={{ fill: chosen ? 'var(--seam-badge)' : 'var(--seam-accent)' }}>
                  {one.n}
                </text>
              </g>
            )
          })}
        </svg>

        <figcaption className="min-h-24 rounded-lg border border-fd-border bg-fd-card p-4 text-sm leading-relaxed">
          {seam !== undefined ? (
            <>
              <div className="mb-1 text-xs text-fd-muted-foreground">
                接缝 {seam.n} · {seam.onDisk ? '读写磁盘' : '调用'}
              </div>
              <div className="mb-2 font-semibold">{seam.title}</div>
              <p className="text-fd-muted-foreground">{seam.contract}</p>
            </>
          ) : selectedModule !== null ? (
            <>
              <div className="mb-2 font-semibold">{MODULE_FRAMES.find((frame) => frame.id === selectedModule)?.label}</div>
              <p className="text-fd-muted-foreground">
                亮着的是它碰到的接缝：
                {SEAMS.filter((one) => seamTouchesModule(one, selectedModule))
                  .map((one) => String(one.n))
                  .join('、')}
                。再点一次模块名恢复全图。
              </p>
            </>
          ) : (
            <p className="text-fd-muted-foreground">
              点一个编号，看这条接缝两端是谁、中间传什么；点虚线框的模块名，只留跟它有关的接缝。实线是调用，虚线是读写磁盘。
            </p>
          )}
        </figcaption>
      </div>
    </figure>
  )
}
