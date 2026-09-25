import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // 必须空着：`@godcreator/docfirst-workflow` 一个包里同时有服务端的部分（读盘、调 git、remark 插件）与客户端组件 /fumadocs/pre，
  // serverExternalPackages 按包名匹配、不分子路径，外置之后 Next 用 Node 单独加载它，跟站打包的 React 不是同一份，
  // 预渲染报 Cannot read properties of null
  serverExternalPackages: [],
  // next dev 默认往站目录写 AGENTS.md / CLAUDE.md；本仓的 AGENTS 与 CLAUDE 是 docfirst 的生成物，只在仓根
  agentRules: false,
  redirects: async () => [
    { source: '/', destination: '/docs', permanent: false },
    // 挪走或并进首页的旧地址
    { source: '/docs/system-map', destination: '/docs', permanent: false },
    { source: '/future/overview', destination: '/docs', permanent: false },
    { source: '/future/not-doing', destination: '/docs', permanent: false },
    { source: '/outputs/:path*', destination: '/docs/outputs/:path*', permanent: false },
  ],
}

export default withMDX(config)
