import { log } from '@saas/shared/log'
import type { Storage, StorageReadRange, StorageReadResult } from '@saas/storage'
import type { StudioKind } from '../kinds.ts'
import { STUDIO_MEDIA_PREFIX, studioMediaPath } from './media-url.ts'
import type { getPublicWorkMedia } from './public-works.ts'

const cacheControl = 'public, max-age=3600, s-maxage=86400'
const addressPattern = /^([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/(\d+)$/i
const rangePattern = /^bytes=(\d*)-(\d*)$/i

interface MediaEdge {
  cache: {
    match(request: Request): Promise<Response | undefined>
    put(url: string, response: Response): Promise<void>
  }
  waitUntil(promise: Promise<unknown>): void
  fixedLength?: (body: ReadableStream<Uint8Array>, size: number) => ReadableStream<Uint8Array>
}

export interface MediaOptions {
  site: { key: string; origin: string } | null
  kinds: readonly StudioKind[]
  findMedia?: (
    input: Parameters<typeof getPublicWorkMedia>[1],
  ) => ReturnType<typeof getPublicWorkMedia>
  read?: NonNullable<Storage['read']>
  edge?: MediaEdge
}

function errorResponse(status: number, headers?: Record<string, string>) {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

function byteRange(start: string, end: string, size: number): StorageReadRange | null {
  if (size === 0) return null
  if (start === '') {
    const length = Math.min(Number(end), size)
    return length > 0 ? { offset: size - length, length } : null
  }
  const offset = Number(start)
  const last = end === '' ? size - 1 : Math.min(Number(end), size - 1)
  return offset <= last ? { offset, length: last - offset + 1 } : null
}

function mediaResponse(
  object: StorageReadResult,
  mime: string,
  body: ReadableStream<Uint8Array> | null,
  range?: { offset: number; total: number },
) {
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      'Cache-Control': cacheControl,
      'Content-Type': mime,
      'Content-Length': String(object.size),
      'Accept-Ranges': 'bytes',
      ETag: object.etag,
      'X-Content-Type-Options': 'nosniff',
      ...(range && {
        'Content-Range': `bytes ${range.offset}-${range.offset + object.size - 1}/${range.total}`,
      }),
    },
  })
}

function warnFailure(event: string, workId: string, version: number, error: unknown) {
  log.warn(event, {
    workId,
    version,
    errorName: error instanceof Error ? error.name : typeof error,
  })
}

export async function handleStudioMedia(
  request: Request,
  options: (url: URL) => MediaOptions,
): Promise<Response | undefined> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(STUDIO_MEDIA_PREFIX)) return undefined
  const [, id, versionText] =
    addressPattern.exec(url.pathname.slice(STUDIO_MEDIA_PREFIX.length)) ?? []
  if (!id || !versionText) return errorResponse(404)
  const workId = id.toLowerCase()
  const version = Number(versionText)
  if (!Number.isInteger(version) || version < 1 || version > 2_147_483_647)
    return errorResponse(404)
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return errorResponse(405, { Allow: 'GET, HEAD' })

  const { site, kinds, findMedia, read, edge: mediaEdge } = options(url)
  if (!findMedia || !read) return errorResponse(503)
  if (!site || kinds.length === 0) return errorResponse(404)

  const canonicalUrl = new URL(studioMediaPath(workId, version), site.origin).href
  // 别名可直读单站点内容，但仅在实际规范域名上写入 Cache API，确保能按同一 URL 清除。
  const edge = url.origin === site.origin ? mediaEdge : undefined
  const head = request.method === 'HEAD'
  const rangeHeader =
    !head && !request.headers.has('If-Range') ? request.headers.get('Range') : null
  const [rangeText, start = '', end = ''] = rangeHeader?.match(rangePattern) ?? []
  const rangeRequest = start || end ? rangeText : undefined

  if (edge) {
    try {
      const hit = await edge.cache.match(
        new Request(canonicalUrl, rangeRequest ? { headers: { Range: rangeRequest } } : {}),
      )
      if (hit) {
        const mime = hit.headers.get('Content-Type')
        const available = kinds.some((kind) => mime?.startsWith(`${kind}/`))
        if (available && hit.status === (rangeRequest ? 206 : 200)) {
          if (!head) return hit
          await hit.body?.cancel()
          return new Response(null, { headers: hit.headers })
        }
        await hit.body?.cancel()
      }
    } catch (error) {
      warnFailure('studio.media.cache_match_failed', workId, version, error)
    }
  }

  try {
    const media = await findMedia({ site: site.key, kinds, workId, version })
    if (!media) return errorResponse(404)
    const range = rangeRequest ? byteRange(start, end, media.size) : undefined
    if (range === null) return errorResponse(416, { 'Content-Range': `bytes */${media.size}` })
    const object = await read(media.r2Key, range)
    if (!object) return errorResponse(404)
    if (head) {
      await object.body.cancel()
      return mediaResponse(object, media.mime, null)
    }

    const bodyWithLength = (body: ReadableStream<Uint8Array>, size: number) =>
      mediaEdge?.fixedLength?.(body, size) ?? body
    const putFullObject = (full: StorageReadResult, body: ReadableStream<Uint8Array>) =>
      edge?.cache.put(
        canonicalUrl,
        mediaResponse(full, media.mime, bodyWithLength(body, full.size)),
      )
    const fill = (write: () => Promise<void>) =>
      edge?.waitUntil(
        write().catch((error) =>
          warnFailure('studio.media.cache_put_failed', workId, version, error),
        ),
      )

    if (range) {
      // 缓存只接收完整 200。范围读独立返回，完整对象由后台流式读取和回填。
      fill(async () => {
        const full = await read(media.r2Key)
        if (full) await putFullObject(full, full.body)
      })
      return mediaResponse(object, media.mime, bodyWithLength(object.body, object.size), {
        offset: range.offset,
        total: media.size,
      })
    }
    if (edge) {
      const [client, copy] = object.body.tee()
      fill(async () => {
        await putFullObject(object, copy)
      })
      return mediaResponse(object, media.mime, bodyWithLength(client, object.size))
    }
    return mediaResponse(object, media.mime, bodyWithLength(object.body, object.size))
  } catch (error) {
    warnFailure('studio.media.read_failed', workId, version, error)
    return errorResponse(503)
  }
}
