// /account 的界面文案（英文硬编码，P6 接入 Paraglide 时替换）
export const ACCOUNT_COPY = {
  title: 'Account settings',
  heading: 'Account settings',
  saving: 'Saving…',
  profile: {
    heading: 'Profile',
    name: 'Name',
    image: 'Avatar URL',
    imageHint: 'Leave empty to remove your avatar.',
    email: 'Email',
    submit: 'Save profile',
    saved: 'Profile saved.',
  },
  preferences: {
    heading: 'Language and time zone',
    locale: 'Language',
    localeDefault: 'Default',
    timezone: 'Time zone',
    timezoneHint: 'IANA name such as Europe/Berlin. Leave empty to use your browser time zone.',
    useBrowserTimezone: 'Use browser time zone',
    submit: 'Save preferences',
    saved: 'Preferences saved.',
  },
  verification: {
    heading: 'Email verification',
    verified: 'Your email address is verified.',
    unverified: 'Your email address is not verified yet.',
    send: 'Send verification email',
    sent: 'Verification email sent. Check your inbox and open the link.',
    callbackFailed: 'The verification link is invalid or has expired. Send a new one.',
  },
  password: {
    heading: 'Password',
    current: 'Current password',
    next: 'New password',
    confirm: 'Confirm new password',
    mismatch: 'Passwords do not match',
    submit: 'Change password',
    changed: 'Password changed. You have been signed out on all other devices.',
    noPassword: 'You signed up with a social account, so there is no password to change.',
  },
  twoFactor: {
    heading: 'Two-factor authentication',
    enabled: 'Two-factor authentication is on.',
    disabled: 'Two-factor authentication is off.',
    needsPassword: 'Set a password first to use two-factor authentication.',
    password: 'Password',
    enable: 'Turn on',
    disable: 'Turn off',
    setupIntro:
      'Add this key to your authenticator app, then enter the 6-digit code it shows to finish.',
    totpUri: 'Setup key (otpauth URI)',
    backupCodes: 'Backup codes — store them somewhere safe. Each code works once.',
    code: 'Authentication code',
    verify: 'Verify and turn on',
    turnedOn: 'Two-factor authentication is now on.',
    turnedOff: 'Two-factor authentication is now off.',
  },
  errors: {
    INVALID_PASSWORD: 'The password is incorrect.',
    PASSWORD_TOO_SHORT: 'The new password is too short.',
    PASSWORD_TOO_LONG: 'The new password is too long.',
    VALIDATION_ERROR: 'Some values are invalid.',
    INVALID_CODE: 'The code is incorrect.',
    INVALID_TWO_FACTOR_AUTHENTICATION: 'The code is incorrect.',
    SESSION_REQUIRED: 'Your session has expired. Sign in again.',
    USER_BANNED: 'Your account is suspended.',
    RATE_LIMITED: 'Too many attempts. Try again in a minute.',
    unknown: 'Something went wrong. Try again.',
  } as Record<string, string>,
} as const

/** Better Auth 客户端返回的错误：按错误码取文案 */
export function errorMessage(error: { code?: string | undefined } | null | undefined): string {
  return ACCOUNT_COPY.errors[error?.code ?? ''] ?? ACCOUNT_COPY.errors.unknown ?? ''
}
