// 把启用插件的 jobs 入口合并到核心注册表；两目标入口各自传入生成文件中的列表。

import { registerHoldSweeper } from '@saas/billing'
import type { TemplateConfig } from '@saas/config'
import type { JobsPluginModule, PluginCronGroup, PluginCronTask } from './module.ts'

/** 登记插件的积分预扣清理器；返回注销函数（停机与测试用） */
export function registerPluginHoldSweepers(
  plugins: readonly JobsPluginModule[],
  template: TemplateConfig,
) {
  const dispose = plugins.flatMap((plugin) =>
    (plugin.holdSweepers ?? []).flatMap((sweeper) => {
      const handler = sweeper.create(template)
      return handler ? [registerHoldSweeper(sweeper.refType, handler)] : []
    }),
  )
  return () => {
    for (const unregister of dispose) unregister()
  }
}

export function pluginCronTasks(
  plugins: readonly JobsPluginModule[] | undefined,
  group: PluginCronGroup,
): PluginCronTask[] {
  return (plugins ?? [])
    .flatMap((plugin) => plugin.crons ?? [])
    .filter((task) => task.group === group)
}

/** 启用插件声明的基础队列名（Node 逐个注册到持久队列） */
export function pluginQueueNames(plugins: readonly JobsPluginModule[] | undefined) {
  return (plugins ?? []).flatMap((plugin) => plugin.queues ?? []).map((handler) => handler.name)
}

export function pluginQueueHandler(
  plugins: readonly JobsPluginModule[] | undefined,
  queue: string,
) {
  return (plugins ?? [])
    .flatMap((plugin) => plugin.queues ?? [])
    .find((handler) =>
      [handler.name, `${handler.name}-staging`, `${handler.name}-production`].includes(queue),
    )
}
