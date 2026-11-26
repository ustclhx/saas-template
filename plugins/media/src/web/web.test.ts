import { registerAppNav, resetAppNav, resolveAppNav } from '@web/features/app-shell/nav.ts'
import { afterEach, expect, it, vi } from 'vitest'
import mediaPlugin from './web.ts'

const { templateConfig } = vi.hoisted(() => ({
  templateConfig: {
    ai: { image: true, video: false },
    plugins: {} as { studio?: object },
  },
}))

vi.mock('@web/server/template-config.ts', () => ({ templateConfig }))
vi.mock('./agent-tools.ts', () => ({ mediaAgentTools: vi.fn() }))

afterEach(() => {
  delete templateConfig.plugins.studio
  resetAppNav()
})

it.each([
  { studio: false, expected: ['media', 'media-tasks'] },
  { studio: true, expected: ['media-tasks'] },
])('Studio 启用状态为 $studio 时显示对应的媒体导航', ({ studio, expected }) => {
  if (studio) templateConfig.plugins.studio = {}
  for (const group of mediaPlugin.appNav) registerAppNav(group)

  const groups = resolveAppNav({ role: 'owner', readOnly: false, isPersonal: true })

  expect(groups.flatMap(({ items }) => items.map(({ id }) => id))).toEqual(expected)
})
