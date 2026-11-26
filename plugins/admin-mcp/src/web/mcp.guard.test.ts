import { readFileSync } from 'node:fs'
import { templateConfig } from '@web/server/template-config.ts'
import { expect, it } from 'vitest'
import { adminTools } from './mcp.ts'

function documentedTools() {
  const markdown = readFileSync(new URL('../../../../docs/admin-mcp.md', import.meta.url), 'utf8')
  const section = markdown.split(/^## 工具与权限[ \t]*$/m)[1]?.split(/^#{1,6} /m)[0]
  const table = section
    ?.split(/\r?\n[ \t]*\r?\n/)
    .find((block) => /^\|\s*工具\s*\|\s*Scope\s*\|\s*参数与用途\s*\|/.test(block))
  if (!table) throw new Error('docs/admin-mcp.md 缺少「工具与权限」表')

  return table
    .split(/\r?\n/)
    .slice(2)
    .map((row) => {
      const [, name, scope, params] =
        /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`\{([^}]*)\}`/.exec(row) ?? []
      if (!name || !scope || params === undefined) throw new Error(`无法解析 MCP 工具表行：${row}`)

      return {
        name,
        scope,
        params: params.trim() ? params.split(',').map((param) => param.trim()) : [],
      }
    })
}

it('登记的 MCP 工具和参数都提供说明，且只读标记与 scope 一致', () => {
  for (const { spec, scope } of adminTools) {
    expect(spec.description?.trim().length, spec.name).toBeGreaterThanOrEqual(20)
    expect(spec.annotations?.readOnlyHint, spec.name).toBe(scope === 'admin:read')

    for (const [name, schema] of Object.entries(spec.inputSchema.properties ?? {})) {
      expect(schema, `${spec.name}.${name}`).toMatchObject({
        description: expect.stringMatching(/\S/),
      })
    }
  }
})

it('文档工具表与 MCP 注册表的名称、scope、参数及可选性一致', () => {
  const documented = documentedTools()
  const registered = new Map(adminTools.map((tool) => [tool.spec.name, tool]))
  expect(registered.size, 'MCP 注册表含重复工具名').toBe(adminTools.length)
  const enabled = documented.filter(({ name }) =>
    name.startsWith('studio.') ? Boolean(templateConfig.plugins.studio) : true,
  )
  expect(enabled.map(({ name }) => name).sort()).toEqual([...registered.keys()].sort())

  for (const { name, scope, params } of enabled) {
    const tool = registered.get(name)
    if (!tool) throw new Error(`MCP 注册表缺少工具 ${name}`)

    const { properties = {}, required = [] } = tool.spec.inputSchema
    expect(scope, name).toBe(tool.scope)
    expect(params.map((param) => param.replace(/\?$/, '')).sort(), name).toEqual(
      Object.keys(properties).sort(),
    )
    expect(params.filter((param) => !param.endsWith('?')).sort(), name).toEqual(
      [...required].sort(),
    )
  }
})
