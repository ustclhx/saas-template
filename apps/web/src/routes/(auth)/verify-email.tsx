import { Button } from '@saas/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'
import { AuthLayout, FormAlert, StatusAlert } from '../../features/auth/auth-layout.tsx'
import { AFTER_SIGN_IN_PATH } from '../../features/auth/auth-client.ts'
import { authErrorMessage } from '../../features/auth/errors.ts'

/** 页面文案（英文硬编码，P6 接 Paraglide） */
const COPY = {
  metaTitle: 'Email verification',
  successTitle: 'Email verified',
  success: 'Your email address has been verified.',
  continue: 'Continue',
  failureTitle: 'Verification failed',
  failureHint: 'Sign in to receive a new verification email.',
  signIn: 'Back to sign in',
} as const

/**
 * 邮箱验证结果页：验证邮件中的链接先到 /api/auth/verify-email，校验后 Better Auth 跳到这里
 * （发起验证时 callbackURL=/verify-email）。成功时不带参数且已自动登录；失败时带 ?error=<错误码>。
 */
export const Route = createFileRoute('/(auth)/verify-email')({
  validateSearch: z.object({ error: z.string().optional() }),
  head: () => ({ meta: [{ title: COPY.metaTitle }] }),
  component: VerifyEmailPage,
})

function VerifyEmailPage() {
  const { error } = Route.useSearch()
  if (error) {
    return (
      <AuthLayout title={COPY.failureTitle}>
        <FormAlert message={authErrorMessage(error)} />
        <p className="text-muted-foreground text-sm">{COPY.failureHint}</p>
        <Button asChild variant="outline">
          <Link to="/login">{COPY.signIn}</Link>
        </Button>
      </AuthLayout>
    )
  }
  return (
    <AuthLayout title={COPY.successTitle}>
      <StatusAlert>{COPY.success}</StatusAlert>
      {/* /app 由 p1-workspace 实现，尚不在路由树中，用普通链接整页跳转 */}
      <Button asChild>
        <a href={AFTER_SIGN_IN_PATH}>{COPY.continue}</a>
      </Button>
    </AuthLayout>
  )
}
