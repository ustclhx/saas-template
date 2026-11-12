import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { baseLocale } from '../../paraglide/runtime.js'
import { BellButton, NotificationPanel, type NotificationPanelProps } from './bell.tsx'
import { badgeText, type NotificationRow } from './store.tsx'
import { relativeTime } from './time.ts'

/** renderToStaticMarkup 会转义撇号（英文文案里的 Couldn't） */
const escapeHtml = (text: string) => text.replaceAll("'", '&#x27;')

const NOW = new Date('2026-11-12T12:00:00Z')

function row(id: string, overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id,
    userId: 'u',
    workspaceId: 'w',
    type: 'test',
    title: `Title ${id}`,
    body: null,
    link: null,
    readAt: null,
    createdAt: new Date(NOW.getTime() - 3 * 60_000),
    updatedAt: NOW,
    ...overrides,
  }
}

function panel(overrides: Partial<NotificationPanelProps>) {
  return renderToStaticMarkup(
    <NotificationPanel
      variant="popover"
      titleId="t"
      rowIdPrefix="r-"
      status="ready"
      rows={[]}
      unread={0}
      busy={false}
      actionError=""
      onOpen={() => {}}
      onMark={() => {}}
      onMarkAll={() => {}}
      onRetry={() => {}}
      viewAll={(className, children) => (
        <a href="/app/x#notifications" className={className}>
          {children}
        </a>
      )}
      now={NOW}
      {...overrides}
    />,
  )
}

describe('铃铛角标', () => {
  it('未读 0 不显示，5 显示 5，120 显示 99+；加载中、出错时不显示', () => {
    expect(badgeText('ready', 0)).toBeNull()
    expect(badgeText('ready', 5)).toBe('5')
    expect(badgeText('ready', 120)).toBe('99+')
    expect(badgeText('loading', 5)).toBeNull()
    expect(badgeText('error', 5)).toBeNull()
  })

  it('可读名称含未读数，角标对读屏隐藏', () => {
    const five = renderToStaticMarkup(<BellButton status="ready" unread={5} />)
    expect(five).toContain(`aria-label="${m.notifications_bell_label({ count: 5 })}"`)
    expect(five).toMatch(/<span aria-hidden="true" data-testid="notification-badge"[^>]*>5<\/span>/)

    const many = renderToStaticMarkup(<BellButton status="ready" unread={120} />)
    expect(many).toContain('>99+</span>')
    expect(many).toContain(`aria-label="${m.notifications_bell_label({ count: 120 })}"`)

    for (const html of [
      renderToStaticMarkup(<BellButton status="ready" unread={0} />),
      renderToStaticMarkup(<BellButton status="loading" unread={5} />),
      renderToStaticMarkup(<BellButton status="error" unread={5} />),
    ]) {
      expect(html).not.toContain('notification-badge')
      expect(html).toContain(`aria-label="${m.notifications_bell_label_none()}"`)
    }
  })
})

describe('通知弹层内容', () => {
  it('正常：列表两按钮一行，未读行带读屏前缀与「标为已读」按钮，底部「查看全部」', () => {
    const html = panel({
      rows: [row('a', { body: 'Body a' }), row('b', { readAt: NOW })],
      unread: 1,
    })
    expect(html).toContain(`<ul aria-label="${m.notifications_recent()}"`)
    expect(html.match(/<li /g)).toHaveLength(2)
    expect(html).toContain(`<span class="sr-only">${m.notifications_unread_prefix()}</span>`)
    expect(html.match(/sr-only/g)).toHaveLength(1)
    expect(html).toContain(`aria-label="${m.notifications_mark_read({ title: 'Title a' })}"`)
    expect(html).not.toContain(m.notifications_mark_read({ title: 'Title b' }))
    expect(html).toContain('Body a')
    expect(html).toContain(m.notifications_unread_count({ count: 1 }))
    expect(html).toContain('href="/app/x#notifications"')
    expect(html).not.toMatch(new RegExp(`disabled=""[^>]*>${m.notifications_mark_all_read()}`))
  })

  it('空：显示空态，不显示「查看全部」，「全部标为已读」禁用', () => {
    const html = panel({})
    expect(html).toContain(m.notifications_empty_title())
    expect(html).not.toContain('#notifications')
    expect(html).not.toContain('<ul')
    expect(html).toMatch(new RegExp(`disabled=""[^>]*>${m.notifications_mark_all_read()}`))
  })

  it('错误：role="alert" 带「重试」，不显示列表、角标数与「查看全部」', () => {
    const html = panel({ status: 'error', rows: [row('a')], unread: 3 })
    expect(html).toContain('role="alert"')
    expect(html).toContain(escapeHtml(m.notifications_error_title()))
    expect(html).toContain(`>${m.notifications_retry()}</button>`)
    expect(html).not.toContain('<ul')
    expect(html).not.toContain('#notifications')
    expect(html).not.toContain(m.notifications_unread_count({ count: 3 }))
  })

  it('加载：role="status" 骨架', () => {
    const html = panel({ status: 'loading' })
    expect(html).toContain(`role="status" aria-label="${m.notifications_loading()}"`)
    expect(html).not.toContain('<ul')
  })
})

describe('相对时间', () => {
  it('刚刚、分钟、小时、昨天、更早的日期（与语言无关地比对 Intl 输出）', () => {
    const ago = (ms: number) => new Date(NOW.getTime() - ms)
    const rtf = new Intl.RelativeTimeFormat(baseLocale, { numeric: 'auto' })
    expect(relativeTime(ago(10_000), baseLocale, NOW)).toBe(m.notifications_just_now())
    expect(relativeTime(ago(3 * 60_000), baseLocale, NOW)).toBe(rtf.format(-3, 'minute'))
    expect(relativeTime(ago(60 * 60_000), baseLocale, NOW)).toBe(rtf.format(-1, 'hour'))
    expect(relativeTime(ago(30 * 3600_000), baseLocale, NOW)).toBe(rtf.format(-1, 'day'))
    const older = ago(20 * 86400_000)
    expect(relativeTime(older, baseLocale, NOW)).toBe(
      new Intl.DateTimeFormat(baseLocale, { month: '2-digit', day: '2-digit' }).format(older),
    )
  })
})
