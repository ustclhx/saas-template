# 项目会员功能授权

在订阅套餐的 `plan.features` JSON 中添加可选的 `capabilities`，例如：

```ts
const features = {
  ...existingFeatures,
  capabilities: { 'exports.advanced': true },
}
```

`can(ctx, 'exports.advanced')` 只接受该字典自身属性的严格布尔值 `true`。
未配置、未知键、继承属性与其他值均拒绝。旧 JSON 不需要补字段；这只是
`PlanFeatures` TypeScript 类型扩展，没有物理 schema 变化，无需 SQL 迁移或 push。
`publicApi`、`priorityQueue`、`watermark` 仍读取原顶层布尔字段；
`ai.useModel` 仍检查 models allowlist，调用时必须传 `{ modelKey, tags? }`。

权益来自当前空间最高有效订阅，或 free 套餐。套餐名、积分余额与购买积分包
均不能授予该功能；功能键也不替代空间成员鉴权。

## 服务端执行业务前检查

TanStack Server Function 复用现有中间件，继承实时会话与空间成员检查：

```ts
import { createServerFn } from '@tanstack/react-start'
import { withEntitlement } from '../../server/middleware.ts'

export const advancedExport = createServerFn({ method: 'POST' })
  .middleware([withEntitlement({ capability: 'exports.advanced' })])
  .handler(async ({ context }) => {
    return exportWorkspaceData(context.db, context.workspace.id)
  })
```

`exportWorkspaceData` 是项目自己的业务函数。中间件默认按写操作处理，拒绝只读
空间；纯读操作可以显式传第二参 `{ access: 'read' }`。没有权益时抛出
`AppError`，`code='UPGRADE_REQUIRED'`、HTTP 403，handler 不执行。

在已有会话、成员和写权限守卫的 HTTP handler 或业务服务中，也可直接要求权益：

```ts
import { getEntitlements, requireEntitlement } from '@saas/entitlements'

const entitlements = await getEntitlements(db, authorizedWorkspaceId, {
  pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
})
requireEntitlement(entitlements, { capability: 'exports.advanced' })
return exportWorkspaceData(db, authorizedWorkspaceId)
```

`db` 按请求创建，`authorizedWorkspaceId` 必须来自服务端成员鉴权结果。
HTTP 入口沿用现有 AppError 响应映射，保留 403 与错误 code。
需要保存带类型的 requirement 常量时，可声明
`EntitlementRequirement<'exports.advanced'>`；内置模型 requirement 仍要求 `modelKey`。

## UI 锁定态

在已鉴权的服务端 loader / Server Function 中获取相同的当前空间权益，将判定值
传给展示组件即可：

```ts
import { can, getEntitlements } from '@saas/entitlements'

const entitlements = await getEntitlements(db, authorizedWorkspaceId, {
  pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
})
return { advancedExportLocked: !can(entitlements, 'exports.advanced') }
```

```tsx
function ExportButton({ locked, onExport, onUpgrade }) {
  return (
    <button onClick={locked ? onUpgrade : onExport}>
      {locked ? '升级以使用高级导出' : '高级导出'}
    </button>
  )
}

<ExportButton
  locked={data.advancedExportLocked}
  onExport={() => advancedExport({ data: { slug } })}
  onUpgrade={() => navigate({ to: '/app/$slug/billing', params: { slug } })}
/>
```

以上为最小接线示例，展示组件由项目补齐 props 类型和本地化。锁定态用于提示和购买
入口，执行导出时服务端仍重新检查；套餐变更后客户端旧状态不能绕过授权。
