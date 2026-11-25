// 模板新增（openspec add-admin-step-up，2026-11）：Fluid 没有一次性验证码输入，结构参照 shadcn `input-otp`
// （一个真实 <input> 覆盖在若干展示格上），不引入 `input-otp` 依赖。见 packages/ui/UPSTREAM.md。
import {
  type ChangeEvent,
  type ComponentProps,
  type FocusEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import { cn } from '../lib/utils.ts'

export type InputOTPProps = Omit<
  ComponentProps<'input'>,
  'value' | 'onChange' | 'maxLength' | 'type' | 'size' | 'children'
> & {
  /** 位数，默认 6 */
  length?: number
  value: string
  onChange: (value: string) => void
  /** 填满全部位数时调用 */
  onComplete?: (value: string) => void
  /** 只接受数字（默认）；关闭后接受字母与数字 */
  numeric?: boolean
  /** 外层容器的 className（输入框本身透明覆盖在格子上） */
  containerClassName?: string
}

/**
 * 分格显示的验证码输入。只有一个真实的输入框（一个可读名称、一次读屏播报），
 * 支持粘贴、系统短信 / 邮件验证码自动填充（autocomplete="one-time-code"）与退格；
 * 格子只做展示，当前输入位置在获得焦点时高亮。可读名称经 aria-label / aria-labelledby 传入。
 */
export function InputOTP({
  length = 6,
  value,
  onChange,
  onComplete,
  numeric = true,
  containerClassName,
  className,
  disabled,
  onFocus,
  onBlur,
  style,
  ...props
}: InputOTPProps) {
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const pattern = numeric ? /\D/g : /[^\da-z]/gi
  const completeRef = useRef(onComplete)
  completeRef.current = onComplete

  // 粘贴或自动填充可能带空格与分隔符：只保留有效字符并截断到位数
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value.replace(pattern, '').slice(0, length)
    onChange(next)
  }

  useEffect(() => {
    if (value.length === length) completeRef.current?.(value)
  }, [value, length])

  // 光标始终在末尾：格子只表达「已填到第几位」
  function keepCaretAtEnd() {
    const input = inputRef.current
    if (input) input.setSelectionRange(input.value.length, input.value.length)
  }

  const invalid = props['aria-invalid'] === true || props['aria-invalid'] === 'true'
  const active = Math.min(value.length, length - 1)

  return (
    <div
      data-slot="input-otp"
      className={cn(
        'relative flex w-fit items-center gap-2',
        disabled && 'opacity-50',
        containerClassName,
      )}
    >
      {Array.from({ length }, (_, index) => {
        const char = value[index] ?? ''
        // 当前输入位置兼作焦点指示（输入框本身透明）
        const current = focused && index === active
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 固定位数的展示格，位置即身份
            key={index}
            aria-hidden="true"
            data-slot="input-otp-slot"
            data-active={current || undefined}
            className={cn(
              'flex h-12 w-11 items-center justify-center rounded-lg bg-(--chat-fill) font-semibold text-foreground text-xl tabular-nums',
              'transition-shadow duration-80',
              current && 'ring-2 ring-foreground',
              invalid && 'ring-2 ring-destructive',
            )}
          >
            {char}
          </div>
        )
      })}
      <input
        ref={inputRef}
        data-slot="input-otp-input"
        type="text"
        inputMode={numeric ? 'numeric' : 'text'}
        autoComplete="one-time-code"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        pattern={numeric ? '[0-9]*' : undefined}
        maxLength={length}
        value={value}
        disabled={disabled}
        onChange={handleChange}
        onSelect={keepCaretAtEnd}
        onFocus={(event: FocusEvent<HTMLInputElement>) => {
          setFocused(true)
          keepCaretAtEnd()
          onFocus?.(event)
        }}
        onBlur={(event: FocusEvent<HTMLInputElement>) => {
          setFocused(false)
          onBlur?.(event)
        }}
        // 透明覆盖在格子上：点击任意一格都聚焦同一个输入框；文字与光标透明，焦点由当前格的描边表示
        className={cn(
          'absolute inset-0 h-full w-full bg-transparent text-transparent caret-transparent outline-none',
          'selection:bg-transparent disabled:cursor-not-allowed',
          className,
        )}
        style={style}
        {...props}
      />
    </div>
  )
}
