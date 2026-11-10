import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  useAppForm,
} from '@saas/ui'
import { type ReactNode, useEffect, useState } from 'react'
import { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import { FormAlert } from '../auth/auth-layout.tsx'
import { actionResult, activateWorkspace, workspaceAction } from './client.ts'
import type { getWorkspacePage } from './workspace.functions.ts'

export type WorkspacePage = Awaited<ReturnType<typeof getWorkspacePage>>
export function HydratedControls({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return (
    <fieldset disabled={!hydrated} className="grid min-w-0 gap-4">
      {children}
    </fieldset>
  )
}

export function WorkspaceSwitcher({ page }: { page: WorkspacePage }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const spaces = page.spaces.map((space) => ({
    ...space,
    label: `${space.name}${space.isPersonal ? ' (personal)' : ''}`,
  }))
  const currentSpace = spaces.find((space) => space.id === page.workspace.id)
  if (!page.multiTenant) return null
  return (
    <HydratedControls>
      <Label htmlFor="workspace-switcher">Switch workspace</Label>
      <Select
        value={currentSpace?.id ?? ''}
        disabled={pending}
        onValueChange={async (value) => {
          const space = spaces.find((s) => s.id === value)
          if (!space) return
          setPending(true)
          setError(null)
          try {
            await activateWorkspace(space)
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not switch workspace.')
            setPending(false)
          }
        }}
      >
        <SelectTrigger
          id="workspace-switcher"
          className="w-full"
          placeholder="Switch workspace"
          valueLabel={currentSpace?.label}
        />
        <SelectContent>
          {spaces.map((space, index) => (
            <SelectItem key={space.id} index={index} value={space.id}>
              {space.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FormAlert message={error} />
      <CreateTeam />
    </HydratedControls>
  )
}

function CreateTeam() {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const form = useAppForm({
    defaultValues: { name: '', slug: '' },
    validators: {
      onSubmit: z.object({
        name: z.string().trim().min(1).max(100),
        slug: z
          .string()
          .min(3)
          .max(64)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(null)
      try {
        const team = await workspaceAction(
          'create',
          value,
          z.object({ id: z.string(), slug: z.string() }),
        )
        await activateWorkspace(team)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create workspace.')
      }
    },
  })
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(!open)}>
        Create team workspace
      </Button>
      {open ? (
        <form.AppForm>
          <form.Form aria-label="Create team workspace">
            <FormAlert message={error} />
            <form.AppField name="name">
              {(field) => <field.TextField label="Team name" />}
            </form.AppField>
            <form.AppField name="slug">
              {(field) => (
                <field.TextField
                  label="Workspace URL"
                  description="Lowercase letters, numbers and hyphens."
                />
              )}
            </form.AppField>
            <form.SubmitButton pendingLabel="Creating…">Create team</form.SubmitButton>
          </form.Form>
        </form.AppForm>
      ) : null}
    </>
  )
}

const memberRoles = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
]

type ConfirmationTarget = {
  action: 'remove' | 'transfer'
  item: WorkspacePage['members'][number]
}

export function WorkspaceSettings({ page }: { page: WorkspacePage }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('member')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<ConfirmationTarget | null>(null)
  const invitationRole = memberRoles.find((option) => option.value === role)
  const confirmCopy =
    confirmTarget?.action === 'transfer'
      ? {
          title: m.workspace_transfer_confirm_title(),
          description: m.workspace_transfer_confirm_description({ name: confirmTarget.item.name }),
          action: 'Transfer ownership',
          variant: 'default' as const,
        }
      : {
          title: m.workspace_remove_confirm_title(),
          description: m.workspace_remove_confirm_description({
            name: confirmTarget?.item.name ?? '',
          }),
          action: 'Remove',
          variant: 'destructive' as const,
        }
  const seatsFull = page.maxSeats !== null && page.memberCount >= page.maxSeats
  async function run(action: string, body: object) {
    setPending(true)
    setError(null)
    try {
      await workspaceAction(action, { organizationId: page.workspace.id, ...body }, actionResult)
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update workspace.')
      setPending(false)
    }
  }
  async function confirmAction() {
    if (!confirmTarget || pending) return
    const { action, item } = confirmTarget
    if (action === 'remove') await run('remove-member', { memberIdOrEmail: item.id })
    else await run('transfer-owner', { memberId: item.id })
    setConfirmOpen(false)
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace settings</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6">
        <p>
          Seats: {page.memberCount} / {page.maxSeats ?? 'Unlimited'}
        </p>
        {seatsFull ? (
          <p role="status">
            {page.memberCount > (page.maxSeats ?? 0)
              ? 'This workspace exceeds its seat limit.'
              : 'All seats are in use.'}{' '}
            The owner must increase the limit or remove members before inviting anyone else.
          </p>
        ) : null}
        {page.readOnly ? (
          <p role="status">Team features are disabled. This workspace is read-only.</p>
        ) : null}
        <FormAlert message={error} />
        <HydratedControls>
          <fieldset disabled={pending} className="grid gap-6">
            {page.canManage ? (
              <form
                aria-label="Invite member"
                onSubmit={(event) => {
                  event.preventDefault()
                  void run('invite-member', { email, role })
                }}
                className="grid gap-3"
              >
                <Label htmlFor="invite-email">Invite email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Label htmlFor="invite-role">Invitation role</Label>
                <Select
                  value={invitationRole?.value ?? ''}
                  disabled={pending}
                  onValueChange={setRole}
                >
                  <SelectTrigger
                    id="invite-role"
                    className="w-full"
                    placeholder="Invitation role"
                    valueLabel={invitationRole?.label}
                  />
                  <SelectContent>
                    {memberRoles.map((option, index) => (
                      <SelectItem key={option.value} index={index} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="submit" disabled={seatsFull}>
                  Send invitation
                </Button>
              </form>
            ) : null}
            <h2 className="font-semibold">Members</h2>
            <ul className="grid gap-4">
              {page.members.map((member) => {
                const selectedRole = memberRoles.find((option) => option.value === member.role)
                return (
                  <li key={member.id} className="flex flex-wrap items-center gap-3">
                    <span>
                      {member.name} ({member.email}) · {member.role}
                    </span>
                    {page.canManage && member.role !== 'owner' ? (
                      <>
                        <Label htmlFor={`role-${member.id}`}>Role for {member.name}</Label>
                        <Select
                          value={selectedRole?.value ?? ''}
                          disabled={pending}
                          onValueChange={(value) =>
                            void run('update-member-role', { memberId: member.id, role: value })
                          }
                        >
                          <SelectTrigger
                            id={`role-${member.id}`}
                            className="w-full"
                            placeholder={`Role for ${member.name}`}
                            valueLabel={selectedRole?.label}
                          />
                          <SelectContent>
                            {memberRoles.map((option, index) => (
                              <SelectItem key={option.value} index={index} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setConfirmTarget({ action: 'remove', item: member })
                            setConfirmOpen(true)
                          }}
                        >
                          Remove
                        </Button>
                        {page.role === 'owner' ? (
                          <Button
                            variant="outline"
                            onClick={() => {
                              setConfirmTarget({ action: 'transfer', item: member })
                              setConfirmOpen(true)
                            }}
                          >
                            Transfer ownership
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            {!page.workspace.isPersonal && page.invitations.length ? (
              <>
                <h2 className="font-semibold">Invitations</h2>
                <ul className="grid gap-3">
                  {page.invitations.map((i) => (
                    <li key={i.id}>
                      {i.email} · {i.role} · {i.status} · expires{' '}
                      {new Date(i.expiresAt).toISOString().slice(0, 10)}{' '}
                      {page.canManage && i.status === 'pending' ? (
                        <Button
                          variant="outline"
                          onClick={() => void run('cancel-invitation', { invitationId: i.id })}
                        >
                          Revoke invitation
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </fieldset>
        </HydratedControls>
      </CardContent>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!pending) setConfirmOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmCopy.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmCopy.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{m.common_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmCopy.variant}
              loading={pending}
              onClick={(event) => {
                event.preventDefault()
                void confirmAction()
              }}
            >
              {confirmCopy.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
