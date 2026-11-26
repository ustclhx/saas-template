import { describe, expect, it } from 'vitest'
import { canWriteStudio, studioFileUrl, studioWorkPreviewUrl } from '../src/web/work-urls.ts'

const WORK = '01900000-0000-7000-8000-0000000000AA'
const FALLBACK = studioFileUrl('ws-1', 'file-1')
const work = (values: Partial<Parameters<typeof studioWorkPreviewUrl>[0] & object> = {}) => ({
  id: WORK,
  site: 'default',
  version: 3,
  visibility: 'public' as const,
  moderation: 'pending' as const,
  ...values,
})

describe('我的作品预览地址', () => {
  it('单站点：公开中的作品用 APP_URL 来源的绝对公开媒体地址', () => {
    expect(studioWorkPreviewUrl(work(), FALLBACK, { appUrl: 'https://app.example/path' })).toBe(
      `https://app.example/media/w/${WORK.toLowerCase()}/3`,
    )
  })

  it('多站点：按作品站点取来源，app 在其他主机时仍能命中公开媒体路由', () => {
    const sites = { default: 'https://a.example', b: 'https://b.example' }
    expect(
      studioWorkPreviewUrl(work({ site: 'b', moderation: 'approved' }), FALLBACK, {
        appUrl: 'https://app.example',
        sites,
      }),
    ).toBe(`https://b.example/media/w/${WORK.toLowerCase()}/3`)
  })

  it('站点来源无法解析、未公开、已隐藏或已下架时回退到空间文件接口', () => {
    const appUrl = 'https://app.example'
    const sites = { b: 'https://b.example' }
    expect(studioWorkPreviewUrl(work({ site: 'gone' }), FALLBACK, { appUrl, sites })).toBe(FALLBACK)
    expect(studioWorkPreviewUrl(work({ visibility: 'private' }), FALLBACK, { appUrl })).toBe(
      FALLBACK,
    )
    expect(studioWorkPreviewUrl(work({ moderation: 'hidden' }), FALLBACK, { appUrl })).toBe(
      FALLBACK,
    )
    expect(studioWorkPreviewUrl(work({ moderation: 'removed' }), FALLBACK, { appUrl })).toBe(
      FALLBACK,
    )
    expect(studioWorkPreviewUrl(null, FALLBACK, { appUrl })).toBe(FALLBACK)
    expect(FALLBACK).toBe('/api/files/file-1?workspaceId=ws-1')
  })

  it('只有未只读的 owner / admin / member 可写', () => {
    expect(canWriteStudio({ role: 'member', workspaceReadOnly: false })).toBe(true)
    expect(canWriteStudio({ role: 'owner', workspaceReadOnly: true })).toBe(false)
    expect(canWriteStudio({ role: 'viewer', workspaceReadOnly: false })).toBe(false)
  })
})
