import { chromium } from '@playwright/test'
import { build } from 'esbuild'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SignupBonusSection } from '../billing/signup-section.tsx'
import { EmailVerificationSection } from '../settings/account-sections.tsx'
import { DailyCreditsNotice, DailyGrantNotice } from './daily-notice.tsx'

vi.mock('../billing/signup.functions.ts', () => ({ claimSignupBonus: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouter: vi.fn(),
}))

describe('daily credit presentation', () => {
  it('keeps a granted notice through cached rerenders until dismissed', async () => {
    // 在真实浏览器挂载组件，确保领取 effect、sessionStorage 和后续重渲染均被执行。
    const bundle = await build({
      stdin: {
        contents: `
          import { createElement } from 'react'
          import { createRoot } from 'react-dom/client'
          import { DailyCreditsNotice } from './daily-notice.tsx'
          const root = createRoot(document.getElementById('root'))
          document.addEventListener('render-notice', (event) => {
            root.render(createElement(DailyCreditsNotice, { result: event.detail }))
          })
        `,
        resolveDir: new URL('.', import.meta.url).pathname,
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"test"' },
    })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.route('http://daily-notice.test/', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
      )
      await page.goto('http://daily-notice.test/')
      await page.addScriptTag({ content: bundle.outputFiles.map((file) => file.text).join('\n') })
      await page.evaluate(() => {
        document.dispatchEvent(
          new CustomEvent('render-notice', {
            detail: {
              status: 'granted',
              grantId: 'daily-grant',
              credits: 10,
              daysThisMonth: 2,
              maxDaysPerMonth: 10,
              expiresAt: '2026-11-17T08:00:00.000Z',
              day: '2026-11-10',
            },
          }),
        )
      })
      await page.getByRole('status').waitFor()
      expect(await page.getByRole('status').textContent()).toContain('10 daily credits')
      expect(
        await page.evaluate(() => sessionStorage.getItem('daily-credits-notice:daily-grant')),
      ).toBe('shown')

      await page.evaluate(async () => {
        document.dispatchEvent(new CustomEvent('render-notice', { detail: { status: 'cached' } }))
        // 等待 React 提交和被动 effect，避免只验证更新前的 DOM。
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      expect(await page.getByRole('status').count()).toBe(1)
      expect(await page.getByRole('status').textContent()).toContain('2/10 days')
      await page.getByRole('button', { name: 'Dismiss' }).click()
      await page.getByRole('status').waitFor({ state: 'detached' })
    } finally {
      await browser.close()
    }
  }, 15_000)

  it('shows the granted amount and monthly progress through the display contract', () => {
    const html = renderToStaticMarkup(
      <DailyGrantNotice
        credits={10}
        daysThisMonth={2}
        maxDaysPerMonth={10}
        expiresAt="2026-11-17T08:00:00.000Z"
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain('10 daily credits')
    expect(html).toContain('2/10 days')
    expect(html).toContain('2026-11-17')
  })

  it('links unverified users to account verification and renders no success for cached checks', () => {
    expect(
      renderToStaticMarkup(<DailyCreditsNotice result={{ status: 'unverified' }} />),
    ).toContain('href="/account"')
    expect(renderToStaticMarkup(<DailyCreditsNotice result={{ status: 'cached' }} />)).toBe('')
  })

  it('keeps email verification available when signup credits are zero', () => {
    const user = {
      id: 'user',
      name: 'User',
      email: 'user@example.com',
      emailVerified: false,
      image: null,
      locale: null,
      timezone: null,
      twoFactorEnabled: false,
    }
    const html = renderToStaticMarkup(
      <>
        <EmailVerificationSection user={user} callbackError={undefined} />
        <SignupBonusSection email={user.email} verified={false} credits={0} />
      </>,
    )
    expect(html).toContain('Send verification email')
    expect(html).not.toContain('Signup credits')
  })
})
