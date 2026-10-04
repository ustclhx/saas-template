import { Button } from '@saas/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { AuthLayout, FormAlert } from '../../features/auth/auth-layout.tsx'
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
  return (
    <AuthLayout title="Accept invitation" footer={<a href="/app">Go to my workspace</a>}>
      <FormAlert message={error} />
      {'error' in page ? (
        <FormAlert message={workspaceError(page.error)} />
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
