# 0.3.0 作业机是不是真串行

## 问什么

同时交 3 个作业，任何时刻是不是最多只有 1 个不在 `queued` / 终态；3 个是不是都能 done；并发写作业账那两次 `EPERM` 还撞不撞。

## 怎么跑

```powershell
node run.mjs <隔离 home 名> <一份小 PDF 的绝对路径>
```

零依赖。那个 home 里要装着 gwb-mineru（0.3.x）且 MinerU token 已配；真扣额度（3 × 页数）。产出落系统临时目录。`runs/03-mineru-log.txt` 是事后从那个 home 的 `gwb.log` 里截的同一时段 gwb-mineru 行（截法：按时间过滤含 `gwb-mineru` 的行）。

## 结论

**串行生效**：3 个作业 15:39:51Z 同时交，每秒抽一次作业账共 37 次，「同时在跑」一直是 0 或 1，状态依次是 `uploading queued queued` → … → `done done running` → `done done done`，41 秒跑完 3 个（6 页一篇）。同一时段日志里「作业账落盘失败」0 次（改之前并发那一趟撞过 2 次，见 paper-fetch 仓 `probes/2609172335_convert-into-library/runs/28-mineru-log-concurrent.txt`）。原始记录：`runs/01-timeline.txt`、`runs/02-jobs.txt`、`runs/03-mineru-log.txt`。

## 跑那次的环境

2026-09-17 23:39 +0800，Windows 11 Pro 10.0.26200，node v24.14.1，隔离 home `mineru-2609172219`，gwb-mineru 开发版 `0.3.1-dev.202609172338`（从 commit `7c0bc70` 的工作树构建）。输入：论文库 `papers/10.1109_ecce-europe62795.2025.11238867/paper.pdf`（6 页，432KB）。
