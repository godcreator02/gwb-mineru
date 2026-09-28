/**
 * 核对组件名册两边一致：docfirst.config.mjs 里的机读规则表与 src/components/registry.ts 里的 React 组件名单。
 * 缺一边都不行：机读规则表里没有 → 生成机读版时直接报错；React 名单里没有 → 站渲染时报 Expected component。
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

console.log(`机读规则表：${[...ruleNames].join('、')}`)
console.log(`React 表：${[...reactNames].join('、')}`)
if (onlyRule.length > 0) console.log(`✖ 只有机读规则、没有 React 组件：${onlyRule.join('、')}`)
if (onlyReact.length > 0) console.log(`✖ 只有 React 组件、没有机读规则：${onlyReact.join('、')}`)
const bothSidesMatch = onlyRule.length === 0 && onlyReact.length === 0
console.log(bothSidesMatch ? '✔ 组件名册两边一致' : '✖ 组件名册两边不一致')
process.exit(bothSidesMatch ? 0 : 1)
