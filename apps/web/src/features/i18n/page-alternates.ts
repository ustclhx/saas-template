import { useRouterState } from '@tanstack/react-router'
import { useMemo } from 'react'
import {
  alternatesFromLinks,
  alternatesKey,
  type PageAlternates,
  parseAlternatesKey,
  routeLinks,
} from '../seo/alternates.ts'

/**
 * 当前页 hreflang 声明的语言版本（与 `<HeadContent>` 输出的同一份路由 head 数据）。
 * 服务端渲染与客户端导航后都可用；只在语言版本变化时触发重新渲染。
 */
export function usePageAlternates(): PageAlternates {
  const key = useRouterState({
    select: (state) => alternatesKey(alternatesFromLinks(routeLinks(state.matches))),
  })
  return useMemo(() => parseAlternatesKey(key), [key])
}
