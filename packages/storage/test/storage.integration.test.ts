import { env } from 'cloudflare:workers'
import { createDb, file, member, organization, scoped, user } from '@saas/db'
import { newId } from '@saas/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudflareStorage, FILES_BUCKETS, type StorageEnv } from '../src/cloudflare/index.ts'
import {
  cleanupFiles,
  completeUpload,
  createFileShare,
  declareUpload,
  getFileDownload,
  getSharedFileDownload,
  getStorageUsage,
  MAX_UPLOAD_BYTES,
  revokeFileShare,
} from '../src/index.ts'

declare module 'cloudflare:workers' {
  namespace Cloudflare {
    interface Env {
      HYPERDRIVE: Hyperdrive
      FILES: R2Bucket
    }
  }
}

const db = createDb(env.HYPERDRIVE)
const storageEnv = {
  FILES: env.FILES,
  R2_ACCOUNT_ID: '00000000000000000000000000000000',
  R2_FILES_BUCKET: FILES_BUCKETS[0],
  R2_ACCESS_KEY_ID: 'test-access-key',
  R2_SECRET_ACCESS_KEY: 'test-secret-key',
} satisfies StorageEnv
const storage = createCloudflareStorage(storageEnv)
let ws: string
let otherWs: string
let userId: string
let objectKeys: string[]
beforeEach(async () => {
  ws = newId()
  otherWs = newId()
  userId = newId()
  objectKeys = []
  await db.insert(user).values({ id: userId, name: 'Storage', email: `${userId}@example.test` })
  await db.insert(organization).values([
    { id: ws, name: 'Storage', slug: ws },
    { id: otherWs, name: 'Other', slug: otherWs },
  ])
  await db.insert(member).values({ id: newId(), organizationId: ws, userId, role: 'owner' })
})
afterEach(async () => {
  await storageEnv.FILES.delete(objectKeys)
  await db.delete(file).where(inArray(file.workspaceId, [ws, otherWs]))
  await db.delete(member).where(inArray(member.organizationId, [ws, otherWs]))
  await db.delete(organization).where(inArray(organization.id, [ws, otherWs]))
  await db.delete(user).where(eq(user.id, userId))
})
afterAll(() => db.$client.end())

async function upload(size: number, actualSize = size, mime = 'image/png') {
  const declaration = await declareUpload(db, storage, { workspaceId: ws, userId, mime, size })
  const row = await scoped(db, ws).findById(file, declaration.fileId)
  objectKeys.push(row.r2Key)
  await storageEnv.FILES.put(row.r2Key, new Uint8Array(actualSize), {
    httpMetadata: { contentType: mime },
  })
  return row
}
async function fixture(options: {
  workspaceId?: string
  size?: number
  status?: 'pending' | 'ready'
  createdAt?: Date
  deletedAt?: Date
}) {
  const id = newId()
  const workspaceId = options.workspaceId ?? ws
  const r2Key = `ws/${workspaceId}/${id}`
  objectKeys.push(r2Key)
  await storageEnv.FILES.put(r2Key, 'fixture', { httpMetadata: { contentType: 'image/png' } })
  await scoped(db, workspaceId).insert(file, {
    id,
    r2Key,
    userId,
    mime: 'image/png',
    purpose: 'upload',
    status: 'ready',
    size: 7,
    ...options,
  })
  return { id, r2Key }
}

