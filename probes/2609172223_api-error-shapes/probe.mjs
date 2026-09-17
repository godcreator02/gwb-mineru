// 问：token 无效、不带鉴权、任务号不存在时，MinerU v4 各回什么形状（HTTP 状态码 + 正文键）。
// 全是查询或带坏 token 的请求，不建任务、不扣额度。
// 跑：node probe.mjs —— 「真 token」那两格要先设环境变量 MINERU_TOKEN，不设就跳过；输出里不打印 token。

const BASE = 'https://mineru.net/api/v4'
const BOGUS = '00000000-0000-0000-0000-000000000000'
const BAD = 'Bearer sk-invalid-probe-token'

const cases = [
  { name: '坏 token，申请上传位（插件第一步）', method: 'POST', url: `${BASE}/file-urls/batch`, auth: BAD, body: { files: [{ name: 'probe.pdf' }] } },
  { name: '坏 token，查批次结果（插件轮询那步）', method: 'GET', url: `${BASE}/extract-results/batch/${BOGUS}`, auth: BAD },
  { name: '坏 token，查单任务', method: 'GET', url: `${BASE}/extract/task/${BOGUS}`, auth: BAD },
  { name: '不带鉴权，查批次结果', method: 'GET', url: `${BASE}/extract-results/batch/${BOGUS}` },
]
const token = process.env.MINERU_TOKEN
if (token) {
  cases.push(
    { name: '真 token，查不存在的批次', method: 'GET', url: `${BASE}/extract-results/batch/${BOGUS}`, auth: `Bearer ${token}` },
    { name: '真 token，查不存在的单任务', method: 'GET', url: `${BASE}/extract/task/${BOGUS}`, auth: `Bearer ${token}` },
  )
}

console.log(`# MinerU v4 错误形状  ${new Date().toISOString()}  node ${process.version}  真 token 那两格：${token ? '跑了' : '跳过（没设 MINERU_TOKEN）'}\n`)
for (const c of cases) {
  const headers = {}
  if (c.auth) headers.Authorization = c.auth
  if (c.body) headers['Content-Type'] = 'application/json'
  const resp = await fetch(c.url, { method: c.method, headers, body: c.body ? JSON.stringify(c.body) : undefined })
  const text = await resp.text()
  console.log(`## ${c.name}\n${c.method} ${c.url.replace(BASE, '/api/v4')}\nHTTP ${resp.status} ${resp.statusText}\ncontent-type: ${resp.headers.get('content-type')}\n${text}\n`)
}
