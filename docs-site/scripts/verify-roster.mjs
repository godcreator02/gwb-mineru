/**
 * 名册两头对：docfirst.config.mjs 里生成 markdown 用的组件规则表 vs src/components/registry.ts 里的 React 名单。
 * 少一边都不行：规则表没有 → 生成 markdown 时硬失败；React 表没有 → 站渲染报 Expected component。
 * registry.ts 只有可擦除的类型，Node 直接运行。
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const config = (await import(pathToFileURL(resolve('docfirst.config.mjs')).href)).default
const { componentNames } = await import(pathToFileURL(resolve('src/components/registry.ts')).href)

const ruleNames = new Set(Object.keys(config.components ?? {}))
const reactNames = new Set(componentNames)
const onlyRule = [...ruleNames].filter((name) => !reactNames.has(name))
const onlyReact = [...reactNames].filter((name) => !ruleNames.has(name))

console.log(`规则表：${[...ruleNames].join('、')}`)
console.log(`React 表：${[...reactNames].join('、')}`)
if (onlyRule.length > 0) console.log(`✖ 只有规则、没有 React 组件：${onlyRule.join('、')}`)
if (onlyReact.length > 0) console.log(`✖ 只有 React 组件、没有规则：${onlyReact.join('、')}`)
const bothSidesMatch = onlyRule.length === 0 && onlyReact.length === 0
console.log(bothSidesMatch ? '✔ 名册两头齐' : '✖ 名册两头不齐')
process.exit(bothSidesMatch ? 0 : 1)
