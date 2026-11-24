import templateConfig from '../../../../template.config.ts'
import { agentsConfigSchema } from '../config.ts'

/** 解析后的 `plugins.agents` 配置段；生成注册文件时已校验，这里取默认值 */
export const agentsConfig = agentsConfigSchema.parse(templateConfig.plugins.agents ?? {})
