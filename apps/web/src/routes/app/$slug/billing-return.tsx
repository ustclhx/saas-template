import { Button } from '@saas/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { confirmCustomerCheckout } from '../../../features/billing/customer.functions.ts'

export const Route = createFileRoute('/app/$slug/billing-return')({
  validateSearch: z.object({
    provider: z.enum(['stripe', 'paypal', 'creem', 'paddle', 'polar']).optional(),
    token: z.string().max(255).optional(),
    providerRef: z.string().max(255).optional(),
    canceled: z.string().optional(),
  }),
  component: BillingReturnPage,
})
function BillingReturnPage() {
  const search = Route.useSearch()
  const { slug } = Route.useParams()
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => setReady(true), [])
  const providerRef = search.providerRef ?? search.token
  async function confirm() {
    if (!search.provider || !providerRef) return
    setBusy(true)
    try {
      const result = await confirmCustomerCheckout({
        data: { slug, provider: search.provider, providerRef },
      })
      setConfirmed(result.ok)
      setMessage(
        result.ok
          ? 'Payment confirmation submitted. Your plan and credits update after payment is verified.'
          : 'Unable to confirm this payment. Return to billing or try again.',
      )
    } catch {
      setMessage('Unable to confirm payment. Please try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-4">
      <h2 className="text-2xl font-semibold">Checkout return</h2>
      <p>
        {search.canceled === 'true'
          ? 'Checkout was canceled. You can return to billing to try again.'
          : 'Your plan and credits update after payment is verified. Returning here does not confirm that payment succeeded.'}
      </p>
      {search.canceled !== 'true' && search.provider === 'paypal' && providerRef && (
        <Button disabled={!ready || busy || confirmed} onClick={() => void confirm()}>
          Confirm payment
        </Button>
      )}
      {message && <p role="status">{message}</p>}
      <Link to="/app/$slug/billing" params={{ slug }} className="underline">
        Return to billing
      </Link>
    </div>
  )
}
