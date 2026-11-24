import { templateConfig } from '@web/server/template-config.ts'
import { agentsConfigSchema } from '../config.ts'

/** web 侧（页面与服务端函数）解析后的 `plugins.agents` 配置段；生成注册文件时已校验，这里补默认值 */
export const agentsWebConfig = agentsConfigSchema.parse(templateConfig.plugins.agents ?? {})
