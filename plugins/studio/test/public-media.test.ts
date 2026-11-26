import { describe, expect, it, vi } from 'vitest'
import { handleStudioMedia } from '../src/web/public-media.ts'

type MediaOptions = ReturnType<Parameters<typeof handleStudioMedia>[1]>

const SITE = { key: 'main', origin: 'https://studio.example' }
const WORK_ID = '01989d05-08a5-770b-8d81-e5d075f612ad'
const PRIVATE_WORK_ID = '01989d05-08a5-770b-8d81-e5d075f612ae'
const VERSION = 2
const MEDIA_PATH = `/media/w/${WORK_ID}/${VERSION}`
const MEDIA_URL = `${SITE.origin}${MEDIA_PATH}`
const CONTENT = '0123456789'
const FILE = { r2Key: 'studio/video.mp4', mime: 'video/mp4', size: CONTENT.length }
const ETAG = '"studio-etag"'
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400'

function edgeStub(cached?: Response) {
  const pending: Promise<unknown>[] = []
  const written: { status: number; headers: Headers; body: string }[] = []
  const match = vi.fn(async (_request: Request) => cached)
  const put = vi.fn(async (_url: string, response: Response) => {
    written.push({
      status: response.status,
      headers: response.headers,
      body: await response.text(),
    })
  })

  return {
    cache: { match, put },
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise)
    },
    pending,
    written,
  }
}

function mediaStub(overrides: Partial<MediaOptions> = {}) {
  const findMedia = vi.fn<NonNullable<MediaOptions['findMedia']>>(async () => FILE)
  const read = vi.fn<NonNullable<MediaOptions['read']>>(async (_key, range) => {
    const payload = range ? CONTENT.slice(range.offset, range.offset + range.length) : CONTENT
    const body = new Response(payload).body
    if (!body) throw new Error('测试数据缺少流式响应体')
    return { body, etag: ETAG, size: payload.length }
  })
  const options = { site: SITE, kinds: ['video'] as const, findMedia, read, ...overrides }
  return { fetch: (request: Request) => handleStudioMedia(request, () => options), findMedia, read }
}

