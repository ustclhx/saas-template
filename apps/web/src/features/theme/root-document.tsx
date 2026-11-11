import { UiRoot } from '@saas/ui'
import { fontPreloads } from '@saas/ui/fonts'
import { HeadContent, Scripts } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { preload } from 'react-dom'
import { getLocale } from '../../paraglide/runtime.js'
import { templateConfig } from '../../server/template-config.ts'
import { ThemeToggle } from './theme-toggle.tsx'

/**
 * 根布局的 HTML 外壳：从路由文件中拆出，便于单测服务端输出。
 * 主题类名由 <head> 内联脚本在水合前写到 <html> 上，与服务端输出不一致属预期；
 * 主题预设在服务端直接写入 data-preset，不依赖客户端脚本，首屏即为最终配色。
 */
export function RootDocument({
  children,
  floatingControls,
  htmlAttributes,
}: Readonly<{
  children: ReactNode
  floatingControls: boolean
  htmlAttributes?: Record<string, string>
}>) {
  // 自托管 Inter 的拉丁子集：经 React 的资源提示输出，React 把字体预加载排在样式表之前，
  // 浏览器尽早下载，缩短字体替换造成的版面跳动（写在 head links 里会被排到样式表之后）
  for (const font of fontPreloads) {
    preload(font.href, { as: 'font', type: font.type, crossOrigin: 'anonymous' })
  }
  return (
    <html
      {...htmlAttributes}
      lang={getLocale()}
      data-preset={templateConfig.ui.preset}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
      </head>
      <body>
        <UiRoot shape={templateConfig.ui.shape} density={templateConfig.ui.density}>
          {children}
          {floatingControls && <ThemeToggle className="fixed right-4 bottom-4 print:hidden" />}
        </UiRoot>
        <Scripts />
      </body>
    </html>
  )
}
