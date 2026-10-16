import { Button } from '@saas/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { authClient } from '../../features/auth/auth-client.ts'
import {
  AuthLayout,
  authLinkClassName,
  FormAlert,
  StatusAlert,
} from '../../features/auth/auth-layout.tsx'
import { authErrorMessage } from '../../features/auth/errors.ts'
import {
  actionResult,
  activateWorkspace,
  workspaceAction,
  workspaceError,
} from '../../features/workspace/client.ts'
import { getInvitationPage } from '../../features/workspace/workspace.functions.ts'

export const Route = createFileRoute('/(auth)/accept-invitation')({
  validateSearch: z.object({ id: z.uuid() }),
  beforeLoad: async ({ search }) => ({ invitationPage: await getInvitationPage({ data: search }) }),
  loaderDeps: ({ search }) => search,
  loader: ({ context }) => context.invitationPage,
  staleTime: 0,
  component: InvitationPage,
})
function InvitationPage() {
  const page = Route.useLoaderData()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  return (
    <AuthLayout
      title="Accept invitation"
      footer={
        <a href="/app" className={authLinkClassName}>
          Go to my workspace
        </a>
      }
    >
      <FormAlert message={error} />
      {'error' in page ? (
        <FormAlert message={workspaceError(page.error)} />
      ) : page.verifyRequired === true ? (
        <>
          <p>Verify {page.email} before viewing and accepting this invitation.</p>
          {sent ? (
            <StatusAlert>Verification email sent. Check your inbox and open the link.</StatusAlert>
          ) : null}
          <Button
            disabled={pending}
            onClick={async () => {
              setPending(true)
              setError(null)
              try {
                const result = await authClient().sendVerificationEmail({
                  email: page.email,
                  callbackURL: `/accept-invitation?id=${page.id}`,
                })
                if (result.error) setError(authErrorMessage(result.error))
                else setSent(true)
              } catch {
                setError('Could not send verification email. Please try again.')
              } finally {
                setPending(false)
              }
            }}
          >
            Send verification email
          </Button>
          <p>
            Open the link to return here. If you verified in another tab, reload this page. You can
            retry sending if the email does not arrive.
          </p>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload after verification
          </Button>
          {!page.multiTenant ? (
            <p>Team features are disabled. Invitations cannot be accepted.</p>
          ) : null}
        </>
      ) : (
        <>
          <p>
            You are invited to {page.workspace.name} as {page.invitation.role}.
          </p>
          {page.multiTenant ? (
            <Button
              disabled={pending}
              onClick={async () => {
                setPending(true)
                setError(null)
                try {
                  await workspaceAction(
                    'accept-invitation',
                    { invitationId: page.invitation.id },
                    actionResult,
                  )
                  await activateWorkspace(page.workspace)
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not accept invitation.')
                  setPending(false)
                }
              }}
            >
              Accept invitation
            </Button>
          ) : (
            <p>Team features are disabled. Invitations cannot be accepted.</p>
          )}
        </>
      )}
    </AuthLayout>
  )
}
