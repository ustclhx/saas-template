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
