import { describe, expect, it } from 'vitest'
import {
  formatDuration,
  galleryCanonicalPath,
  galleryHref,
  parseGallerySearch,
  studioRemixHref,
} from './paths.ts'

describe('画廊地址规则', () => {
  it('整理查询参数：未知类型与排序丢弃，第一页不带 page', () => {
    expect(parseGallerySearch({ kind: 'audio', sort: 'top', page: '1' })).toEqual({})
    expect(parseGallerySearch({ kind: 'video', sort: 'featured', page: '3', cursor: 'x' })).toEqual(
      {
        kind: 'video',
        sort: 'featured',
        page: 3,
        cursor: 'x',
      },
    )
    // 非法页码原样保留，由公开查询返回 404
    expect(parseGallerySearch({ page: 'abc' }).page).toBe(0)
  })

  it('地址参数顺序固定，便于边缘缓存命中同一个键', () => {
    expect(galleryHref()).toBe('/gallery')
    expect(galleryHref({ page: 2, sort: 'featured', kind: 'image' })).toBe(
      '/gallery?kind=image&sort=featured&page=2',
    )
    expect(galleryHref({ page: 1 })).toBe('/gallery')
  })

  it('canonical：筛选与游标指向无参数的第一页，只带页码时指向自身', () => {
    expect(galleryCanonicalPath({})).toBe('/gallery')
    expect(galleryCanonicalPath({ page: 4 })).toBe('/gallery?page=4')
    expect(galleryCanonicalPath({ kind: 'video', page: 2 })).toBe('/gallery')
    expect(galleryCanonicalPath({ sort: 'featured' })).toBe('/gallery')
    expect(galleryCanonicalPath({ cursor: 'latest~x~y' })).toBe('/gallery')
  })

  it('做同款预填：提示词只在公开时带上', () => {
    expect(studioRemixHref('me', { modelKey: 'flux', prompt: '雾中 湖面' })).toBe(
      '/app/me/studio?model=flux&prompt=%E9%9B%BE%E4%B8%AD+%E6%B9%96%E9%9D%A2',
    )
    expect(studioRemixHref('me', { modelKey: 'flux', prompt: null })).toBe(
      '/app/me/studio?model=flux',
    )
  })

  it('视频时长角标', () => {
    expect(formatDuration(5_000)).toBe('0:05')
    expect(formatDuration(65_400)).toBe('1:05')
  })
})
