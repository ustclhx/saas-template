import { Button, Separator, useAppForm } from '@saas/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { authClient, goToApp, signInCallbackURL } from '../../features/auth/auth-client.ts'
import { AuthLayout, FormAlert, StatusAlert } from '../../features/auth/auth-layout.tsx'
import { authErrorMessage } from '../../features/auth/errors.ts'
import { getAuthUiOptions } from '../../features/auth/options.functions.ts'
import type { AuthUiOptions } from '../../features/auth/options.ts'
import { useTurnstile } from '../../features/auth/turnstile.tsx'
import { useAuthRequest } from '../../features/auth/use-auth-request.ts'

/** 页面文案（英文硬编码，P6 接 Paraglide） */
const COPY = {
  metaTitle: 'Sign in',
  title: 'Sign in',
  description: 'Welcome back. Choose how you want to sign in.',
  email: 'Email',
  password: 'Password',
  code: 'Verification code',
  forgotPassword: 'Forgot password?',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  sendCode: 'Send code',
  sendingCode: 'Sending…',
  codeSent: (email: string) => `We sent a 6-digit code to ${email}. It expires in a few minutes.`,
  useAnotherEmail: 'Use a different email',
  sendLink: 'Send magic link',
  sendingLink: 'Sending…',
  linkSent: (email: string) => `Check ${email} for a sign-in link.`,
  or: 'or',
  modes: {
    password: 'Sign in with password',
    otp: 'Sign in with email code',
    magicLink: 'Sign in with magic link',
  },
  oauth: { google: 'Continue with Google', github: 'Continue with GitHub' },
  noAccount: "Don't have an account?",
  register: 'Sign up',
  noMethods: 'Sign-in is not available right now.',
  invalidEmail: 'Enter a valid email address',
  passwordRequired: 'Enter your password',
  invalidCode: 'Enter the 6-digit code',
} as const

type Mode = keyof typeof COPY.modes

export const Route = createFileRoute('/(auth)/login')({
  // OAuth / 魔法链接失败时 Better Auth 把错误码放在 ?error= 中带回登录页
  validateSearch: z.object({ error: z.string().optional(), redirect: z.string().optional() }),
  loader: () => getAuthUiOptions(),
  head: () => ({ meta: [{ title: COPY.metaTitle }] }),
  component: LoginPage,
})

function enabledModes(options: AuthUiOptions): Mode[] {
  return [
    ...(options.emailPassword ? (['password'] as const) : []),
    ...(options.emailOtp ? (['otp'] as const) : []),
    ...(options.magicLink ? (['magicLink'] as const) : []),
  ]
}

function LoginPage() {
  const options = Route.useLoaderData()
  const { error: callbackError } = Route.useSearch()
  const modes = enabledModes(options)
  const [mode, setMode] = useState<Mode | undefined>(modes[0])
  const otherModes = modes.filter((m) => m !== mode)
  const hasAny = modes.length > 0 || options.oauth.length > 0

  return (
    <AuthLayout
      title={COPY.title}
      description={COPY.description}
      footer={
        options.emailPassword ? (
          <p>
            {COPY.noAccount}{' '}
            <Link to="/register" className="text-foreground underline underline-offset-4">
              {COPY.register}
            </Link>
          </p>
        ) : null
      }
    >
      {callbackError ? <FormAlert message={authErrorMessage(callbackError)} /> : null}
      {!hasAny ? <FormAlert message={COPY.noMethods} /> : null}

      {mode === 'password' ? <PasswordSignIn siteKey={options.turnstileSiteKey} /> : null}
      {mode === 'otp' ? <OtpSignIn siteKey={options.turnstileSiteKey} /> : null}
      {mode === 'magicLink' ? <MagicLinkSignIn siteKey={options.turnstileSiteKey} /> : null}

      {mode !== undefined && (otherModes.length > 0 || options.oauth.length > 0) ? (
        <div className="flex items-center gap-3 text-muted-foreground text-xs uppercase">
          <Separator className="flex-1" />
          {COPY.or}
          <Separator className="flex-1" />
        </div>
      ) : null}

      {otherModes.length > 0 || options.oauth.length > 0 ? (
        <div className="grid gap-2">
          {otherModes.map((m) => (
            <Button key={m} type="button" variant="outline" onClick={() => setMode(m)}>
              {COPY.modes[m]}
            </Button>
          ))}
          {options.oauth.map((provider) => (
            <OAuthButton key={provider} provider={provider} />
          ))}
        </div>
      ) : null}
    </AuthLayout>
  )
}

const emailSchema = z.email(COPY.invalidEmail)

