import type { IconComponent } from '@saas/ui'

/**
 * 预览页用的示例图标：应用层不能直接导入 lucide-react（pnpm check:deps），这里用 currentColor 的内联 SVG
 * 演示组件的图标槽位（Button leadingIcon、Sidebar 菜单项、Tabs 图标等）。业务页面需要图标时另行决定来源。
 */
function svg(paths: readonly string[]): IconComponent {
  return function PreviewIcon({ size = 16, strokeWidth = 1.5, className }) {
    return (
      <svg
        aria-hidden
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    )
  }
}

export const HomeIcon = svg(['M3 10.5 12 3l9 7.5', 'M5 9.5V21h14V9.5'])
export const FolderIcon = svg([
  'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z',
])
export const InboxIcon = svg(['M3 13h5l1.5 3h5L16 13h5', 'M5 5h14l2 8v6H3v-6z'])
export const SettingsIcon = svg([
  'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  'M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6A7 7 0 0 0 19 12z',
])
export const PlusIcon = svg(['M12 5v14', 'M5 12h14'])
export const ArrowRightIcon = svg(['M5 12h14', 'M13 6l6 6-6 6'])
