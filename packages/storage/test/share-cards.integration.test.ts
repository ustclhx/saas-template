import { env } from 'cloudflare:workers'
import { newId } from '@saas/shared'
import { describe, expect, it } from 'vitest'
import { createCloudflareStorage } from '../src/cloudflare/index.ts'
import {
  createShareCardInvalidator,
  type ShareCardObjects,
  shareCardImagePrefix,
  shareCardRevokedKey,
  shareCardWorkspaceKey,
} from '../src/index.ts'

declare module 'cloudflare:workers' {
  namespace Cloudflare {
    interface Env {
      CACHE: KVNamespace
    }
  }
}

const objects = createCloudflareStorage({ FILES: env.FILES }).shareCards as ShareCardObjects

describe('share card invalidation with local R2 and KV', () => {
  it('deletes every version and workspace index and revokes for one day across pages', async () => {
    const identity = { type: 'report', token: `share.${newId()}`, workspaceId: newId() }
    const index = shareCardWorkspaceKey(identity)
    const images = [1, 2, 3].map(
      (v) => `${shareCardImagePrefix(identity.type, identity.token)}${v}-digest.png`,
    )
    for (const key of [...images, index]) await env.FILES.put(key, '')
    const paged = {
      ...objects,
      list: (input: Parameters<ShareCardObjects['list']>[0]) =>
        objects.list({ ...input, limit: 1 }),
    }
    const invalidator = createShareCardInvalidator(paged, env.CACHE)
    await invalidator.invalidateShareCard(identity)
    for (const key of [...images, index]) expect(await env.FILES.head(key)).toBeNull()
    const revoked = shareCardRevokedKey(identity.type, identity.token)
    expect(await env.CACHE.get(revoked)).toBe('1')
    const record = (await env.CACHE.list({ prefix: revoked })).keys[0]
    expect(record?.expiration).toBeGreaterThan(Math.floor(Date.now() / 1000) + 86_390)
    expect(record?.expiration).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 86_401)
    await env.CACHE.delete(revoked)
  })

  it('invalidates every paged workspace index while preserving another workspace', async () => {
    const workspaceId = newId()
    const identities = [1, 2, 3].map(() => ({ type: 'report', token: newId(), workspaceId }))
    const other = { type: 'report', token: newId(), workspaceId: newId() }
    for (const identity of [...identities, other]) {
      await env.FILES.put(shareCardWorkspaceKey(identity), '')
      await env.FILES.put(`${shareCardImagePrefix(identity.type, identity.token)}1-digest.png`, '')
    }
    const paged = {
      ...objects,
      list: (input: Parameters<ShareCardObjects['list']>[0]) =>
        objects.list({ ...input, limit: 1 }),
    }
    const invalidator = createShareCardInvalidator(paged, env.CACHE)
    expect(await invalidator.cleanupWorkspaceShareCards(workspaceId)).toEqual({ invalidated: 3 })
    for (const identity of identities) {
      expect(await env.FILES.head(shareCardWorkspaceKey(identity))).toBeNull()
      expect(
        await env.FILES.head(`${shareCardImagePrefix(identity.type, identity.token)}1-digest.png`),
      ).toBeNull()
      expect(await env.CACHE.get(shareCardRevokedKey(identity.type, identity.token))).toBe('1')
      await env.CACHE.delete(shareCardRevokedKey(identity.type, identity.token))
    }
    expect(await env.FILES.head(shareCardWorkspaceKey(other))).not.toBeNull()
    expect(await env.CACHE.get(shareCardRevokedKey(other.type, other.token))).toBeNull()
    await invalidator.invalidateShareCard(other)
    await env.CACHE.delete(shareCardRevokedKey(other.type, other.token))
  })

  it('keeps the workspace retry index and revocation marker after an object deletion fails', async () => {
    const identity = { type: 'report', token: newId(), workspaceId: newId() }
    const index = shareCardWorkspaceKey(identity)
    const image = `${shareCardImagePrefix(identity.type, identity.token)}1-digest.png`
    await env.FILES.put(index, '')
    await env.FILES.put(image, '')
    const invalidator = createShareCardInvalidator(
      {
        ...objects,
        delete: async () => {
          throw new Error('unavailable')
        },
      },
      env.CACHE,
    )
    await expect(invalidator.invalidateShareCard(identity)).rejects.toThrow('unavailable')
    expect(await env.FILES.head(index)).not.toBeNull()
    expect(await env.CACHE.get(shareCardRevokedKey(identity.type, identity.token))).toBe('1')
    await createShareCardInvalidator(objects, env.CACHE).invalidateShareCard(identity)
    await env.CACHE.delete(shareCardRevokedKey(identity.type, identity.token))
  })
})
