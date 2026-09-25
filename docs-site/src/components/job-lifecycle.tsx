'use client'

import { useState } from 'react'

type JobState = 'queued' | 'uploading' | 'running' | 'done' | 'failed' | 'interrupted'

interface Step {
  readonly state: JobState
  readonly what: string
  /** 这一步写进作业账的字段 */
  readonly ledger: string
  readonly event?: string
}

interface Scenario {
  readonly id: string
  readonly label: string
  readonly steps: readonly Step[]
}

const STATE_POS: Readonly<Record<JobState, { x: number; y: number }>> = {
  queued: { x: 70, y: 110 },
  uploading: { x: 220, y: 110 },
  running: { x: 370, y: 110 },
  done: { x: 560, y: 40 },
  failed: { x: 560, y: 110 },
  interrupted: { x: 560, y: 180 },
}

const EDGES: readonly (readonly [JobState, JobState])[] = [
  ['queued', 'uploading'],
  ['uploading', 'running'],
  ['running', 'done'],
  ['running', 'failed'],
  ['running', 'interrupted'],
  ['failed', 'done'],
]

const SUBMIT: Step = {
  state: 'queued',
  what: 'submit 检查完整批、占住 D:/papers/a、把作业写进作业账，然后立即返回作业号',
  ledger: 'id、input、outDir、state、createdAt',
}
const UPLOAD: Step = {
  state: 'uploading',
  what: '向 MinerU 申请上传位，拿到 batchId，再把 PDF 上传到预签名地址',
  ledger: 'state，随后补上 batchId',
}
const POLL: Step = {
  state: 'running',
  what: '每 5 秒问一次云端；已解析页数变了才重写作业账',
  ledger: 'state，页数变化时写 progress',
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'happy',
    label: '正常完成',
    steps: [
      SUBMIT,
      UPLOAD,
      POLL,
      {
        state: 'done',
        what: '下载 zip、在工作根留归档、过围栏、在 staging 里解完，整个改名成 D:/papers/a；放开 outDir',
        ledger: 'markdown、lang、files、skipped、archive、commit；轮询时见过进度的，progress 补满',
        event: 'job-settled，ok: true',
      },
    ],
  },
  {
    id: 'cloud-failed',
    label: '云端解析失败',
    steps: [
      SUBMIT,
      UPLOAD,
      POLL,
      {
        state: 'failed',
        what: '云端回 failed，或停滞 10 分钟、或 1 小时没完；还没下载过 zip，没有归档，recover 会拒，要结果只能重新提交',
        ledger: 'error（云端的 err_msg 或停滞 / 超时的说明）',
        event: 'job-settled，ok: false',
      },
    ],
  },
  {
    id: 'recover',
    label: '解包失败后 recover',
    steps: [
      SUBMIT,
      UPLOAD,
      POLL,
      {
        state: 'failed',
        what: '归档已经写好，但提交时 D:/papers/a 里被人放了东西，提交点拒绝、outDir 一个字节没动；放开 outDir',
        ledger: 'error、archive',
        event: 'job-settled，ok: false',
      },
      {
        state: 'done',
        what: '清掉 outDir 后调 pdf2md.recover，用归档把解包重做一遍：不申请上传位、不上传、不轮询',
        ledger: 'markdown、lang、files、skipped、commit',
        event: 'job-settled，ok: true',
      },
    ],
  },
  {
    id: 'restart',
    label: '宿主重启',
    steps: [
      SUBMIT,
      UPLOAD,
      POLL,
      {
        state: 'interrupted',
        what: '宿主重启后读回作业账，没到终态的一律标 interrupted，不重跑、不发事件；有归档的可以 recover，没有的重新提交',
        ledger: 'state、error「宿主重启，作业没人接着跑」',
      },
    ],
  },
]

const NODE_W = 104
const NODE_H = 38

function edgePath(from: JobState, to: JobState): string {
  const a = STATE_POS[from]
  const b = STATE_POS[to]
  if (from === 'failed' && to === 'done') {
    const x = b.x + NODE_W / 2 + 10
    return `M ${String(a.x + NODE_W / 2)} ${String(a.y)} C ${String(x + 30)} ${String(a.y)}, ${String(x + 30)} ${String(b.y)}, ${String(b.x + NODE_W / 2)} ${String(b.y)}`
  }
  return `M ${String(a.x + NODE_W / 2)} ${String(a.y)} L ${String(b.x - NODE_W / 2)} ${String(b.y)}`
}

