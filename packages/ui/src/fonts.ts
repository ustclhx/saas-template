// Inter 可变字体（opsz 轴）的拉丁子集地址：根布局用它输出 <link rel="preload">，
// 让首屏英文正文尽早换成 Inter，减少 font-display: swap 带来的版面跳动。
// 其他子集（拉丁扩展、西里尔等）只按 unicode-range 按需下载，不预加载。
import interLatinOpsz from '@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2?url'

export const fontPreloads = [{ href: interLatinOpsz, type: 'font/woff2' }] as const
