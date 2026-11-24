import type { ToolRenderer } from '@web/features/ai/tool-renderers.ts'
import { m } from '@web/paraglide/messages.js'
import { getLocale } from '@web/paraglide/runtime.js'

// 示例工具（任务 5.2 的 current_time、list_workspace_files）的显示名与结果摘要，经插件 web 入口的
// toolRenderers 扩展点注册到消息部件渲染器；项目可在 message-parts.project.tsx 中按同名覆盖。
// 只显示对用户有意义的摘要，不原样输出工具结果。
// 输出形状见 ../example-tools.ts：current_time 返回 `{ time: ISO 字符串 }`，list_workspace_files 返回文件数组。

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

export function currentTimeSummary(output: unknown): string | null {
  const time = record(output)?.time
  if (typeof time !== 'string') return null
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'medium' }).format(
    date,
  )
}

export function fileCountSummary(output: unknown): string | null {
  if (!Array.isArray(output)) return null
  return m.agents_tool_files_result({ count: output.length })
}

export const exampleToolRenderers: Readonly<Record<string, ToolRenderer>> = {
  current_time: {
    label: m.agents_tool_current_time,
    render: ({ state, output }) => (state === 'done' ? currentTimeSummary(output) : null),
  },
  list_workspace_files: {
    label: m.agents_tool_list_files,
    render: ({ state, output }) => (state === 'done' ? fileCountSummary(output) : null),
  },
}
