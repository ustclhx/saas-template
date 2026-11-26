import type { BadgeColor } from '@saas/ui'
import { m } from '@web/paraglide/messages.js'
import { getLocale } from '@web/paraglide/runtime.js'

/** 作品在「我的作品」中的状态：未发布与已取消发布都算未公开；已下架优先于可见性。 */
export type StudioWorkState = 'private' | 'pending' | 'approved' | 'hidden' | 'removed'

export interface StudioWorkStatus {
  visibility: 'public' | 'private'
  moderation: 'pending' | 'approved' | 'hidden' | 'removed'
  removalReason?: string | null
}

export function studioWorkState(work: StudioWorkStatus | null): StudioWorkState {
  if (!work) return 'private'
  if (work.moderation === 'removed') return 'removed'
  if (work.visibility === 'private') return 'private'
  return work.moderation
}

/** 徽标颜色与设计稿备注一致：未公开中性、待审核与已隐藏提醒色、已公开成功色、已下架危险色。 */
export function studioWorkBadge(work: StudioWorkStatus | null): {
  label: string
  color: BadgeColor
} {
  switch (studioWorkState(work)) {
    case 'private':
      return { label: m.studio_state_private(), color: 'gray' }
    case 'pending':
      return { label: m.studio_state_pending(), color: 'amber' }
    case 'approved':
      return { label: m.studio_state_approved(), color: 'green' }
    case 'hidden':
      return { label: m.studio_state_hidden(), color: 'amber' }
    case 'removed':
      return {
        label: work?.removalReason
          ? m.studio_state_removed_reason({ reason: work.removalReason })
          : m.studio_state_removed(),
        color: 'red',
      }
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 视频时长角标：m:ss。 */
export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function formatWorkTime(iso: string) {
  return new Intl.DateTimeFormat(getLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

/** 发布标题默认取提示词前 120 个字符（服务端同样限制 120）。 */
export const STUDIO_TITLE_MAX = 120

export function defaultWorkTitle(prompt: string | null | undefined) {
  return (prompt ?? '').trim().replace(/\s+/g, ' ').slice(0, STUDIO_TITLE_MAX)
}
