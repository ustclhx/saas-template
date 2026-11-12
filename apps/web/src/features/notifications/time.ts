import { m } from '../../paraglide/messages.js'
import type { Locale } from '../../paraglide/runtime.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 通知时间的相对显示（仓库里还没有通用的相对时间工具）：一分钟内「刚刚」，一小时内按分钟、一天内按小时，
 * 两天内「昨天」、一周内按天，更早显示月-日（跨年时带年份）。只在浏览器端渲染（弹层打开后才出现），不涉及水合差异。
 */
export function relativeTime(value: Date | string, locale: Locale, now: Date = new Date()) {
  const date = typeof value === 'string' ? new Date(value) : value
  const diff = now.getTime() - date.getTime()
  if (Number.isNaN(diff)) return ''
  if (diff < MINUTE) return m.notifications_just_now({}, { locale })
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), 'minute')
  if (diff < DAY) return rtf.format(-Math.floor(diff / HOUR), 'hour')
  if (diff < 7 * DAY) return rtf.format(-Math.floor(diff / DAY), 'day')
  return new Intl.DateTimeFormat(locale, {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}
