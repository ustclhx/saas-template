import {
  type AiTask,
  aiTask,
  type Database,
  type File,
  file,
  notFound,
  organization,
  scoped,
} from '@saas/db'
import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getStorageUsage } from './files.ts'

const PART_BYTES = 5 * 1024 * 1024

/** 结构兼容 MediaResult；storage 不依赖 AI Provider。 */
export interface MediaCopyResult {
  readonly outputs: readonly {
    readonly url: string
    readonly mime: string
    readonly width?: number
    readonly height?: number
    readonly durationSec?: number
  }[]
}

export interface MediaCopyLimits {
  readonly maxFileBytes: number
  readonly storageBytes: number
  readonly allowedMimeTypes: readonly string[]
  /** 精确域名；允许其子域时显式写成 *.example.com。 */
  readonly allowedHosts: readonly string[]
}

export type PersistedMediaFile = Pick<
  File,
  'id' | 'mime' | 'size' | 'width' | 'height' | 'duration'
>
type MediaBucket = Pick<R2Bucket, 'put' | 'createMultipartUpload' | 'delete'>
type FixedStreamFactory = (length: number) => Pick<FixedLengthStream, 'readable' | 'writable'>

function allowedUrl(raw: string, hosts: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AppError('MEDIA_URL_NOT_ALLOWED', 'Media URL is not allowed')
  }
  const allowed = hosts.some((entry) => {
    const host = entry.toLowerCase()
    return host.startsWith('*.')
      ? url.hostname.endsWith(`.${host.slice(2)}`) && url.hostname !== host.slice(2)
      : url.hostname === host
  })
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed)
    throw new AppError('MEDIA_URL_NOT_ALLOWED', 'Media URL is not allowed')
  return url
}

function checkSize(size: number, max: number) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > max)
    throw new AppError('FILE_TOO_LARGE', 'Media exceeds the file size limit')
}

async function copyOutput(
  bucket: MediaBucket,
  key: string,
  output: MediaCopyResult['outputs'][number],
  limits: MediaCopyLimits,
  fetcher: typeof fetch,
  makeFixedStream: FixedStreamFactory,
) {
  const url = allowedUrl(output.url, limits.allowedHosts)
  if (!limits.allowedMimeTypes.includes(output.mime))
    throw new AppError('FILE_TYPE_NOT_ALLOWED', 'Media type is not allowed')
  const response = await fetcher(url.toString(), { redirect: 'error' })
  try {
    if (!response.ok || response.redirected || !response.body)
      throw new AppError('MEDIA_DOWNLOAD_FAILED', 'Media download failed')
    const mime = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
    if (!mime || mime !== output.mime || !limits.allowedMimeTypes.includes(mime))
      throw new AppError('FILE_TYPE_NOT_ALLOWED', 'Media type is not allowed')
    const length = response.headers.get('Content-Length')
    if (length !== null) {
      if (!/^\d+$/.test(length)) throw new AppError('MEDIA_INVALID_LENGTH', 'Invalid media length')
      const size = Number(length)
      checkSize(size, limits.maxFileBytes)
      const fixed = makeFixedStream(size)
      // 两端同时驱动以保持背压；长度不一致由 FixedLengthStream 拒绝。
      const controller = new AbortController()
      const copying = response.body.pipeTo(fixed.writable, { signal: controller.signal })
      const storing = bucket
        .put(key, fixed.readable, { httpMetadata: { contentType: mime } })
        .catch((error: unknown) => {
          controller.abort(error)
          throw error
        })
      const results = await Promise.allSettled([copying, storing])
      for (const result of results) if (result.status === 'rejected') throw result.reason
      return { mime, size }
    }
    const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: mime } })
    const reader = response.body.getReader()
    const parts: R2UploadedPart[] = []
    let size = 0
    let buffer = new Uint8Array(PART_BYTES)
    let buffered = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limits.maxFileBytes)
          throw new AppError('FILE_TOO_LARGE', 'Media exceeds the file size limit')
        let offset = 0
        while (offset < value.byteLength) {
          const count = Math.min(PART_BYTES - buffered, value.byteLength - offset)
          buffer.set(value.subarray(offset, offset + count), buffered)
          buffered += count
          offset += count
          if (buffered === PART_BYTES) {
            parts.push(await upload.uploadPart(parts.length + 1, buffer))
            buffer = new Uint8Array(PART_BYTES)
            buffered = 0
          }
        }
      }
      checkSize(size, limits.maxFileBytes)
      // R2 只允许最后一片小于 5 MiB。
      if (buffered)
        parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, buffered)))
      await upload.complete(parts)
      return { mime, size }
    } catch (error) {
      const cleanup = await Promise.allSettled([reader.cancel(error), upload.abort()])
      if (cleanup[1]?.status === 'rejected')
        log.warn('storage.media.multipart_abort_failed', { key })
      throw error
    } finally {
      reader.releaseLock()
    }
  } catch (error) {
    if (response.body && !response.body.locked) await response.body.cancel(error)
    throw error
  }
}

function describeFile(row: File): PersistedMediaFile {
  return {
    id: row.id,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    duration: row.duration,
  }
}

