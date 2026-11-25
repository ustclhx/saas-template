// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { m } from '@web/paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '@web/paraglide/runtime.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTerm, sortTokens, tokenTerms } from './api-tokens.ts'
import type { ApiTokensData } from './api-tokens-page.tsx'
import { ApiTokensPage } from './api-tokens-page.tsx'

// happy-dom 的 Web Animations 在卸载时抛出 AbortError；去掉后 motion 退回到 JS 驱动的动画
Reflect.deleteProperty(Element.prototype, 'animate')

const api = vi.hoisted(() => ({
  createAdminApiTokenFn: vi.fn(),
  revokeAdminApiTokenFn: vi.fn(),
  invalidate: vi.fn(),
  writeText: vi.fn(),
}))
vi.mock('./api-tokens.functions.ts', () => ({
  createAdminApiTokenFn: api.createAdminApiTokenFn,
  revokeAdminApiTokenFn: api.revokeAdminApiTokenFn,
}))
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ invalidate: api.invalidate }) }))
// 生成器会把应用名改成项目名；期望的 MCP 服务名由这里的名称推导，不写死
const APP_NAME = vi.hoisted(() => 'MyApp')
vi.mock('@web/server/template-config.ts', () => ({
  templateConfig: { app: { name: APP_NAME }, plugins: { 'admin-mcp': {} } },
}))

const now = new Date('2026-11-25T00:00:00Z')
const day = 86_400_000
const ENDPOINT = 'https://app.example.com/api/admin/mcp'
const TOKEN = `xat_${'a'.repeat(43)}`

function token(overrides: Partial<ApiTokensData['tokens'][number]>) {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    name: 'Claude Code',
    prefix: 'xat_3f9a1c7e',
    scopes: ['admin:read', 'admin:write'],
    expiresAt: new Date(now.getTime() + 90 * day),
    lastUsedAt: new Date(now.getTime() - 5 * 60_000),
    revokedAt: null,
    createdAt: new Date(now.getTime() - day),
    ...overrides,
  }
}

function data(tokens: ApiTokensData['tokens']): ApiTokensData {
  return { tokens, endpoint: ENDPOINT, terms: [30, 90, 180, 365], now }
}

