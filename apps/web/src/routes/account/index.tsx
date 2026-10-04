import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { getAccount } from '../../features/settings/account.functions.ts'
import {
  EmailVerificationSection,
  PasswordSection,
  PreferencesSection,
  ProfileSection,
  TwoFactorSection,
} from '../../features/settings/account-sections.tsx'
import { ACCOUNT_COPY } from '../../features/settings/copy.ts'

// 用户设置页（tasks.md 5.2）：不在 /app/$slug 下，属于用户本人而非某个空间
export const Route = createFileRoute('/account/')({
  // 邮箱验证链接失败时 Better Auth 重定向回 callbackURL 并带上 ?error=
  validateSearch: z.object({ error: z.string().optional() }),
  loader: () => getAccount(),
  head: () => ({ meta: [{ title: ACCOUNT_COPY.title }] }),
  component: AccountPage,
})

function AccountPage() {
  const account = Route.useLoaderData()
  const { error } = Route.useSearch()
  const { user } = account
  return (
    <main>
      <h1>{ACCOUNT_COPY.heading}</h1>
      <ProfileSection user={user} />
      <PreferencesSection user={user} locales={account.locales} />
      <EmailVerificationSection user={user} callbackError={error} />
      <PasswordSection hasPassword={account.hasPassword} />
      {account.twoFactorAvailable && (
        <TwoFactorSection user={user} hasPassword={account.hasPassword} />
      )}
    </main>
  )
}