export function JobLifecycle() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id)
  const [stepIndex, setStepIndex] = useState(0)
  const scenario = SCENARIOS.find((one) => one.id === scenarioId) ?? SCENARIOS[0]!
  const step = scenario.steps[stepIndex]!
  const visitedStates = new Set(scenario.steps.slice(0, stepIndex + 1).map((one) => one.state))
  const walkedEdges = new Set(
    scenario.steps.slice(1, stepIndex + 1).map((one, index) => `${scenario.steps[index]!.state}>${one.state}`),
  )

  const pickScenario = (id: string): void => {
    setScenarioId(id)
    setStepIndex(0)
  }

  return (
    <figure className="not-prose my-6 rounded-lg border border-fd-border bg-fd-card p-4">
      <div className="mb-3 flex flex-wrap gap-2">
        {SCENARIOS.map((one) => (
          <button
            key={one.id}
            type="button"
            onClick={() => pickScenario(one.id)}
            aria-pressed={one.id === scenarioId}
            className={`rounded-md border px-3 py-1 text-sm transition-colors motion-reduce:transition-none ${
              one.id === scenarioId ? 'border-transparent text-fd-background' : 'border-fd-border text-fd-muted-foreground hover:text-fd-foreground'
            }`}
            style={one.id === scenarioId ? { background: 'var(--seam-accent)' } : undefined}
          >
            {one.label}
          </button>
        ))}
      </div>

      <svg viewBox="0 0 700 220" className="w-full h-auto" role="img" aria-label={`作业状态变化：${scenario.label}`}>
        <defs>
          <marker id="lifecycle-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: 'var(--seam-line)' }} />
          </marker>
        </defs>
        {EDGES.map(([from, to]) => {
          const walked = walkedEdges.has(`${from}>${to}`)
          return (
            <path
              key={`${from}>${to}`}
              d={edgePath(from, to)}
              fill="none"
              strokeWidth={walked ? 2.4 : 1.2}
              markerEnd="url(#lifecycle-arrow)"
              className="transition-[stroke,opacity] duration-300 motion-reduce:transition-none"
              style={{ stroke: walked ? 'var(--seam-accent)' : 'var(--seam-line)', opacity: walked ? 1 : 0.45 }}
            />
          )
        })}
        {(Object.keys(STATE_POS) as JobState[]).map((state) => {
          const { x, y } = STATE_POS[state]
          const current = state === step.state
          const visited = visitedStates.has(state)
          return (
            <g key={state} className="transition-opacity duration-300 motion-reduce:transition-none" style={{ opacity: visited ? 1 : 0.45 }}>
              <rect
                x={x - NODE_W / 2}
                y={y - NODE_H / 2}
                width={NODE_W}
                height={NODE_H}
                rx={NODE_H / 2}
                strokeWidth={current ? 2.4 : 1.2}
                className="transition-[stroke,fill] duration-300 motion-reduce:transition-none"
                style={{
                  stroke: current ? 'var(--seam-accent)' : 'var(--seam-frame)',
                  fill: current ? 'var(--seam-accent-soft)' : 'var(--color-fd-background)',
                }}
              />
              <text x={x} y={y + 4} textAnchor="middle" fontSize={13} fontFamily="var(--font-mono, monospace)" className="fill-fd-foreground">
                {state}
              </text>
            </g>
          )
        })}
        <text x={610} y={214} textAnchor="middle" fontSize={11} className="fill-fd-muted-foreground">
          右边三个是终态
        </text>
      </svg>

      <div className="mt-3 grid gap-1 text-sm">
        <div className="text-xs text-fd-muted-foreground">
          第 {stepIndex + 1} 步 / 共 {scenario.steps.length} 步 · <code>{step.state}</code>
        </div>
        <p>{step.what}</p>
        <p className="text-fd-muted-foreground">写进作业账：{step.ledger}</p>
        <p className="text-fd-muted-foreground">推给页面的事件：{step.event ?? '无'}</p>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
          disabled={stepIndex === 0}
          className="rounded-md border border-fd-border px-3 py-1 text-sm disabled:opacity-40"
        >
          上一步
        </button>
        <button
          type="button"
          onClick={() => setStepIndex((index) => Math.min(scenario.steps.length - 1, index + 1))}
          disabled={stepIndex === scenario.steps.length - 1}
          className="rounded-md border border-fd-border px-3 py-1 text-sm disabled:opacity-40"
        >
          下一步
        </button>
      </div>
    </figure>
  )
}
