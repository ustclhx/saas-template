import { z } from 'zod'

const errors: Record<string, string> = {
  WORKSPACE_READ_ONLY: 'Team workspaces are read-only while team features are disabled.',
  INVALID_WORKSPACE_SLUG:
    'Use 3–64 lowercase letters, numbers and hyphens. This slug may be reserved.',
  SLUG_TAKEN: 'This workspace URL is already in use.',
  WORKSPACE_LIMIT: 'The workspace ownership limit has been reached.',
  WORKSPACE_PERMISSION: 'You do not have permission to manage these members.',
  PERSONAL_WORKSPACE: 'Personal workspace membership cannot change.',
  SEATS_FULL: 'All seats are in use. Ask the owner to increase the limit or remove a member.',
  LAST_OWNER: 'Transfer ownership before removing or demoting the last owner.',
  INVITATION_INVALID: 'This invitation has expired or is no longer available.',
  INVITATION_RECIPIENT: 'Sign in with the email address that received this invitation.',
  INVITATION_EXISTS: 'A pending invitation already exists for this email.',
  ALREADY_MEMBER: 'This account is already a workspace member.',
  SESSION_REQUIRED: 'Your session has expired. Sign in again.',
  USER_BANNED: 'Your account cannot perform this action.',
  USE_OWNER_TRANSFER: 'Use Transfer ownership to assign a new owner.',
}
export function workspaceError(code: string) {
  return errors[code] ?? 'The workspace action failed. Please try again.'
}
const responseError = z.object({
  code: z.string().optional(),
  error: z.object({ code: z.string().optional() }).optional(),
})
export async function workspaceAction<T>(
  action: string,
  body: object,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`/api/auth/organization/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const value: unknown = await response.json()
  if (!response.ok) {
    const parsed = responseError.safeParse(value)
    throw new Error(
      workspaceError(parsed.success ? (parsed.data.code ?? parsed.data.error?.code ?? '') : ''),
    )
  }
  return schema.parse(value)
}
export const actionResult = z.unknown()
export async function activateWorkspace(workspace: { id: string; slug: string }) {
  await workspaceAction('set-active', { organizationId: workspace.id }, actionResult)
  window.location.assign(`/app/${encodeURIComponent(workspace.slug)}`)
}
