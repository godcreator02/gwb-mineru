# MinerU 的批与并行到底什么逻辑：批内真并行，但聚合进一个 batch_id 会连带解析失败

## 问什么

1. 云端对**一个批内**的多个文件是同时转还是排队转（各文件 running 窗口叠不叠）
2. 两个 batch **同时**提交（报名各发各的、PUT 全局串行、轮询各跑各的）全不全过
3. 5 个单文件任务**全并发**（报名、PUT、轮询各跑各的）——0.3.0 那场「同一秒 fetch failed」事故的原始形状，验并发到底是不是根因
4. 聚合与不聚合的对照：同一批文件，聚合进一个 batch_id 挂了的，拆成独立单文件任务重交活不活得成

## 怎么跑

```powershell
$env:MINERU_TOKEN = '<token>'
node probe.mjs one   <runs前缀> <pdf×5>           # 一批多文件，顺序 PUT，一个轮询循环
node probe.mjs two   <runs前缀> <pdf×3> -- <pdf×3> # 两批并发，PUT 全上全局道
node probe.mjs burst <runs前缀> <pdf…>             # N 个单文件批全并发
```

零依赖（node 内置 fetch）。真扣 MinerU 额度。输入主体是老数据区 `26090815vvu/papers/files/` 里没转过的新论文（避开缓存疑点）；burst 复用已转过的（它测网络层 PUT，不吃缓存亏）。

## 结论

1. **批内确实并行**：一批 5 篇干净论文，干活窗口交叠对数 3/3，总墙钟 17.1s（含全部 PUT）。
2. **聚合进一个 batch_id 是连带解析失败的来源**：两批并发时批 1（三个大文件聚合）3/3 `parsing failed, please try again later`，同一时刻并发的批 2（三个中文件聚合）3/3 done；把批 1 的文件**拆成独立单文件任务并发重交，2/2 done**（`07-ungrouped-big2`）。另有两处同签名：昨天批里挂的 Multiport PET 单发即过（`02-solo-f4`），今天批里挂的 Multifrequency 单发即过（`05-solo-multifreq`）。批内好文件 14 次尝试挂 5 次（≈36%），独立单任务 7 次尝试 0 挂。
3. **并发不是当年 fetch failed 的根因**：5 个单文件任务全并发（报名、PUT、轮询全并发）5/5 done、零网络错（`06-burst5`）；反倒是**单发、零并发**的报名撞过一次 `ECONNRESET`（Client network socket disconnected before secure TLS connection was established，重试即过）——抖动与并发度无关，0.3.0 的串行是对一波网络抖动的过度纠正，防护应该靠失败如实记账（cause 已进 error），不靠限流。
4. **真有不开 OCR 就转不动的文件**：老库《Design Analysis and Capacitance Reduction of Hybrid MMC Under Boost AC Mode》聚合挂、单发也挂（干活 29s 后 parsing failed）——疑似扫描版，是路线页「暴露转换参数」那条第一次露头的真需求证据。
5. 边界：批内并行度与连带失败的**机制**（云端内部怎么分工）从外面量不到；样本 14+7 次，方向一致但不是大数。

## 依据

- 一批 5 篇（新论文）：`runs/01-one-batch5-*`（并行窗口 3/3、17.1s；首跑报名撞 ECONNRESET 重试过——网络抖动的现场样本）
- 单发修复两例：`runs/02-solo-f4-*`、`runs/05-solo-multifreq-*`；真转不动的文件：`runs/03-solo-f5-*`
- 两批并发（聚合对照的上半）：`runs/04-two-batches-*`（批 1 聚合 3/3 挂、批 2 聚合 3/3 过、PUT 全局道零网络错）
- 5 路全并发单任务：`runs/06-burst5-*`（5/5 done）
- 聚合 vs 拆开的决定性对照：`runs/07-ungrouped-big2-*`（批 1 的两个文件拆开并发 2/2 done）

## 跑那次的环境

2026-09-18 13:13–13:19 +0800，Windows 11 Pro 10.0.26200，node v24.14.1。输入：`26090815vvu/papers/files/` 八篇 + `26091718wvg/papers/` 五篇（burst 复用）。token 出自隔离 home `mineru-2609172219`（运行时现读，未落文件）。