describe('Studio 公开媒体', () => {
  it('命中边缘缓存时使用规范化地址并跳过查询和对象读取', async () => {
    const edge = edgeStub(new Response(CONTENT, { headers: { 'Content-Type': FILE.mime } }))
    const { fetch, findMedia, read } = mediaStub({ edge })
    const response = await fetch(
      new Request(`${MEDIA_URL}?source=gallery`, { headers: { Cookie: 'session=abc' } }),
    )

    expect(await response?.text()).toBe(CONTENT)
    expect(edge.cache.match).toHaveBeenCalledOnce()
    const [lookup] = edge.cache.match.mock.calls[0] ?? []
    expect(lookup?.url).toBe(MEDIA_URL)
    expect(lookup?.headers.get('cookie')).toBeNull()
    expect(findMedia).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(edge.cache.put).not.toHaveBeenCalled()
  })

  it('缓存接受 Range 查找并直接返回缓存中的 206', async () => {
    const edge = edgeStub(
      new Response('234', {
        status: 206,
        headers: { 'Content-Type': FILE.mime, 'Content-Range': 'bytes 2-4/10' },
      }),
    )
    const { fetch, findMedia, read } = mediaStub({ edge })
    const response = await fetch(
      new Request(`${MEDIA_URL}?source=gallery`, { headers: { Range: 'bytes=2-4' } }),
    )

    const [lookup] = edge.cache.match.mock.calls[0] ?? []
    expect(lookup?.url).toBe(MEDIA_URL)
    expect(lookup?.headers.get('range')).toBe('bytes=2-4')
    expect(response?.status).toBe(206)
    expect(response?.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(await response?.text()).toBe('234')
    expect(findMedia).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('缓存未命中时流式返回对象并异步回填完整的 200 响应', async () => {
    const edge = edgeStub()
    const { fetch, findMedia, read } = mediaStub({ edge })
    const response = await fetch(new Request(`${MEDIA_URL}?source=gallery`))

    expect(findMedia).toHaveBeenCalledExactlyOnceWith({
      site: SITE.key,
      kinds: ['video'],
      workId: WORK_ID,
      version: VERSION,
    })
    expect(read.mock.calls.map(([key, range]) => [key, range])).toEqual([[FILE.r2Key, undefined]])
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-length')).toBe('10')
    expect(response?.headers.get('content-type')).toBe(FILE.mime)
    expect(response?.headers.get('cache-control')).toBe(CACHE_CONTROL)
    expect(response?.headers.get('etag')).toBe(ETAG)
    expect(response?.headers.get('accept-ranges')).toBe('bytes')
    expect(response?.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response?.text()).toBe(CONTENT)

    expect(edge.pending).toHaveLength(1)
    await Promise.all(edge.pending)
    expect(edge.cache.put).toHaveBeenCalledOnce()
    expect(edge.cache.put.mock.calls[0]?.[0]).toBe(MEDIA_URL)
    const [cached] = edge.written
    expect(cached?.status).toBe(200)
    expect(cached?.headers.get('content-length')).toBe('10')
    expect(cached?.body).toBe(CONTENT)
  })

  it('Range 未命中时仅读取所需片段供客户端使用，完整对象单独回填缓存', async () => {
    const edge = edgeStub()
    const { fetch, read } = mediaStub({ edge })
    const response = await fetch(
      new Request(`${MEDIA_URL}?source=gallery`, { headers: { Range: 'bytes=2-4' } }),
    )

    expect(response?.status).toBe(206)
    expect(response?.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(response?.headers.get('content-length')).toBe('3')
    expect(await response?.text()).toBe('234')
    expect(edge.pending).toHaveLength(1)
    await Promise.all(edge.pending)
    expect(read.mock.calls.map(([key, range]) => [key, range])).toEqual([
      [FILE.r2Key, { offset: 2, length: 3 }],
      [FILE.r2Key, undefined],
    ])

    expect(edge.cache.put).toHaveBeenCalledOnce()
    expect(edge.cache.put.mock.calls[0]?.[0]).toBe(MEDIA_URL)
    const [cached] = edge.written
    expect(cached?.status).toBe(200)
    expect(cached?.headers.get('content-length')).toBe('10')
    expect(cached?.headers.get('content-range')).toBeNull()
    expect(cached?.body).toBe(CONTENT)
  })

  it('没有边缘缓存时只读取 Range 所需片段，并保留公共缓存头', async () => {
    const { fetch, read } = mediaStub()
    const response = await fetch(new Request(MEDIA_URL, { headers: { Range: 'bytes=-3' } }))

    expect(response?.status).toBe(206)
    expect(response?.headers.get('content-range')).toBe('bytes 7-9/10')
    expect(response?.headers.get('cache-control')).toBe(CACHE_CONTROL)
    expect(await response?.text()).toBe('789')
    expect(read).toHaveBeenCalledExactlyOnceWith(FILE.r2Key, { offset: 7, length: 3 })
  })

  it('HEAD 返回公开对象的响应头，响应体为空', async () => {
    const { fetch } = mediaStub()
    const response = await fetch(new Request(MEDIA_URL, { method: 'HEAD' }))

    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-length')).toBe('10')
    expect(response?.headers.get('etag')).toBe(ETAG)
    expect(response?.body).toBeNull()
  })

  it('对不可满足的 Range 返回 416，不读取对象', async () => {
    const { fetch, read } = mediaStub()
    const response = await fetch(new Request(MEDIA_URL, { headers: { Range: 'bytes=10-' } }))

    expect(response?.status).toBe(416)
    expect(response?.headers.get('content-range')).toBe('bytes */10')
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    { name: '私有作品', site: SITE, workId: PRIVATE_WORK_ID, version: VERSION },
    { name: '过期版本', site: SITE, workId: WORK_ID, version: VERSION - 1 },
    {
      name: '其他站点',
      site: { key: 'other', origin: 'https://other.example' },
      workId: WORK_ID,
      version: VERSION,
    },
  ])('$name 返回不可缓存的 404', async ({ site, workId, version }) => {
    const edge = edgeStub()
    const { fetch, findMedia, read } = mediaStub({ site, edge })
    findMedia.mockResolvedValueOnce(null)
    const response = await fetch(new Request(`${site.origin}/media/w/${workId}/${version}`))

    expect(findMedia).toHaveBeenCalledExactlyOnceWith({
      site: site.key,
      kinds: ['video'],
      workId,
      version,
    })
    expect(response?.status).toBe(404)
    expect(response?.headers.get('cache-control')).toBe('no-store')
    expect(read).not.toHaveBeenCalled()
    expect(edge.cache.put).not.toHaveBeenCalled()
  })

  it('运行时没有对象读取能力时返回不可缓存的 503', async () => {
    const response = await handleStudioMedia(new Request(MEDIA_URL), () => ({
      site: SITE,
      kinds: ['video'],
      findMedia: async () => FILE,
    }))

    expect(response?.status).toBe(503)
    expect(response?.headers.get('cache-control')).toBe('no-store')
  })
})
