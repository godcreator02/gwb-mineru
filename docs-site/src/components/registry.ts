/**
 * 组件名单的正本。mdx.tsx 用它的类型要求 React 组件表一个不多一个不少；
 * scripts/verify-roster.mjs 拿它跟 docfirst.config.mjs 里的机读规则表逐项核对。
 *
 * 缺哪一边都直接报错：机读规则表里没有 → 生成机读版时报「名册外组件」；
 * React 表里没有 → 站渲染时报 Expected component。
 *
 * Note、Files、Folder、File 的机读规则在 @godcreator/docfirst-workflow/fumadocs/roster 的 fumadocsRoster 里（目录树引用生成的就是后三个）；SeamMap 是首页的接缝图，JobLifecycle 是作业机页的状态变化演示。
 * 这个文件只有可擦除的类型，Node 直接运行。
 */
export const componentNames = ['Note', 'Files', 'Folder', 'File', 'SeamMap', 'JobLifecycle'] as const
export type ComponentName = (typeof componentNames)[number]
