// 分享卡片版式（1200×630）：服务端由 satori 渲染，只用 flex 子集与主题解析值。
// 尺寸与间距照设计稿副本 docs/design-system/prototypes/share-cards/Card.dc.html。
import type { JSX } from 'react'
import { templateConfig } from '../../server/template-config.ts'
import type { SampleShareData } from './sample.ts'
import { truncateText } from './text.ts'
import type { ShareCardTheme } from './types.ts'

export const SHARE_CARD_WIDTH = 1200
export const SHARE_CARD_HEIGHT = 630

/** 截断上限按字宽计（CJK 记 1，拉丁约 0.55），与设计稿的中文 28 / 52 字一致。 */
export const SHARE_CARD_TEXT_LIMITS = { title: 28, summary: 52, badge: 12, meta: 36 } as const

export interface ShareCardLayoutContent {
  readonly title: string
  readonly summary?: string | undefined
  readonly badge?: string | undefined
  readonly meta?: string | undefined
  /** `hero`：构建期默认分享图的大标题；`card`：结果卡片。 */
  readonly size?: 'card' | 'hero'
}

// Inter 优先：拉丁字符使用 Inter 的真实 600 字重，CJK 只有常规体，按需回退到 Noto Sans SC。
const FONT_FAMILY = 'Inter, "Noto Sans SC"'

function siteHost(): string {
  try {
    return new URL(templateConfig.app.url).host
  } catch {
    return templateConfig.app.url
  }
}

/** 默认版式：品牌行、标题与摘要、底部元信息与站点域名。 */
export function shareCardLayout(
  content: ShareCardLayoutContent,
  theme: ShareCardTheme,
): JSX.Element {
  const hero = content.size === 'hero'
  const titleSize = hero ? 76 : 60
  const titleLeading = hero ? 92 : 74
  const badge = content.badge && truncateText(content.badge, SHARE_CARD_TEXT_LIMITS.badge)
  const summary = content.summary && truncateText(content.summary, SHARE_CARD_TEXT_LIMITS.summary)
  const meta = content.meta && truncateText(content.meta, SHARE_CARD_TEXT_LIMITS.meta)
  const appName = templateConfig.app.name
  return (
    <div
      style={{
        width: SHARE_CARD_WIDTH,
        height: SHARE_CARD_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        padding: '64px 72px',
        background: theme.background,
        color: theme.foreground,
        fontFamily: FONT_FAMILY,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: theme.radius + 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 28,
              fontWeight: 600,
              background: theme.primary,
              color: theme.primaryForeground,
            }}
          >
            {(Array.from(appName)[0] ?? '').toUpperCase()}
          </div>
          <div style={{ display: 'flex', fontSize: 30, lineHeight: '36px', fontWeight: 600 }}>
            {appName}
          </div>
        </div>
        {badge ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 44,
              padding: '0 20px',
              borderRadius: 9999,
              fontSize: 22,
              fontWeight: 500,
              background: theme.secondary,
              color: theme.mutedForeground,
            }}
          >
            {badge}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          flexGrow: 1,
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: titleSize,
            lineHeight: `${titleLeading}px`,
            fontWeight: 600,
            letterSpacing: -titleSize * 0.01,
            // 最多两行；截断已在渲染前完成，这里只兜底
            maxHeight: titleLeading * 2,
            overflow: 'hidden',
          }}
        >
          {truncateText(content.title, SHARE_CARD_TEXT_LIMITS.title)}
        </div>
        {summary ? (
          <div
            style={{
              display: 'flex',
              fontSize: 28,
              lineHeight: '42px',
              maxHeight: 84,
              overflow: 'hidden',
              color: theme.mutedForeground,
            }}
          >
            {summary}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 28,
          borderTop: `1px solid ${theme.border}`,
          fontSize: 24,
          lineHeight: '32px',
          color: theme.mutedForeground,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>{meta ?? ''}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{ width: 12, height: 12, borderRadius: 9999, background: theme.brandAccent }}
          />
          <div style={{ display: 'flex', color: theme.foreground, fontWeight: 500 }}>
            {siteHost()}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 构建期默认分享图：设计稿 `default` 变体，无标签与摘要。 */
export function defaultShareCardLayout(title: string, theme: ShareCardTheme): JSX.Element {
  return shareCardLayout(
    { title, meta: `${templateConfig.app.name} · AI workspace`, size: 'hero' },
    theme,
  )
}

/** 示例类型 `sample` 的版式：标签、标题、摘要与元信息。 */
export function sampleShareCardLayout(data: SampleShareData, theme: ShareCardTheme): JSX.Element {
  return shareCardLayout(
    { title: data.title, summary: data.description, badge: data.label, meta: data.meta },
    theme,
  )
}
