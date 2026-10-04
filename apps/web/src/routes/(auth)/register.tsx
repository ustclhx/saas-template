import { useAppForm } from '@saas/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { authClient, goToApp } from '../../features/auth/auth-client.ts'
import { AuthLayout, FormAlert, StatusAlert } from '../../features/auth/auth-layout.tsx'
import { getAuthUiOptions } from '../../features/auth/options.functions.ts'
import { useTurnstile } from '../../features/auth/turnstile.tsx'
import { useAuthRequest } from '../../features/auth/use-auth-request.ts'

/** 页面文案（英文硬编码，P6 接 Paraglide） */
const COPY = {
  metaTitle: 'Create account',
  title: 'Create an account',
  description: 'Sign up with your email address.',
  name: 'Name',
  email: 'Email',
  password: 'Password',
  passwordHint: 'At least 8 characters.',
  submit: 'Create account',
  pending: 'Creating account…',
  checkEmail: (email: string) =>
    `We sent a verification link to ${email}. Verify your email address, then sign in.`,
  haveAccount: 'Already have an account?',
  signIn: 'Sign in',
  unavailable: 'Sign-up with email and password is not available. Sign in with another method.',
  nameRequired: 'Enter your name',
  invalidEmail: 'Enter a valid email address',
  passwordTooShort: 'Password must be at least 8 characters',
  passwordTooLong: 'Password must be at most 128 characters',
} as const

// 与 Better Auth 默认的密码长度限制一致（minPasswordLength 8 / maxPasswordLength 128）
const schema = z.object({
  name: z.string().trim().min(1, COPY.nameRequired),
  email: z.email(COPY.invalidEmail),
  password: z.string().min(8, COPY.passwordTooShort).max(128, COPY.passwordTooLong),
})

export const Route = createFileRoute('/(auth)/register')({
  loader: () => getAuthUiOptions(),
  head: () => ({ meta: [{ title: COPY.metaTitle }] }),
  component: RegisterPage,
})

function RegisterPage() {
  const options = Route.useLoaderData()
  return (
    <AuthLayout
      title={COPY.title}
      description={COPY.description}
      footer={
        <p>
          {COPY.haveAccount}{' '}
          <Link to="/login" className="text-foreground underline underline-offset-4">
            {COPY.signIn}
          </Link>
        </p>
      }
    >
      {options.emailPassword ? (
        <RegisterForm siteKey={options.turnstileSiteKey} />
      ) : (
        <FormAlert message={COPY.unavailable} />
      )}
    </AuthLayout>
  )
}

function RegisterForm({ siteKey }: { siteKey: string | null }) {
  const turnstile = useTurnstile(siteKey, 'sign-up')
  const { error, run } = useAuthRequest(turnstile)
  const [verifyEmail, setVerifyEmail] = useState<string | null>(null)
  const form = useAppForm({
    defaultValues: { name: '', email: '', password: '' },
    validators: { onBlur: schema, onSubmit: schema },
    onSubmit: async ({ value }) => {
      const data = await run((headers) =>
        authClient().signUp.email({
          ...value,
          name: value.name.trim(),
          // 验证邮件中的回跳地址（结果页）
          callbackURL: '/verify-email',
          fetchOptions: { headers },
        }),
      )
      if (!data) return
      // 强制验证邮箱时注册不登录（token 为 null），提示去邮箱验证；否则已登录，进入应用区
      if (data.token) goToApp()
      else setVerifyEmail(value.email)
    },
  })

  if (verifyEmail !== null) return <StatusAlert>{COPY.checkEmail(verifyEmail)}</StatusAlert>
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.title}>
        <FormAlert message={error} />
        <form.AppField name="name">
          {(field) => <field.TextField label={COPY.name} autoComplete="name" />}
        </form.AppField>
        <form.AppField name="email">
          {(field) => <field.TextField label={COPY.email} type="email" autoComplete="email" />}
        </form.AppField>
        <form.AppField name="password">
          {(field) => (
            <field.TextField
              label={COPY.password}
              type="password"
              autoComplete="new-password"
              description={COPY.passwordHint}
            />
          )}
        </form.AppField>
        {turnstile.widget}
        <form.SubmitButton pendingLabel={COPY.pending} disabled={!turnstile.ready}>
          {COPY.submit}
        </form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}
