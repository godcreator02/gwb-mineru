import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
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
};

export default withMDX(config);