describe('upload confirmation and quota', () => {
  it('rejects disallowed types, oversized declarations and exhausted quota before inserting pending files', async () => {
    const input = { workspaceId: ws, userId, mime: 'image/png', size: 1 }
    await expect(declareUpload(db, storage, { ...input, mime: 'text/html' })).rejects.toMatchObject(
      { code: 'FILE_TYPE_NOT_ALLOWED' },
    )
    await expect(
      declareUpload(db, storage, { ...input, size: MAX_UPLOAD_BYTES + 1 }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await fixture({ size: 5 * 1024 ** 3 })
    await expect(declareUpload(db, storage, input)).rejects.toMatchObject({
      code: 'UPGRADE_REQUIRED',
    })
    expect(await scoped(db, ws).count(file, eq(file.status, 'pending'))).toBe(0)
  })

  it('deletes an object larger than its declaration and leaves it inaccessible and outside quota', async () => {
    const row = await upload(100, 200)
    await expect(
      completeUpload(db, storage, { workspaceId: ws, fileId: row.id }),
    ).rejects.toMatchObject({ code: 'UPLOAD_MISMATCH' })
    expect(await storageEnv.FILES.head(row.r2Key)).toBeNull()
    expect((await scoped(db, ws).findById(file, row.id)).deletedAt).not.toBeNull()
    expect(await getStorageUsage(db, ws)).toBe(0)
    await expect(
      getFileDownload(db, storage, { workspaceId: ws, fileId: row.id }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it.each(['text/html', null])(
    'deletes an object whose stored MIME is %s rather than its declaration',
    async (mime) => {
      const row = await upload(2)
      await storageEnv.FILES.put(row.r2Key, new Uint8Array(2), {
        ...(mime ? { httpMetadata: { contentType: mime } } : {}),
      })
      await expect(
        completeUpload(db, storage, { workspaceId: ws, fileId: row.id }),
      ).rejects.toMatchObject({ code: 'UPLOAD_MISMATCH' })
      expect(await storageEnv.FILES.head(row.r2Key)).toBeNull()
    },
  )

  it('serializes simultaneous confirmations so only one can consume the remaining quota', async () => {
    await fixture({ size: 5 * 1024 ** 3 - 3 })
    const rows = await Promise.all([upload(2), upload(2)])
    const results = await Promise.allSettled(
      rows.map((row) => completeUpload(db, storage, { workspaceId: ws, fileId: row.id })),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'UPGRADE_REQUIRED' }) }),
    ])
    expect(await getStorageUsage(db, ws)).toBe(5 * 1024 ** 3 - 1)
    const successful = results.find((result) => result.status === 'fulfilled')
    if (successful?.status !== 'fulfilled') throw new Error('Expected a confirmed upload')
    expect(
      await completeUpload(db, storage, { workspaceId: ws, fileId: successful.value.id }),
    ).toEqual(successful.value)
  })
})

describe('file access and sharing', () => {
  it('streams an object range with its returned length and HTTP ETag', async () => {
    const row = await fixture({})
    const partial = await storage.read?.(row.r2Key, { offset: 2, length: 3 })
    if (!partial) throw new Error('Expected a readable object range')
    expect(partial).toMatchObject({
      size: 3,
      etag: (await storageEnv.FILES.head(row.r2Key))?.httpEtag,
    })
    expect(await new Response(partial.body).text()).toBe('xtu')
  })

  it('hides pending and cross-workspace files, permits ready downloads, and revokes a public token immediately', async () => {
    const row = await upload(2)
    await expect(
      getFileDownload(db, storage, { workspaceId: ws, fileId: row.id }),
    ).rejects.toMatchObject({ status: 404 })
    await completeUpload(db, storage, { workspaceId: ws, fileId: row.id })
    await expect(
      getFileDownload(db, storage, { workspaceId: otherWs, fileId: row.id }),
    ).rejects.toMatchObject({ status: 404 })
    expect(
      new URL(
        await getFileDownload(db, storage, { workspaceId: ws, fileId: row.id }),
      ).searchParams.get('X-Amz-Expires'),
    ).toBe('300')
    await expect(
      createFileShare(db, { workspaceId: ws, userId: newId(), fileId: row.id }),
    ).rejects.toMatchObject({ status: 404 })
    const token = await createFileShare(db, { workspaceId: ws, userId, fileId: row.id })
    expect(await getSharedFileDownload(db, storage, token)).toContain(row.id)
    await revokeFileShare(db, { workspaceId: ws, userId, fileId: row.id })
    await expect(getSharedFileDownload(db, storage, token)).rejects.toMatchObject({ status: 404 })
    expect(await createFileShare(db, { workspaceId: ws, userId, fileId: row.id })).not.toBe(token)
  })
})

describe('file cleanup', () => {
  it('removes abandoned uploads and retained deleted-workspace files, preserving fresh pending and active ready files', async () => {
    const now = new Date()
    const old = await fixture({ status: 'pending', createdAt: new Date(now.getTime() - 3_600_001) })
    const fresh = await fixture({ status: 'pending' })
    const ready = await fixture({})
    await db
      .update(organization)
      .set({ deletedAt: new Date(now.getTime() - 31 * 86_400_000) })
      .where(eq(organization.id, otherWs))
    const expired = await fixture({ workspaceId: otherWs })
    expect(await cleanupFiles(db, storageEnv.FILES, { now })).toMatchObject({
      deleted: 2,
      failed: 0,
    })
    for (const row of [old, expired]) {
      expect(await storageEnv.FILES.head(row.r2Key)).toBeNull()
      expect(await db.select().from(file).where(eq(file.id, row.id))).toHaveLength(0)
    }
    for (const row of [fresh, ready]) expect(await storageEnv.FILES.head(row.r2Key)).not.toBeNull()
  })

  it('keeps the database retry anchor when R2 deletion fails and succeeds on the next run', async () => {
    const row = await fixture({ status: 'pending', createdAt: new Date(Date.now() - 3_600_001) })
    const fail = { delete: vi.fn().mockRejectedValue(new Error('object delete failed')) }
    expect(await cleanupFiles(db, fail)).toMatchObject({ deleted: 0, failed: 1 })
    expect(await scoped(db, ws).findById(file, row.id)).toBeDefined()
    expect(await storageEnv.FILES.head(row.r2Key)).not.toBeNull()
    expect(await cleanupFiles(db, storageEnv.FILES)).toMatchObject({ deleted: 1, failed: 0 })
    expect(await storageEnv.FILES.head(row.r2Key)).toBeNull()
  })
})

describe('file cleanup safeguards (add-ops-safeguards 1.2)', () => {
  const extra: string[] = []
  async function deletedWorkspace(deletedAt: Date) {
    const id = newId()
    extra.push(id)
    await db.insert(organization).values({ id, name: 'Expired', slug: id, deletedAt })
    return id
  }
  const exists = async (row: { id: string }) =>
    (await db.select({ id: file.id }).from(file).where(eq(file.id, row.id))).length > 0
  afterEach(async () => {
    await db.delete(file).where(inArray(file.workspaceId, extra))
    await db.delete(organization).where(inArray(organization.id, extra))
    extra.length = 0
  })

  it('caps workspaces and objects per round, oldest due first, leaving the rest for later rounds', async () => {
    const oldest = await deletedWorkspace(new Date('2024-02-01T00:00:00Z'))
    const middle = await deletedWorkspace(new Date('2024-03-01T00:00:00Z'))
    const newest = await deletedWorkspace(new Date('2024-04-01T00:00:00Z'))
    const files = {
      oldest: [await fixture({ workspaceId: oldest }), await fixture({ workspaceId: oldest })],
      middle: [await fixture({ workspaceId: middle })],
      newest: [await fixture({ workspaceId: newest })],
    }
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      // 每轮 2 个空间：最早到期的两个空间先处理
      const first = await cleanupFiles(db, storageEnv.FILES, { workspaceCap: 2 })
      expect(first.guard).toMatchObject({ capReached: true, tripped: [] })
      for (const row of [...files.oldest, ...files.middle]) expect(await exists(row)).toBe(false)
      for (const row of files.newest) expect(await exists(row)).toBe(true)
      await cleanupFiles(db, storageEnv.FILES, { workspaceCap: 2 })
      for (const row of files.newest) expect(await exists(row)).toBe(false)
      // 对象上限：一个空间 3 个文件、每轮 2 个对象
      const big = await deletedWorkspace(new Date('2024-02-15T00:00:00Z'))
      const rows = [
        await fixture({ workspaceId: big, createdAt: new Date('2025-01-01T00:00:00Z') }),
        await fixture({ workspaceId: big, createdAt: new Date('2025-01-02T00:00:00Z') }),
        await fixture({ workspaceId: big, createdAt: new Date('2025-01-03T00:00:00Z') }),
      ]
      const capped = await cleanupFiles(db, storageEnv.FILES, { objectCap: 2 })
      expect(capped).toMatchObject({ deleted: 2, guard: { processed: 2, capReached: true } })
      expect(await Promise.all(rows.map(exists))).toEqual([false, false, true])
      await cleanupFiles(db, storageEnv.FILES, { objectCap: 2 })
      expect(await exists(rows[2] as { id: string })).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('never deletes files of a workspace whose deletion time is before the floor and reports the rows', async () => {
    const corrupted = await deletedWorkspace(new Date(0))
    const normal = await deletedWorkspace(new Date('2024-05-01T00:00:00Z'))
    const kept = await fixture({ workspaceId: corrupted })
    const removed = await fixture({ workspaceId: normal })
    const result = await cleanupFiles(db, storageEnv.FILES)
    expect(result.guard.tripped).toContainEqual({ reason: 'rows-out-of-range', count: 1 })
    expect(await exists(kept)).toBe(true)
    expect(await storageEnv.FILES.head(kept.r2Key)).not.toBeNull()
    expect(await exists(removed)).toBe(false)
  })

  it.each([
    ['workspace retention replaced by 0', { workspaceRetentionDays: 0 }, 'retention-too-short'],
    ['pending retention replaced by 0', { pendingRetentionMs: 0 }, 'retention-too-short'],
    ['seconds mistaken for milliseconds', { workspaceRetentionDays: 1e7 }, 'cutoff-before-floor'],
    ['app clock 10 minutes ahead', { now: new Date(Date.now() + 600_000) }, 'clock-skew'],
  ] as const)('skips the whole round when %s', async (_, options, reason) => {
    const expired = await deletedWorkspace(new Date('2024-05-01T00:00:00Z'))
    const rows = [
      await fixture({ workspaceId: expired }),
      await fixture({ status: 'pending', createdAt: new Date(Date.now() - 2 * 3_600_000) }),
    ]
    const bucket = { delete: vi.fn() }
    expect(await cleanupFiles(db, bucket, options)).toEqual({
      deleted: 0,
      failed: 0,
      guard: { processed: 0, capReached: false, tripped: [{ reason }] },
    })
    expect(bucket.delete).not.toHaveBeenCalled()
    for (const row of rows) expect(await exists(row)).toBe(true)
  })
})
