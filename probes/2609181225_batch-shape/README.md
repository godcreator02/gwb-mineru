# MinerU v4 一批多文件的真实形状，与终态后的结果留存

## 问什么

1. 一个 `file-urls/batch` 带多个文件：`file_urls` 是不是按序对应 `files`，轮询回的 `extract_result` 是不是每文件一条、各带各的终态与 zip
2. 一批里混一个坏文件（随机字节 .pdf），其余文件活不活得成——部分失败形状，决定将来批量 API 的粒度
3. 云端对一批内部是并行还是串行（各文件 running 窗口叠不叠）
4. 各文件在 waiting-file / pending 里停多久——要不要给排队态设独立上限
5. （探针途中加问）终态之后多久还查得回、zip 还下得了——resume（超时后续取）的成立前提

## 怎么跑

```powershell
$env:MINERU_TOKEN = '<token>'   # 输出里不打印 token
node probe.mjs batch <runs前缀> <pdf> <pdf> …    # 纯好文件批
node probe.mjs poison <runs前缀> <好pdf> <好pdf>  # 自动生成坏文件夹中间：好、坏、好
node probe.mjs fetch <runs前缀> <batchId> …      # 查老批次还查不查得回
```

零依赖（node 内置 fetch）。batch / poison 真扣 MinerU 额度；顺序 PUT（不并发）、5 秒一轮询、总上限 20 分钟。

## 结论

1. **一批多文件成立且按文件独立**：一次申请带回一个 batchId + N 个上传位（`file_urls` 按序对位 `files`），5 篇顺序 PUT 共 1 秒，轮询回 `extract_result` 每文件一条——`file_name` / `state` / `err_msg` / zip 各是各的。
2. **部分失败干净，不连坐**：好、坏、好一批，两个好文件各自 done 带 zip，坏文件单独 failed（`parsing failed, please try again later`、无 zip）。→ 将来若做批量，「批」可以只是传输层，账与结果仍一作业一文件。
3. **云端内部并行度没量出来**：5 篇从 waiting-file 直接跳 done（两轮轮询间隔 6.4s 内全部转完），从没进过 running 态。且这 5 篇昨天都被转过，疑似云端内容级缓存回放——速度与并行度证据都不可信。留待用没转过的 PDF 再量。
4. **排队停留约 6 秒**（waiting-file → 终态），同样被缓存疑点污染，高峰期未知——不够立「排队停留上限」的数。
5. **结果留存 ≥14 小时，且查得回就能下**：2026-09-17 14:20Z 的两个批（0.2.0 探针留下），14.2 小时后 2/2 查得回、zip URL 现开现用（`cdn-mineru.openxlab.org.cn`，GET 200、2MB、PK 魔数）；昨天的第三个批 13 小时后同样查得回。留存有上限（`-60012 task not found or expire` 是真实错误形状），具体多长没量到头。→ resume 成立：failed 作业凭账上 batchId 事后取回，不重花解析额度；resume 必须把 -60012 翻成「结果已过期，只能重提」。

## 依据

- 纯好文件批：`runs/01-batch5-timeline.txt`、`runs/01-batch5-summary.txt`（5 篇、总墙钟 9.6s）
- 部分失败批：`runs/02-poison-timeline.txt`、`runs/02-poison-summary.txt`
- 昨天的批（13h）：`runs/03-old-batch-fetch.txt`
- 前天的批（14.2h）：`runs/04-old-batch-fetch.txt`；zip 实下验证只跑了命令行一次（GET 200 / 2033092B / PK），未落文件

## 跑那次的环境

2026-09-18 12:27–12:35 +0800，Windows 11 Pro 10.0.26200，node v24.14.1。输入：论文库 `papers/` 五篇 `paper.pdf`（0.4–1.8MB，其中 5 篇全部在 2026-09-17 被转过——缓存疑点的来源）。token 出自隔离 home `mineru-2609172219` 的 settings（运行时现读，未落任何文件）。
