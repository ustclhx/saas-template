import { createContext, type ReactNode, useContext, useEffect } from 'react'
import { createPortal } from 'react-dom'

// 工作台顶部条的页面级扩展点（tasks 8.3）：页面渲染 <AppShellBar>，把标题、操作与进度条放进壳的顶部条，
// 壳不认识具体页面（阅读器等）。内容经 portal 挂到顶部条的插槽，水合后出现；服务端首屏显示默认标题（当前导航项）。

export interface AppShellBarSlots {
  title: HTMLElement | null
  actions: HTMLElement | null
  progress: HTMLElement | null
  /** 页面提供了标题时隐藏默认标题 */
  setCustomTitle: (custom: boolean) => void
}

export const AppShellBarContext = createContext<AppShellBarSlots | null>(null)

/** 是否在提供顶部条插槽的工作台壳里（顶部布局中为 false，页面应自行渲染自己的工具条） */
export function useAppShellBarAvailable() {
  return useContext(AppShellBarContext) !== null
}

export interface AppShellBarProps {
  /** 替换默认标题（如面包屑） */
  title?: ReactNode
  /** 顶部条右侧操作（如导出按钮），排在语言与主题切换之前 */
  actions?: ReactNode
  /** 顶部条底边的进度条位置（如阅读进度），宽度占满顶部条 */
  progress?: ReactNode
}

export function AppShellBar({ title, actions, progress }: AppShellBarProps) {
  const slots = useContext(AppShellBarContext)
  const hasTitle = title !== undefined && title !== null
  const setCustomTitle = slots?.setCustomTitle
  useEffect(() => {
    if (!setCustomTitle || !hasTitle) return
    setCustomTitle(true)
    return () => setCustomTitle(false)
  }, [setCustomTitle, hasTitle])
  if (!slots) return null
  return (
    <>
      {hasTitle && slots.title ? createPortal(title, slots.title) : null}
      {actions && slots.actions ? createPortal(actions, slots.actions) : null}
      {progress && slots.progress ? createPortal(progress, slots.progress) : null}
    </>
  )
}