/** 确定性对象 key 与唯一 file.r2Key 让 Workflow 步骤可安全重放。 */
export async function persistMediaOutputs({
  db,
  bucket,
  task,
  result,
  limits,
  fetch: fetcher = globalThis.fetch,
  fixedLengthStream = (size) => new FixedLengthStream(size),
}: {
  readonly db: Database
  readonly bucket: MediaBucket
  readonly task: Pick<AiTask, 'id' | 'workspaceId' | 'userId'>
  readonly result: MediaCopyResult
  readonly limits: MediaCopyLimits
  readonly fetch?: typeof fetch
  readonly fixedLengthStream?: FixedStreamFactory
}): Promise<PersistedMediaFile[]> {
  // Workflow 同一实例的转存步骤串行重放；pending 记录作为中断后的清理线索。
  for (const output of result.outputs) {
    allowedUrl(output.url, limits.allowedHosts)
    if (!limits.allowedMimeTypes.includes(output.mime))
      throw new AppError('FILE_TYPE_NOT_ALLOWED', 'Media type is not allowed')
  }
  const plan = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${task.workspaceId}`}, 0))`,
    )
    const tenant = scoped(tx, task.workspaceId)
    const [current] = await tenant.select(aiTask, { where: eq(aiTask.id, task.id) }).for('update')
    if (!current) throw notFound()
    if (current.status === 'failed' || current.status === 'canceled')
      throw new AppError('MEDIA_TASK_TERMINAL', 'Media task is no longer active', { status: 409 })
    const [workspace] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(and(eq(organization.id, task.workspaceId), isNull(organization.deletedAt)))
    if (!workspace) throw notFound()
    const entries: { row: File; output: MediaCopyResult['outputs'][number] }[] = []
    for (const [index, output] of result.outputs.entries()) {
      const key = `ws/${task.workspaceId}/ai/${task.id}/${index}`
      const [existing] = await tenant.select(file, { where: eq(file.r2Key, key) })
      if (existing?.status === 'ready' && !existing.deletedAt) {
        entries.push({ row: existing, output })
        continue
      }
      if (current.status === 'succeeded' || existing?.status === 'ready')
        throw new AppError('MEDIA_TASK_TERMINAL', 'Media output is no longer writable', {
          status: 409,
        })
      const values = {
        userId: current.userId,
        purpose: 'ai_output' as const,
        status: 'pending' as const,
        r2Key: key,
        mime: output.mime,
        size: 0,
        sourceTaskId: task.id,
        width: output.width,
        height: output.height,
        duration: output.durationSec,
        deletedAt: null,
        // pending 重试重新开始清理窗口，避免上一轮旧记录在本轮复制中被 Cron 清理。
        createdAt: new Date(),
      }
      const [row] = await tenant
        .insert(file, values)
        .onConflictDoUpdate({ target: file.r2Key, set: values })
        .returning()
      if (!row) throw new Error('Media file insert returned no row')
      entries.push({ row, output })
    }
    return entries
  })

  try {
    const copied = new Map<string, { mime: string; size: number }>()
    // 下载与上传不持有数据库连接或空间锁。
    for (const entry of plan) {
      if (entry.row.status === 'ready') continue
      copied.set(
        entry.row.id,
        await copyOutput(bucket, entry.row.r2Key, entry.output, limits, fetcher, fixedLengthStream),
      )
    }
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${task.workspaceId}`}, 0))`,
      )
      const tenant = scoped(tx, task.workspaceId)
      const [current] = await tenant.select(aiTask, { where: eq(aiTask.id, task.id) }).for('update')
      if (!current) throw notFound()
      if (current.status === 'failed' || current.status === 'canceled')
        throw new AppError('MEDIA_TASK_TERMINAL', 'Media task is no longer active', { status: 409 })
      const [workspace] = await tx
        .select({ id: organization.id })
        .from(organization)
        .where(and(eq(organization.id, task.workspaceId), isNull(organization.deletedAt)))
      if (!workspace) throw notFound()
      const rows = await Promise.all(plan.map((entry) => tenant.findById(file, entry.row.id)))
      let addedBytes = 0
      for (const row of rows) {
        if (row.deletedAt)
          throw new AppError('MEDIA_TASK_TERMINAL', 'Media output is no longer writable', {
            status: 409,
          })
        if (row.status === 'ready') continue
        if (current.status === 'succeeded')
          throw new AppError('MEDIA_TASK_TERMINAL', 'Media task is no longer writable', {
            status: 409,
          })
        const stored = copied.get(row.id)
        if (!stored) throw new Error('Missing copied media output')
        addedBytes += stored.size
      }
      if (
        addedBytes &&
        (await getStorageUsage(tx, task.workspaceId)) + addedBytes > limits.storageBytes
      )
        throw new AppError('UPGRADE_REQUIRED', 'Workspace storage quota exceeded', { status: 403 })
      const files: PersistedMediaFile[] = []
      for (const row of rows) {
        const stored = copied.get(row.id)
        files.push(
          describeFile(
            row.status === 'ready'
              ? row
              : await tenant.updateById(file, row.id, {
                  status: 'ready',
                  size: stored?.size,
                  mime: stored?.mime,
                }),
          ),
        )
      }
      return files
    })
  } catch (error) {
    try {
      const abandoned = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${task.workspaceId}`}, 0))`,
        )
        const tenant = scoped(tx, task.workspaceId)
        const keys: string[] = []
        for (const entry of plan) {
          if (entry.row.status === 'ready') continue
          const [row] = await tenant
            .select(file, { where: eq(file.id, entry.row.id) })
            .for('update')
          // COMMIT 响应丢失或已完成重放时，绝不能删除已确认对象。
          if (!row || row.status === 'ready') continue
          await tenant.updateById(file, row.id, { deletedAt: new Date() })
          keys.push(row.r2Key)
        }
        return keys
      })
      for (const key of abandoned) {
        try {
          await bucket.delete(key)
        } catch {
          log.warn('storage.media.cleanup_failed', {
            workspaceId: task.workspaceId,
            taskId: task.id,
            key,
          })
        }
      }
    } catch {
      log.warn('storage.media.cleanup_transaction_failed', {
        workspaceId: task.workspaceId,
        taskId: task.id,
      })
    }
    throw error
  }
}
