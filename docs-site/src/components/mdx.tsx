/**
 * MDX 组件的 React 表。docfirst.config.mjs 声明每个组件在机读版里变成什么文字，这里给站上渲染用的组件。
 * 表的类型由 registry.ts 的名单决定：少一个、多一个都编译不过；跟机读规则表是否一致由 scripts/verify-roster.mjs 核对。
 * 先放 fumadocs 的默认组件，再加本站的组件，最后把 pre 换成 @godcreator/docfirst-workflow/fumadocs/pre 里会显示钉码状态的 DocfirstPre。
 */
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import type { MDXComponents } from 'mdx/types';
import type { ReactNode } from 'react';
import { DocfirstPre } from '@godcreator/docfirst-workflow/fumadocs/pre';
import { JobLifecycle } from './job-lifecycle';
import { SeamMap } from './seam-map';
import type { ComponentName } from './registry';

export function Note({ children }: { children?: ReactNode }) {
  return <blockquote>{children}</blockquote>;
}

const table: Record<ComponentName, MDXComponents[string]> = {
  Note,
  Files,
  Folder,
  File,
  SeamMap,
  JobLifecycle,
};

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...components,
    ...table,
    pre: DocfirstPre,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
