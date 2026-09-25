/**
 * MDX 组件的 React 表。docfirst.config.mjs 声明生成 markdown 时每个组件变成什么文字，这里给站上渲染用的组件。
 * 表的类型由 registry.ts 的名单决定：少一个、多一个都编译不过；跟规则表齐不齐由 scripts/verify-roster.mjs 核对。
 * 先铺 fumadocs 的默认组件，再加本站的组件，最后把 pre 换成格式包里会显示钉码状态的那个。
 */
import defaultMdxComponents from 'fumadocs-ui/mdx'
import { File, Files, Folder } from 'fumadocs-ui/components/files'
import type { MDXComponents } from 'mdx/types'
import type { ReactNode } from 'react'
import { DocfirstPre } from '@godcreator/docfirst-workflow/fumadocs/pre'
import { JobLifecycle } from './job-lifecycle'
import { SeamMap } from './seam-map'
import type { ComponentName } from './registry'

type Loose = MDXComponents[string]

export function Note({ children }: { children?: ReactNode }) {
  return <blockquote>{children}</blockquote>
}

const table: Record<ComponentName, Loose> = {
  Note: Note as Loose,
  Files: Files as Loose,
  Folder: Folder as Loose,
  File: File as Loose,
  SeamMap: SeamMap as Loose,
  JobLifecycle: JobLifecycle as Loose,
}

export function getMDXComponents(components: MDXComponents = {}): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
    ...table,
    pre: DocfirstPre as unknown as NonNullable<MDXComponents['pre']>,
  }
}
