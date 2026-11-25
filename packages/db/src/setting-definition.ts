import type { z } from 'zod'

export interface SettingDefinition<Schema extends z.ZodType = z.ZodType> {
  readonly schema: Schema
  readonly default: z.output<Schema>
  readonly description: string
  readonly secret: boolean
}

/** Schema 须接受默认值及规范化后写入数据库的值。 */
export function defineSetting<Schema extends z.ZodType>(
  definition: Omit<SettingDefinition<Schema>, 'secret'> & { readonly secret?: boolean },
): SettingDefinition<Schema> {
  return { ...definition, secret: definition.secret ?? false }
}
