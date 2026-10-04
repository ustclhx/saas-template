import {
  Alert,
  AlertDescription,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@saas/ui'
import { type ReactNode, useEffect, useState } from 'react'

/** 认证页面的公共外框：居中卡片 + 标题 / 说明 / 页脚链接 */
export function AuthLayout({
  title,
  description,
  footer,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{title}</h1>
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent>
          {/* SSR controls stay disabled until event handlers are attached. */}
          <fieldset disabled={!hydrated} className="grid min-w-0 gap-6">
            {children}
          </fieldset>
        </CardContent>
        {footer ? (
          <CardFooter className="justify-center text-muted-foreground text-sm">{footer}</CardFooter>
        ) : null}
      </Card>
    </main>
  )
}

/** 表单级错误提示（接口错误按错误码给出的文案） */
export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

/** 成功 / 状态提示 */
export function StatusAlert({ children }: { children: ReactNode }) {
  return (
    <Alert variant="success">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}
