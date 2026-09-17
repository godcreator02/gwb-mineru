# MinerU v4：token 错与任务不存在时回什么形状

## 问什么

token 无效、不带鉴权、任务号不存在时，MinerU 精准解析 API v4 各回什么 HTTP 状态码、正文里错误码住哪个键——决定插件的回包解读先认状态码还是先认正文。

## 怎么跑

```powershell
node probe.mjs > runs/02-rerun.txt
```

零依赖（node 内置 fetch）。只发查询与带坏 token 的请求，不建任务、不扣额度。「真 token」那两格要先 `$env:MINERU_TOKEN = '<token>'`，不设就跳过；输出里不打印 token。

## 结论

**token 错不是「HTTP 200 + code」，是 HTTP 401 + JSON 正文，错误码的键叫 `msgCode` 不叫 `code`**：坏 token 在申请上传位、查批次、查单任务三处一律 `401 {"msgCode":"A0211","msg":"user token expired",...}`——乱写的 token 也报 A0211（过期），不是文档表里的 A0202。不带鉴权是 `401 text/plain login required`，没有 JSON。真 token 查不存在的任务才是文档写的形状：`200 {"code":-60012,"msg":"task not found or expire"}`。

所以回包解读要先认正文里的 `code` / `msgCode`、再认状态码；只看 `resp.ok` 的写法（0.1.0）把 token 错吞成一句 `HTTP 401 Unauthorized`。原始输出：`runs/01-shapes.txt`。

## 跑那次的环境

2026-09-17 22:24 +0800，Windows 11 Pro 10.0.26200，node v24.14.1。被测对象是 mineru.net 云端（无版本号）；插件侧对应 gwb-mineru commit `eaf1ee1`。
