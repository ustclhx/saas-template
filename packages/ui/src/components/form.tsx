import { createFormHook, createFormHookContexts } from '@tanstack/react-form'
import { type ComponentProps, type FormEvent, type ReactNode, useId } from 'react'
import { cn } from '../lib/utils.ts'
import { Button, type ButtonProps } from './button.tsx'
import { Input } from './input.tsx'
import { Label } from './label.tsx'

/**
 * TanStack Form 的表单封装（createFormHook）：页面用 `useAppForm` 建表单，
 * 校验直接传 Zod schema（Standard Schema），例如 `validators: { onBlur: schema, onSubmit: schema }`。
 *
 * ```tsx
 * const form = useAppForm({ defaultValues, validators: { onSubmit: schema }, onSubmit })
 * <form.AppForm>
 *   <form.Form>
 *     <form.AppField name="email">{(field) => <field.TextField label="Email" type="email" />}</form.AppField>
 *     <form.SubmitButton>Sign in</form.SubmitButton>
 *   </form.Form>
 * </form.AppForm>
 * ```
 */
export const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts()

/** 校验错误转为可显示的文案：Standard Schema 的 issue 取 message，字符串原样保留，去重 */
export function errorMessages(errors: readonly unknown[]): string[] {
  const messages = errors.flatMap((error) => {
    if (typeof error === 'string') return [error]
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const { message } = error as { message: unknown }
      return typeof message === 'string' ? [message] : []
    }
    return []
  })
  return [...new Set(messages)]
}

export function FieldErrors({ id, errors }: { id: string; errors: readonly string[] }) {
  if (errors.length === 0) return null
  return (
    <div id={id} data-slot="field-error" className="text-destructive text-sm">
      {errors.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  )
}

export interface TextFieldProps
  extends Omit<ComponentProps<'input'>, 'id' | 'name' | 'value' | 'onChange' | 'onBlur'> {
  label: ReactNode
  /** 字段说明，显示在输入框下方 */
  description?: ReactNode
}

/** 文本类输入字段：标签 + 输入框 + 说明 + 错误（字段被触碰或提交过后才显示错误） */
export function TextField({ label, description, className, ...inputProps }: TextFieldProps) {
  const field = useFieldContext<string>()
  const id = useId()
  const errors = field.state.meta.isTouched ? errorMessages(field.state.meta.errors) : []
  const errorId = `${id}-error`
  const descriptionId = `${id}-description`
  const describedBy =
    [description ? descriptionId : null, errors.length > 0 ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined
  return (
    <div data-slot="field" className={cn('grid gap-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={field.name}
        value={field.state.value ?? ''}
        onChange={(event) => field.handleChange(event.target.value)}
        onBlur={field.handleBlur}
        aria-invalid={errors.length > 0 || undefined}
        aria-describedby={describedBy}
        {...inputProps}
      />
      {description ? (
        <p id={descriptionId} className="text-muted-foreground text-sm">
          {description}
        </p>
      ) : null}
      <FieldErrors id={errorId} errors={errors} />
    </div>
  )
}

/** `<form>`：阻止浏览器默认提交与原生校验，交给 TanStack Form 处理 */
export function Form({ className, ...props }: Omit<ComponentProps<'form'>, 'onSubmit'>) {
  const form = useFormContext()
  return (
    <form
      noValidate
      className={cn('grid gap-4', className)}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit()
      }}
      {...props}
    />
  )
}

export interface SubmitButtonProps extends Omit<ButtonProps, 'type' | 'asChild'> {
  /** 提交中显示的文案，省略时沿用 children */
  pendingLabel?: ReactNode
}

/** 提交按钮：提交中禁用并显示 `pendingLabel` */
export function SubmitButton({ children, pendingLabel, disabled, ...props }: SubmitButtonProps) {
  const form = useFormContext()
  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(isSubmitting) => (
        <Button
          type="submit"
          disabled={isSubmitting || disabled}
          aria-busy={isSubmitting || undefined}
          {...props}
        >
          {isSubmitting && pendingLabel !== undefined ? pendingLabel : children}
        </Button>
      )}
    </form.Subscribe>
  )
}

export const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField },
  formComponents: { Form, SubmitButton },
})
