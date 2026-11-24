import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolRenderer } from '../ai/tool-renderers.ts'
import { type AppNavItem, registerAppNav, resetAppNav, resolveAppNav } from '../app-shell/nav.ts'
import type { WebPluginRegistration } from './contract.ts'
import {
  pluginAdminNav,
  registerPluginAppNav,
  registerPluginToolRenderers,
  runPluginFetch,
} from './extensions.ts'

const Icon = () => null
const owner = { role: 'owner', readOnly: false, isPersonal: true }
const item = (id: string, to: AppNavItem['to'], order?: number): AppNavItem => ({
  id,
  label: () => id,
  icon: Icon,
  to,
  ...(order === undefined ? {} : { order }),
})
const plugin = (id: string, entry: WebPluginRegistration['entry']): WebPluginRegistration => ({
  id,
  entry,
})

afterEach(() => resetAppNav())

describe('应用区导航合并', () => {
  it('插件条目按 order 插入模板条目之间，项目条目可按 id 覆盖插件条目', () => {
    // 与 registry.ts 相同的顺序：模板 → 插件 → 项目
    registerAppNav({
      group: 'tools',
      items: [item('home', '/app/$slug', 0), item('chat', '/app/$slug/chat', 10)],
    })
    registerPluginAppNav(
      [
        plugin('a', {
          appNav: [
            { group: 'tools', items: [item('a-tool', '/app/$slug/usage', 5)] },
            { group: 'settings', items: [item('a-settings', '/app/$slug/settings')] },
          ],
        }),
        plugin('b', {
          appNav: [{ group: 'tools', items: [item('b-tool', '/app/$slug/billing', 5)] }],
        }),
      ],
      registerAppNav,
    )
    registerAppNav({ group: 'content', items: [item('a-tool', '/app/$slug/usage')] })
    expect(
      resolveAppNav(owner).map((group) => [group.id, group.items.map((entry) => entry.id)]),
    ).toEqual([
      ['tools', ['home', 'b-tool', 'chat']],
      ['content', ['a-tool']],
      ['settings', ['a-settings']],
    ])
  })

  it('没有插件时导航不变', () => {
    registerPluginAppNav([], registerAppNav)
    expect(resolveAppNav(owner)).toEqual([])
  })
})

describe('后台菜单', () => {
  it('只返回指定分组的插件条目，按 order 与插件顺序排列', () => {
    const label = () => 'x'
    const plugins = [
      plugin('a', {
        adminNav: [
          { group: 'ai', to: '/admin/models', label, order: 200 },
          { group: 'operations', to: '/admin/audit', label },
        ],
      }),
      plugin('b', { adminNav: [{ group: 'ai', to: '/admin/feedback', label }] }),
    ]
    expect(pluginAdminNav(plugins, 'ai').map((entry) => entry.to)).toEqual([
      '/admin/feedback',
      '/admin/models',
    ])
    expect(pluginAdminNav(plugins, 'people')).toEqual([])
  })
})

describe('消息部件渲染器', () => {
  it('按插件顺序登记，后登记的同名渲染器覆盖', () => {
    const first: ToolRenderer = { label: () => 'first' }
    const second: ToolRenderer = { label: () => 'second' }
    const registered = new Map<string, ToolRenderer>()
    registerPluginToolRenderers(
      [
        plugin('a', { toolRenderers: { search: first } }),
        plugin('b', { toolRenderers: { search: second } }),
      ],
      (name, renderer) => registered.set(name, renderer),
    )
    expect(registered.get('search')).toBe(second)
  })
})

describe('fetch 前置处理', () => {
  const request = new Request('https://example.com/agents/x')

  it('第一个返回 Response 的插件结束链路，之后的插件不再调用', async () => {
    const later = vi.fn()
    const handled = new Response('agent')
    const response = await runPluginFetch(
      [
        { id: 'skip', entry: { fetch: async () => undefined } },
        { id: 'none', entry: {} },
        { id: 'bindings-only' },
        { id: 'agents', entry: { fetch: () => handled } },
        { id: 'later', entry: { fetch: later } },
      ],
      request,
    )
    expect(response).toBe(handled)
    expect(later).not.toHaveBeenCalled()
  })

  it('都不处理时返回 undefined，交给核心处理链', async () => {
    expect(await runPluginFetch([{ id: 'skip', entry: { fetch: () => undefined } }], request)).toBe(
      undefined,
    )
  })

  it('前置处理收到入口传入的额外参数（Worker 的 env、ctx）', async () => {
    const fetch = vi.fn((_request: Request, _env: string, _ctx: string) => undefined)
    await runPluginFetch([{ id: 'a', entry: { fetch } }], request, 'env', 'ctx')
    expect(fetch).toHaveBeenCalledWith(request, 'env', 'ctx')
  })
})