function PasswordSignIn({ siteKey }: { siteKey: string | null }) {
  const turnstile = useTurnstile(siteKey, 'sign-in')
  const { error, run } = useAuthRequest(turnstile)
  const form = useAppForm({
    defaultValues: { email: '', password: '' },
    validators: {
      onSubmit: z.object({
        email: emailSchema,
        password: z.string().min(1, COPY.passwordRequired),
      }),
    },
    onSubmit: async ({ value }) => {
      const data = await run((headers) =>
        authClient().signIn.email({
          ...value,
          // Verification links and successful sign-in resume the same local destination.
          callbackURL: signInCallbackURL(),
          fetchOptions: { headers },
        }),
      )
      if (data) goToApp()
    },
  })
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.modes.password}>
        <FormAlert message={error} />
        <form.AppField name="email">
          {(field) => <field.TextField label={COPY.email} type="email" autoComplete="email" />}
        </form.AppField>
        <form.AppField name="password">
          {(field) => (
            <field.TextField
              label={COPY.password}
              type="password"
              autoComplete="current-password"
            />
          )}
        </form.AppField>
        <div className="-mt-2 flex justify-end">
          <Link
            to="/forgot-password"
            className="text-muted-foreground text-sm underline-offset-4 hover:underline"
          >
            {COPY.forgotPassword}
          </Link>
        </div>
        {turnstile.widget}
        <form.SubmitButton pendingLabel={COPY.signingIn} disabled={!turnstile.ready}>
          {COPY.signIn}
        </form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}

function OtpSignIn({ siteKey }: { siteKey: string | null }) {
  const [email, setEmail] = useState<string | null>(null)
  return email === null ? (
    <OtpRequest siteKey={siteKey} onSent={setEmail} />
  ) : (
    <OtpVerify siteKey={siteKey} email={email} onBack={() => setEmail(null)} />
  )
}

function OtpRequest({
  siteKey,
  onSent,
}: {
  siteKey: string | null
  onSent: (email: string) => void
}) {
  const turnstile = useTurnstile(siteKey, 'send-otp')
  const { error, run } = useAuthRequest(turnstile)
  const form = useAppForm({
    defaultValues: { email: '' },
    validators: { onSubmit: z.object({ email: emailSchema }) },
    onSubmit: async ({ value }) => {
      const data = await run((headers) =>
        authClient().emailOtp.sendVerificationOtp({
          email: value.email,
          type: 'sign-in',
          fetchOptions: { headers },
        }),
      )
      if (data) onSent(value.email)
    },
  })
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.modes.otp}>
        <FormAlert message={error} />
        <form.AppField name="email">
          {(field) => <field.TextField label={COPY.email} type="email" autoComplete="email" />}
        </form.AppField>
        {turnstile.widget}
        <form.SubmitButton pendingLabel={COPY.sendingCode} disabled={!turnstile.ready}>
          {COPY.sendCode}
        </form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}

function OtpVerify({
  siteKey,
  email,
  onBack,
}: {
  siteKey: string | null
  email: string
  onBack: () => void
}) {
  const turnstile = useTurnstile(siteKey, 'sign-in-otp')
  const { error, run } = useAuthRequest(turnstile)
  const form = useAppForm({
    defaultValues: { otp: '' },
    validators: { onSubmit: z.object({ otp: z.string().regex(/^\d{6}$/, COPY.invalidCode) }) },
    onSubmit: async ({ value }) => {
      const data = await run((headers) =>
        authClient().signIn.emailOtp({ email, otp: value.otp, fetchOptions: { headers } }),
      )
      if (data) goToApp()
    },
  })
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.modes.otp}>
        <StatusAlert>{COPY.codeSent(email)}</StatusAlert>
        <FormAlert message={error} />
        <form.AppField name="otp">
          {(field) => (
            <field.TextField
              label={COPY.code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
            />
          )}
        </form.AppField>
        {turnstile.widget}
        <form.SubmitButton pendingLabel={COPY.signingIn} disabled={!turnstile.ready}>
          {COPY.signIn}
        </form.SubmitButton>
        <Button type="button" variant="link" onClick={onBack}>
          {COPY.useAnotherEmail}
        </Button>
      </form.Form>
    </form.AppForm>
  )
}

function MagicLinkSignIn({ siteKey }: { siteKey: string | null }) {
  const turnstile = useTurnstile(siteKey, 'magic-link')
  const { error, run } = useAuthRequest(turnstile)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const form = useAppForm({
    defaultValues: { email: '' },
    validators: { onSubmit: z.object({ email: emailSchema }) },
    onSubmit: async ({ value }) => {
      const data = await run((headers) =>
        authClient().signIn.magicLink({
          email: value.email,
          callbackURL: signInCallbackURL(),
          errorCallbackURL: '/login',
          fetchOptions: { headers },
        }),
      )
      if (data) setSentTo(value.email)
    },
  })
  if (sentTo !== null) return <StatusAlert>{COPY.linkSent(sentTo)}</StatusAlert>
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.modes.magicLink}>
        <FormAlert message={error} />
        <form.AppField name="email">
          {(field) => <field.TextField label={COPY.email} type="email" autoComplete="email" />}
        </form.AppField>
        {turnstile.widget}
        <form.SubmitButton pendingLabel={COPY.sendingLink} disabled={!turnstile.ready}>
          {COPY.sendLink}
        </form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}

function OAuthButton({ provider }: { provider: AuthUiOptions['oauth'][number] }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const onClick = async () => {
    setPending(true)
    setError(null)
    // OAuth callbacks use the same validated destination as password and OTP sign-in.
    const { data, error } = await authClient().signIn.social({
      provider,
      callbackURL: signInCallbackURL(),
      errorCallbackURL: '/login',
    })
    if (data?.url) {
      window.location.assign(data.url)
      return
    }
    setPending(false)
    setError(authErrorMessage(error))
  }
  return (
    <>
      <Button type="button" variant="outline" disabled={pending} onClick={onClick}>
        {COPY.oauth[provider]}
      </Button>
      <FormAlert message={error} />
    </>
  )
}
