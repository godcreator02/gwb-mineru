# 解包围栏（GWB-30）与同 outDir 覆盖（GWB-31）：基线与修后对照

## 问什么

1. 结果 zip 里塞一条 `images/../../zip-escaped.txt`（或反斜杠变体），这个件会不会把它写到 outDir 外面
2. 同一个 outDir 上两条作业并行解包，会不会互相盖——先落定的那条账还准不准
3. outDir 里已有产物时，是静默盖掉/混进去，还是显式拒；显式要覆盖时旧产物去哪了

## 怎么跑

```powershell
pnpm build                                  # 探针打的是仓根 dist 那份
node probes/2609201430_zip-fence-and-atomic-commit/probe.mjs        # → runs/02-fenced.txt
```

基线（`runs/01-baseline.txt`，改动前的代码）用的是同一把尺子——把 HEAD 那份 `extract.ts` 单独编出来再打它：

```powershell
git show HEAD:src/core/extract.ts | Set-Content -Encoding utf8 $env:TEMP\mineru-baseline-build\extract.ts
pnpm exec tsc $env:TEMP\mineru-baseline-build\extract.ts --ignoreConfig --outDir node_modules\.baseline `
  --module ESNext --target ES2023 --moduleResolution bundler --skipLibCheck --strict --types node
node probes/2609201430_zip-fence-and-atomic-commit/probe.mjs ..\..\node_modules\.baseline\extract.js > runs\01-baseline.txt
```

要换别的构建对照，探针第一个参数就是模块路径。

打的是解包那个纯函数模块（`downloadExtract`），云端用替身 fetch 接管、zip 是 adm-zip 现搓的：
**零网络、零额度**。落点是系统临时区，probes/ 只留输出记录。

一条坑：adm-zip 的 `addFile` 会把 `..` 归一掉（实测 `images/../../zip-escaped.txt` → `zip-escaped.txt`），
所以探针先按占位名加、再把 `entryName` 改回原样——远端那份被人做过手脚的归档就是这么进来的。
不这么造，基线跑出来的「没越界」是假象。

测试那道门是 `pnpm test`（先 build 再 `node --test "tests/*.test.mjs"`），`runs/03-tests.txt` 是它的输出。

## 结论

**基线（01，0.5.1）：两条都成立。** 正斜杠与反斜杠两种写法都把 `zip-escaped.txt` 写到了 outDir 外面
（`path.join(outDir, 'images', '..', '..', …)` 直接逃逸，放行判据只有「分段里出现过 `images`」）；
同 outDir 两条作业都报 done，最终目录是两份产物的混合（`full.md` 归甲、图归两家），**甲那条账当场就不准了**；
outDir 里原有的 `images/old.png` 静默留在原地，新旧混在一起，没有备份也没人告诉你。

**修后（02，0.6.0）：**

1. 两种越界写法都被 `EntryRejectedError` 拒，错误里指名是哪条 entry、犯的哪条（`reason=dotdot` / `reason=backslash`）；
   outDir 一个字节没建，outDir 与工作根之外零文件
2. 同 outDir 两条并排：一条 done 落成，另一条 `CommitRejectedError` 显式拒（outDir 没动）；
   最终产物与赢家那条账完全对得上
3. 已有产物默认 `CommitRejectedError`（原样不动）；带 `overwrite` 时旧产物整份进
   `.out.pdf2md/backup-<时间戳>/`，outDir 里只剩新版

## 跑那次的环境

2026-09-20，Windows 11，Node v24.14.1（`node -v`），pnpm 12.4.2，adm-zip 0.5.18（仓根依赖树）。

- **基线那次（`runs/01-baseline.txt`）的被测对象是 commit `2c2b812`**（当时的 HEAD）——
  把 `git show 2c2b812:src/core/extract.ts` 单独编成 `node_modules/.baseline/extract.js` 再打，
  照「怎么跑」第二段那三行。
- **修后那次（`runs/02-fenced.txt`、`runs/03-tests.txt`）是 0.6.0 的工作树**——它与这条探针、
  与 `tests/` 同一批进仓；要找那次提交的 hash：`git log --oneline -- probes/2609201430_zip-fence-and-atomic-commit`。

## 边界

- 探针只打解包那一层；作业机那层的占位与回执在 `tests/job-runner.test.mjs`（云端替身走完整链）
- 「并发」在这里是**同一进程里两条作业**的对照。跨进程（两个 home 指同一个 outDir）没有真测过——
  提交点的 rename 会让后来者显式失败，但没有实测记录
- 作业跑到一半宿主被杀、提交崩在两次 rename 之间的回滚，没有实测（只有代码里的 journal 与单测路径）
