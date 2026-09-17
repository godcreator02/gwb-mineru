// 问：0.2.0 的 poll 与回包解读是否按设计走——排队不判停滞、解析中页数不动判停滞、总上限、
// 业务错（含 401 + msgCode）翻成照着能做的话、认不出正文的非 2xx 报 HTTP 错。
// 喂假 fetch，零网络零依赖；被测的是冻结在 input/mineru.js 的那份产物（gwb-mineru eaf1ee1 的 dist/core/mineru.js）。
// 跑：node probe.mjs

import { poll, requestUpload } from './input/mineru.js'

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const entry = (state, extracted) => ({
  code: 0,
  data: {
    extract_result: [
      {
        file_name: 'a.pdf',
        state,
        err_msg: '',
        ...(extracted === undefined ? {} : { extract_progress: { extracted_pages: extracted, total_pages: 10, start_time: 'x' } }),
      },
    ],
  },
})
const done = () => json(200, { code: 0, data: { extract_result: [{ file_name: 'a.pdf', state: 'done', full_zip_url: 'z', err_msg: '' }] } })

function script(responses) {
  let i = 0
  globalThis.fetch = async () => responses[Math.min(i++, responses.length - 1)]()
}
const describe = (err) => `${err.name}: ${err.message}`

const base = { interval: 0.02, signal: new AbortController().signal }
const results = {}

// 1. 排队 8 轮（0.16s，远超 0.05s 的停滞上限）不判停滞，之后解析、完成
script([...Array(8).fill(() => json(200, entry('pending'))), () => json(200, entry('running', 3)), () => json(200, entry('running', 7)), done])
const seen = []
results['1 排队久不判停滞→done'] = await poll('t', 'b', {
  ...base,
  stallTimeout: 0.05,
  timeout: 10,
  onProgress: (r) => seen.push(`${r.state}:${r.extract_progress?.extracted_pages ?? '-'}`),
})
results['1 onProgress 依次看到'] = seen

// 2. running 页数一直是 4 → 停滞判 failed
script([() => json(200, entry('running', 4))])
results['2 解析中页数不动→停滞'] = await poll('t', 'b', { ...base, stallTimeout: 0.1, timeout: 10, onProgress: () => {} })

// 3. 一直排队 → 总上限判 failed
script([() => json(200, entry('pending'))])
results['3 一直排队→总上限'] = await poll('t', 'b', { ...base, stallTimeout: 0.05, timeout: 0.15, onProgress: () => {} })

// 4. HTTP 401 + msgCode A0211（真云端坏 token 的形状，见 probes/2609172223_api-error-shapes）
script([() => json(401, { traceId: 'x', msgCode: 'A0211', msg: 'user token expired', data: null, success: false, total: 0 })])
results['4 401+msgCode A0211'] = await requestUpload('t', 'a.pdf').catch(describe)

// 5. HTTP 200 + 业务码 -60018
script([() => json(200, { code: -60018, msg: 'limit' })])
results['5 200+code -60018'] = await requestUpload('t', 'a.pdf').catch(describe)

// 6. 认不出正文的 401（真云端不带鉴权时回纯文本 login required）
script([() => new Response('login required', { status: 401, statusText: 'Unauthorized' })])
results['6 纯文本 401'] = await requestUpload('t', 'a.pdf').catch(describe)

console.log(`# poll 与回包解读（假 fetch）  ${new Date().toISOString()}  node ${process.version}\n`)
console.log(JSON.stringify(results, null, 2))
