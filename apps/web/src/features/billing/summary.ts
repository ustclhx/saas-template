import type { EntitlementOptions, EntitlementSubscription } from '@saas/entitlements'
import { selectEntitlements } from '@saas/entitlements'

type SummarySubscription = EntitlementSubscription & {
  id: string
  name: string
  provider: string
  cancelAtPeriodEnd: boolean
}

/** Shares effective-period/grace rules with entitlement selection, including paid overlap. */
export function billingSubscriptionSummary(
  subscriptions: readonly SummarySubscription[],
  options: EntitlementOptions = {},
) {
  const current = subscriptions
    .filter((sub) => selectEntitlements([sub], undefined, options) === sub.plan)
    .sort((a, b) => b.plan.sort - a.plan.sort)[0]
  return {
    currentSubscription: current
      ? {
          id: current.id,
          name: current.name,
          planKey: current.plan.key,
          provider: current.provider,
          status: current.status,
          currentPeriodEnd: current.currentPeriodEnd,
          cancelAtPeriodEnd: current.cancelAtPeriodEnd,
        }
      : null,
    nextRenewalAt:
      current &&
      !current.cancelAtPeriodEnd &&
      current.currentPeriodEnd !== null &&
      new Date(current.currentPeriodEnd).getTime() > (options.now ?? new Date()).getTime() &&
      ['active', 'trialing', 'past_due'].includes(current.status)
        ? current.currentPeriodEnd
        : null,
  }
}
