/**
 * 这个站的 docfirst 配置：用哪个格式包、生成文件写到哪、组件规则表是什么。命令行和站读的是同一份。
 *
 * 项目根是站目录，钉的源码在插件包 `plugins/mineru/` 里——引用写 `../plugins/mineru/src/…`。
 * 分区按约定：`content/` 下 `trajectory/` 与 `future/` 两个名字固定，其余目录都是现状区、都进 check；
 * 本站的现状区只有 `content/docs`。
 *
 * 仓根 README.md、AGENTS.md 与 CLAUDE.md 都是生成物，正本在 `content/docs/outputs/`。
 * CLAUDE.md 第一行固定是 `@AGENTS.md`，只给 Claude 的指令写在它后面。生成正本按原文渲染，里面不能用 JSX 组件。
 */
import * as fumadocs from '@godcreator/docfirst-workflow/fumadocs'

export default {
  formats: [fumadocs],
  outputs: {
    'content/docs/outputs/readme.mdx': ['../README.md'],
    'content/docs/outputs/agents.mdx': ['../AGENTS.md'],
    'content/docs/outputs/claude.mdx': ['../CLAUDE.md'],
  },
  components: {
    ...fumadocs.defaultRoster,
    // 首页的接缝图：图在机读版里看不见，正文按同一套编号逐条讲了每条接缝，这里只留一句说明图画了什么
    SeamMap: (node, h) =>
      h.paragraph(
        '[接缝图] 插件的三个模块（作业机、云端客户端、解包）与外面的消费方插件、命令总线、设置插件、数据插件、说明书插件、内核、MinerU 云端、磁盘之间的 12 条接缝；实线是调用，虚线是读写磁盘，正文按编号逐条讲',
      ),
    // 作业机页的状态演示：四种情况下一条作业经过哪些状态、每一步写进作业账什么、推不推事件；正文把同样的事讲了一遍
    JobLifecycle: (node, h) =>
      h.paragraph(
        '[演示] 一条作业在正常完成、云端解析失败、解包失败后 recover、宿主重启四种情况下经过的状态，每一步写进作业账的字段与推给页面的事件',
      ),
  },
}
