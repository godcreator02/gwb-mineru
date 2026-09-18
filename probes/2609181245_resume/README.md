# 0.4.0 resume 实机验证：interrupted / failed 都能原批次取回，不该续的挡得住

## 问什么

1. 真被宿主重启打断的作业（interrupted、账上有 batchId 与 uploaded），resume 后能不能凭原批次取回云端结果翻 done——不重新申请位、不上传、不重花额度
2. failed 的作业（演练：把 done 的账改成超时结算的形状）resume 后同样成立吗
3. 不该续的喊 resume，挡得住吗、话能不能照着做——done 的、failed 但没走到上传完成的（0.3.x 老账没有 uploaded 那格）

## 怎么跑

```powershell
node probe.mjs submit <pdf绝对路径>      # home 跑着；真扣一次额度，等 done 落 runs/01
# 停 home（taskkill 它 runtime.json 里的 pid），node probe.mjs ledger-fail <jobId>   # 演练 failed
# 重启 home（GWB_HOME=mineru-2609172219，带 --remote-debugging-port=9405）
node probe.mjs resume <jobId>           # resume 并等到终态，落 runs/03
node probe.mjs reject <jobId…>          # 对不该续的喊 resume，落 runs/04
```

零依赖（node 内置 + default home 的 cdp.mjs）。目标 home `mineru-2609172219` 里装着本仓工作树构建的开发版（devkit.dev 换装）。`runs/01` 那次 submit 中途宿主被人手动关闭——没浪费，正好成了问 1 的真样本。

## 结论

**resume 四项全过（batchId 全程不变，零重花额度）**：

1. **interrupted 真路径**：作业 `20260918044046-1` 提交后 9 秒宿主被关，dispose 的落账没抢在退出前——盘上仍写 `running`；重启后启动对账把它标 `interrupted`（`uploaded: true`、batchId 都在）。resume 秒回 `queued`，3 秒后 `done`：原批次 `c47dbe02` 取回，markdown/lang/files 齐全。账上 `uploaded` 那格（0.4.0 新增）在真链路里如实落了
2. **failed 演练路径**：同一条 done 的账停机改成 `failed`（error 写成超时结算的话、产出三样删掉、batchId/uploaded 保留），重启后 resume——同样 `done`，批次不变
3. **挡 done**：`ok:false`「只有 failed / interrupted 的作业能续取，这条是 done」
4. **挡没传完的**：昨天 fetch-failed 事故的 `20260917153456-9`（failed、有 batchId、无 uploaded）——`ok:false`「这条作业没走到上传完成，云端没有它的文件，续取不了——重新 pdf2md.submit 一次就是了」。0.3.x 老账天然没有 uploaded 格，续不了、话里给了出路

顺带实证一条边界：宿主退出太快时，卸载打断的**落盘**可能没落上（盘上还写 running）——启动对账兜住它，不丢账也不假装还在跑，正是「只标不重跑」设计里那一环。

## 依据

- interrupted 路径与终态：`runs/03-resume.txt`（回执 queued → 终态 done，batchId `c47dbe02-252e-4d64-ba82-aa2ff62475e8`）
- failed 演练：`runs/02-before-fail.txt`（改账前的 done 原貌）；终态同在 `runs/03-resume.txt`（第二次 resume）
- 挡板两条：`runs/04-rejects.txt`
- 宿主关闭时刻的作业账与日志：home `mineru-2609172219` 的 `data/mineru/jobs.json` 与 `gwb.log`（04:40:46Z 排队、04:40:55Z kernel 收尾完退出）

## 跑那次的环境

2026-09-18 12:40–12:55 +0800，Windows 11 Pro 10.0.26200。目标 home `mineru-2609172219`，件 `@godcreator/gwb-mineru@0.4.1-dev.202609181240`（本仓工作树经 devkit.dev 构建换装）。输入：论文库 `papers/10.1109_ecce-europe62795.2025.11238867/paper.pdf`（6 页，真扣一次额度；两次 resume 各取回同一批次，未再扣）。
