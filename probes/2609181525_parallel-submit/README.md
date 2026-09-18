# 0.5.0 数组 submit 实机验证：一次交 3 篇同时跑，坏路径整批拒

## 问什么

1. `pdf2md.submit { files: [{ input, outDir }, …] }` 一次交 3 篇，作业是不是各自独立**同时跑**（抽样里「同时在跑」到过 ≥2），最后 3 条全 done
2. 数组里混一个坏路径，是不是**整批当场拒**（ok:false、回执说明哪条），账上不多半条（没有半批账）

## 怎么跑

```powershell
node probe.mjs <pdf1> <pdf2> <pdf3>
```

零依赖（default home 的 cdp.mjs）。目标 home `mineru-2609172219` 里装着本仓 0.5.0（pnpm pack 出 tarball 手工换装 + plugin-manager.remount 热挂——default 没开调试口、devkit.dev 发不了令的那趟替代路）。真扣 MinerU 额度（3 × 页数）。每秒抽一次 `pdf2md.jobs` 落 `runs/01-timeline.txt`。

## 结论

**两项全过**：3 篇同时交，**同时在跑峰值 3**（三条一起 uploading/running，各转各的），全 done；坏路径混进数组 → `ok:false`「input 不是个能读的文件：D:/没有这个文件.pdf」，账上条数前后相等（22 → 22），半批不落账。原始记录：`runs/01-timeline.txt`、`runs/02-final.txt`、`runs/03-reject.txt`。

## 跑那次的环境

2026-09-18 13:22 +0800，Windows 11 Pro 10.0.26200，node v24.14.1。输入：论文库 `26091718wvg/papers/` 三篇 paper.pdf。件：`@godcreator/gwb-mineru@0.5.0`（tarball 换装，commit `a8d798c`）。
