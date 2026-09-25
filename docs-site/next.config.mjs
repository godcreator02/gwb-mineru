import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // **空着,这一行就是那条「不许外置」的账。** `@godcreator/docfirst-workflow` 一个包里
  // 同时住着服务端那半（读盘、调 git、remark 插件）与客户端组件 /fumadocs/pre,
  // serverExternalPackages 按包名匹配、没有子路径粒度,所以它整包不能外置:外置之后 Next
  // 走 Node 单独加载、跟站打包的 React 分了家,预渲染报 Cannot read properties of null
  serverExternalPackages: [],
  redirects: async () => [
    { source: '/', destination: '/future/overview', permanent: true },
    { source: '/docs', destination: '/docs/system-map', permanent: true },
    // 生成正本挪进了现状区
    { source: '/outputs/:path*', destination: '/docs/outputs/:path*', permanent: false },
  ],
}

export default withMDX(config)
