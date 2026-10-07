import type { Session } from '@saas/db'
import { AppError } from '@saas/shared'

export const IMPERSONATION_FORBIDDEN = 'IMPERSONATION_FORBIDDEN'

/** 模拟登录用于排查；敏感写操作只接受真实登录的会话。 */
export function assertRealSession(session: Pick<Session, 'impersonatedBy'>) {
  if (session.impersonatedBy)
    throw new AppError(
      IMPERSONATION_FORBIDDEN,
      'Sensitive actions are disabled while impersonating',
      { status: 403 },
    )
}

export function isSensitiveAuthPath(path: string) {
  return (
    [
      '/change-password',
      '/change-email',
      '/set-password',
      '/delete-user',
      '/revoke-sessions',
      '/revoke-other-sessions',
      '/email-otp/request-email-change',
      '/email-otp/change-email',
    ].includes(path) ||
    ['/two-factor/', '/admin/', '/api-key/create', '/deletion/'].some((prefix) =>
      path.startsWith(prefix),
    )
  )
}
