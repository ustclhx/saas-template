import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { activateWorkspace, workspaceAction } from './client.ts'

afterEach(() => vi.unstubAllGlobals())

describe('workspace actions', () => {
  it('renders the business error code instead of exposing backend text', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ code: 'SEATS_FULL', message: 'internal detail' }, { status: 403 }),
        ),
    )
    await expect(
      workspaceAction('invite-member', { email: 'member@example.com' }, z.unknown()),
    ).rejects.toThrow('All seats are in use.')
  })
  it('does not navigate when activation is rejected', async () => {
    const assign = vi.fn()
    vi.stubGlobal('window', { location: { assign } })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ code: 'SESSION_REQUIRED' }, { status: 401 })),
    )
    await expect(activateWorkspace({ id: 'team-id', slug: 'team' })).rejects.toThrow(
      'Sign in again.',
    )
    expect(assign).not.toHaveBeenCalled()
  })
})
