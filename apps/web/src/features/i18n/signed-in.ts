import { useEffect } from 'react'
import { renewSession } from '../auth/auth-client.ts'
import { markSignedIn } from './home-locale.ts'

/**
 * 已登录页面（工作台、账号、后台）挂载时刷新客户端登录信号（home-locale.ts）：
 * 公开页据此判断已登录用户（语言切换保存到账号、首页记住语言），不必在公开页读会话或查库。
 * 同时按需续期会话（auth.sessionDays），活跃用户不会到期被登出。
 */
export function useSignedInHint(): void {
  useEffect(() => {
    markSignedIn()
    renewSession()
  }, [])
}
