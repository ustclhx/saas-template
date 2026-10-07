/**
 * 认证接口错误码 → 提示文案（英文硬编码，P6 接 Paraglide）。
 * 错误码来自 Better Auth（BASE_ERROR_CODES 与插件）以及本项目的 @saas/auth（protection.ts、fresh-session.ts）。
 */
export const AUTH_ERROR_MESSAGES = {
  SIGNUP_DISABLED: 'Registration is closed. Use the invitation link sent to your email.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  TURNSTILE_FAILED: 'Human verification failed. Please complete the check and try again.',
  TURNSTILE_PENDING: 'Please complete the human verification first.',
  EMAIL_NOT_VERIFIED:
    'Please verify your email address first. We have sent you a new verification link.',
  INVALID_EMAIL_OR_PASSWORD: 'Incorrect email or password.',
  INVALID_EMAIL: 'Enter a valid email address.',
  INVALID_PASSWORD: 'Incorrect password.',
  PASSWORD_TOO_SHORT: 'Password is too short.',
  PASSWORD_TOO_LONG: 'Password is too long.',
  USER_ALREADY_EXISTS: 'An account with this email already exists. Try signing in instead.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    'An account with this email already exists. Try signing in instead.',
  BANNED_USER: 'This account has been suspended.',
  USER_BANNED: 'This account has been suspended.',
  INVALID_OTP: 'The code is incorrect.',
  OTP_EXPIRED: 'The code has expired. Request a new one.',
  TOO_MANY_ATTEMPTS: 'Too many incorrect codes. Request a new one.',
  INVALID_TOKEN: 'This link is invalid or has already been used.',
  TOKEN_EXPIRED: 'This link has expired.',
  EXPIRED_TOKEN: 'This link has expired.',
  USER_NOT_FOUND: 'We could not find an account for this link.',
  INVALID_USER: 'This link belongs to a different account.',
  ATTEMPTS_EXCEEDED: 'This link has already been used.',
  NOT_FOUND: 'This sign-in method is not available.',
  // OAuth 回调失败时 Better Auth 附加到 errorCallbackURL 的错误
  ACCESS_DENIED: 'Sign-in was cancelled.',
  STATE_MISMATCH: 'Sign-in failed. Please try again.',
  UNABLE_TO_GET_USER_INFO: 'Could not read your account details from the provider.',
  UNKNOWN: 'Something went wrong. Please try again.',
} as const

export type AuthErrorCode = keyof typeof AUTH_ERROR_MESSAGES

export interface AuthErrorLike {
  readonly code?: string | undefined
  readonly status?: number | undefined
}

/** 按错误码选文案：429 一律视为限流；未知错误码给通用提示，不直接显示服务端原文 */
export function authErrorMessage(error: AuthErrorLike | string | null | undefined): string {
  if (error === null || error === undefined) return AUTH_ERROR_MESSAGES.UNKNOWN
  const { code, status } = typeof error === 'string' ? { code: error, status: undefined } : error
  if (status === 429) return AUTH_ERROR_MESSAGES.RATE_LIMITED
  const key = code?.toUpperCase()
  if (key && key in AUTH_ERROR_MESSAGES) return AUTH_ERROR_MESSAGES[key as AuthErrorCode]
  if (status === 404) return AUTH_ERROR_MESSAGES.NOT_FOUND
  return AUTH_ERROR_MESSAGES.UNKNOWN
}
