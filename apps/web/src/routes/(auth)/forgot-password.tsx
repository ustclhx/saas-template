import { useAppForm } from '@saas/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { authClient } from '../../features/auth/auth-client.ts'
import { AuthLayout, FormAlert, StatusAlert } from '../../features/auth/auth-layout.tsx'
import { getAuthUiOptions } from '../../features/auth/options.functions.ts'
import { useTurnstile } from '../../features/auth/turnstile.tsx'
import { useAuthRequest } from '../../features/auth/use-auth-request.ts'

/** 页面文案（英文硬编码，P6 接 Paraglide） */
const COPY = {
  metaTitle: 'Forgot password',
  title: 'Reset your password',
  description: "Enter your email and we'll send you a link to reset your password.",
  email: 'Email',
  submit: 'Send reset link',
  pending: 'Sending…',
  // 不论邮箱是否注册都给出同样的提示，不泄露账号是否存在
  sent: (email: string) =>
    `If an account exists for ${email}, you will receive a password reset link shortly.`,
  backToLogin: 'Back to sign in',
  unavailable: 'Password sign-in is not enabled.',
  invalidEmail: 'Enter a valid email address',
} as const

const schema = z.object({ email: z.email(COPY.invalidEmail) })

export const Route = createFileRoute('/(auth)/forgot-password')({
  loader: () => getAuthUiOptions(),
  head: () => ({ meta: [{ title: COPY.metaTitle }] }),
  component: ForgotPasswordPage,
})

function ForgotPasswordPage() {
  const options = Route.useLoaderData()
  return (
    <AuthLayout
      title={COPY.title}
      description={COPY.description}
      footer={
        <Link to="/login" className="text-foreground underline underline-offset-4">
          {COPY.backToLogin}
        </Link>
      }
    >
      {options.emailPassword ? (
        <ForgotPasswordForm siteKey={options.turnstileSiteKey} />
      ) : (
        <FormAlert message={COPY.unavailable} />
      )}
    </AuthLayout>
  )
}

function ForgotPasswordForm({ siteKey }: { siteKey: string | null }) {
  const turnstile = useTurnstile(siteKey, 'reset-password')
  const { error, run } = useAuthRequest(turnstile)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const form = useAppForm({
    defaultValues: { email: '' },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const data = await run((headers) =>
        authClient().requestPasswordReset({
          email: value.email,
          // 邮件链接经 /api/auth/reset-password/:token 校验后回到该页，带 ?token= 或 ?error=
          redirectTo: '/reset-password',
          fetchOptions: { headers },
        }),
      )
      if (data) setSentTo(value.email)
    },
  })

  if (sentTo !== null) return <StatusAlert>{COPY.sent(sentTo)}</StatusAlert>
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.title}>
        <FormAlert message={error} />
        <form.AppField name="email">
          {(field) => <field.TextField label={COPY.email} type="email" autoComplete="email" />}
        </form.AppField>
        {turnstile.widget}
        <form.SubmitButton pendingLabel={COPY.pending} disabled={!turnstile.ready}>
          {COPY.submit}
        </form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}