beforeEach(() => {
  overwriteGetLocale(() => baseLocale)
  // 桌面宽度：弹窗为居中 Dialog
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: api.writeText } })
  for (const fn of Object.values(api)) fn.mockReset()
  api.writeText.mockResolvedValue(undefined)
  api.invalidate.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ApiTokensPage', () => {
  it('列表区分使用中、即将过期、已吊销与已过期，只有使用中的令牌可吊销', () => {
    render(
      <ApiTokensPage
        data={data([
          token({}),
          token({
            id: '00000000-0000-7000-8000-000000000002',
            name: 'Release check',
            scopes: ['admin:read'],
            expiresAt: new Date(now.getTime() + 10 * day),
          }),
          token({
            id: '00000000-0000-7000-8000-000000000003',
            name: 'Old laptop',
            revokedAt: new Date('2026-11-20T00:00:00Z'),
          }),
          token({
            id: '00000000-0000-7000-8000-000000000004',
            name: 'Temp',
            expiresAt: new Date(now.getTime() - day),
          }),
        ])}
      />,
    )
    const table = screen.getByRole('table', { name: m.admin_mcp_list_label() })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(4)
    expect(rows[0]?.textContent).toContain(m.admin_mcp_state_active())
    expect(rows[0]?.textContent).toContain(m.admin_mcp_scope_write())
    expect(rows[1]?.textContent).toContain(m.admin_mcp_days_left_warning({ days: 10 }))
    expect(rows[1]?.textContent).not.toContain(m.admin_mcp_scope_write())
    expect(rows[2]?.textContent).toContain(m.admin_mcp_state_revoked({ date: '2026-11-20' }))
    expect(rows[3]?.textContent).toContain(m.admin_mcp_state_expired())
    // 文案从 messages 取：生成副本的默认语言可能不是英文
    const revokable = ['Claude Code', 'Release check'].map((name) =>
      m.admin_mcp_revoke_label({ name }),
    )
    expect(
      within(table)
        .getAllByRole('button')
        .filter((button) => revokable.includes(button.getAttribute('aria-label') ?? '')),
    ).toHaveLength(2)
    // 只显示前缀，不出现完整令牌
    expect(table.textContent).toContain('xat_3f9a1c7e…')
    expect(screen.getByText(ENDPOINT)).toBeTruthy()
  })

  it('没有令牌时显示空状态与创建入口', () => {
    render(<ApiTokensPage data={data([])} />)
    expect(screen.getByText(m.admin_mcp_empty_title())).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getAllByRole('button', { name: m.admin_mcp_create() })).toHaveLength(2)
  })

  it('创建令牌后一次性显示完整值，复制命令包含端点与完整令牌', async () => {
    api.createAdminApiTokenFn.mockResolvedValue({
      token: TOKEN,
      metadata: token({ name: 'CI', scopes: ['admin:read'] }),
    })
    render(<ApiTokensPage data={data([])} />)
    fireEvent.click(screen.getAllByRole('button', { name: m.admin_mcp_create() })[0] as Element)
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(m.admin_mcp_name()), {
      target: { value: '  CI  ' },
    })
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: new RegExp(m.admin_mcp_scope_write()) }),
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: m.admin_mcp_term_days({ days: 30 }) }),
    )
    expect(within(dialog).getByText(/2026-12-25/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: m.admin_mcp_submit() }))
    })
    expect(api.createAdminApiTokenFn).toHaveBeenCalledWith({
      data: { name: 'CI', write: false, days: 30 },
    })
    expect(api.invalidate).toHaveBeenCalled()

    const created = await screen.findByRole('dialog', { name: m.admin_mcp_created_title() })
    expect(within(created).getByText(TOKEN)).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(created).getByRole('button', { name: m.admin_mcp_copy_command() }))
    })
    expect(api.writeText).toHaveBeenCalledWith(
      `claude mcp add --transport http ${APP_NAME.toLowerCase()}-admin ${ENDPOINT} --header "Authorization: Bearer ${TOKEN}"`,
    )
  })

  it('吊销需确认，确认后调用吊销接口并刷新列表', async () => {
    api.revokeAdminApiTokenFn.mockResolvedValue({ ok: true })
    render(<ApiTokensPage data={data([token({})])} />)
    fireEvent.click(
      screen.getAllByRole('button', {
        name: m.admin_mcp_revoke_label({ name: 'Claude Code' }),
      })[0] as Element,
    )
    const dialog = await screen.findByRole('alertdialog')
    expect(api.revokeAdminApiTokenFn).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: m.admin_mcp_revoke_confirm() }))
    })
    expect(api.revokeAdminApiTokenFn).toHaveBeenCalledWith({
      data: { id: '00000000-0000-7000-8000-000000000001' },
    })
    expect(api.invalidate).toHaveBeenCalled()
  })
})

describe('有效期选项', () => {
  it('受 maxTokenDays 限制，默认 90 天，不可选时取最长项', () => {
    expect(tokenTerms(365)).toEqual([30, 90, 180, 365])
    expect(tokenTerms(100)).toEqual([30, 90])
    expect(tokenTerms(7)).toEqual([7])
    expect(defaultTerm([30, 90, 180])).toBe(90)
    expect(defaultTerm([30])).toBe(30)
  })
})

describe('列表排序', () => {
  it('使用中的令牌在前，组内保持原顺序', () => {
    const revoked = token({ id: 'r', revokedAt: now })
    const expired = token({ id: 'e', expiresAt: new Date(now.getTime() - day) })
    const a = token({ id: 'a' })
    const b = token({ id: 'b' })
    expect(sortTokens([revoked, a, expired, b], now).map(({ id }) => id)).toEqual([
      'a',
      'b',
      'r',
      'e',
    ])
  })
})
