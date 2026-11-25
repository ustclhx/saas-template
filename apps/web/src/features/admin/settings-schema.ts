import { templateSettings } from '@saas/db'
import { z } from 'zod'

export const runtimeSettingsInput = z.object({
  signupEnabled: templateSettings['auth.signupEnabled'].schema,
  dailyAmount: templateSettings['credits.dailyAmount'].schema,
  dailyMaxDaysPerMonth: templateSettings['credits.dailyMaxDaysPerMonth'].schema,
  dailyExpiryDays: templateSettings['credits.dailyExpiryDays'].schema,
  dailyRequireVerifiedEmail: templateSettings['credits.dailyRequireVerifiedEmail'].schema,
  announcement: templateSettings['site.announcement'].schema,
  signupBonusDomainBlacklist: templateSettings['billing.signupBonusDomainBlacklist'].schema,
  freeFailures: templateSettings['ai.freeFailures'].schema,
})

export type RuntimeSettingsInput = z.infer<typeof runtimeSettingsInput>
