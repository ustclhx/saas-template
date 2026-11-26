// 来源：fluid-functionalism radix/radio-group（2026-11，https://www.fluidfunctionalism.com/r/radio-group.json，MIT）
// 适配：radix-ui 统一包导入、包内相对路径、去掉 "use client"；其余改动见 packages/ui/UPSTREAM.md
import { AnimatePresence, m as motion, type Transition, useReducedMotion } from 'motion/react'
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui'
import {
  Children,
  createContext,
  forwardRef,
  type HTMLAttributes,
  isValidElement,
  type MutableRefObject,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from 'react'
import { useFluidHover, useRegisterFluidHoverItem } from '../hooks/use-fluid-hover.ts'
import { fontWeights } from '../lib/font-weight.ts'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { useShape } from '../lib/shape-context.tsx'
import { SizeProvider, type SizeVariant, useSize } from '../lib/size-context.tsx'
import { spring } from '../lib/springs.ts'
import { cn } from '../lib/utils.ts'
import { FluidHoverHighlight } from './fluid-hover-highlight.tsx'

// ---------------------------------------------------------------------------
// RadioGroup is a vertical list of RadioItem rows sharing one fluid hover
// scope. The group paints everything that spans rows: one selected background
// that springs from the old row to the new one, the hover highlight, and one
// focus ring that springs between rows. Each row is the focusable
// role="radio" element. Selection takes one of three APIs: `value` +
// `onValueChange` on the group, `selectedIndex` on the group, or `selected` +
// `onSelect` per item.
// ---------------------------------------------------------------------------

// 模板改动：减少动态效果时选中底色与焦点环直接落到目标行，只保留透明度过渡。
// 它们驱动的是 top / height 等布局属性而不是 transform，UiRoot 的 MotionConfig 不会去掉，
// 所以组件自己读取系统设置（同 Tabs、FluidHoverHighlight）。
const SNAP = { duration: 0 } as const

/** 位置用给定弹簧（减少动态效果时瞬移），透明度保持给定的淡入淡出 */
function positional(base: Transition, reduceMotion: boolean, opacity: Transition): Transition {
  return { ...(reduceMotion ? SNAP : base), opacity }
}

function assignRef<T>(
  ref: ((node: T | null) => void) | MutableRefObject<T | null> | null,
  node: T | null,
) {
  if (typeof ref === 'function') ref(node)
  else if (ref) ref.current = node
}

// True only while a row's mousedown handler moves focus onto the row. Chrome
// reports a focus() call from script as :focus-visible, so without this flag
// every click would draw the keyboard focus ring. focus() fires its focus
// events synchronously, so the flag never outlives that one call.
let pointerFocusRedirect = false

interface RadioGroupContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void
  activeIndex: number | null
  selectedIndex: number | null
  selectedValue: string | undefined
  onValueChange: ((value: string) => void) | undefined
  /** Whether any item in the group is currently selected. Drives the roving
   *  tabindex fallback: with no selection, the first item must stay tabbable
   *  or the whole group becomes unreachable by keyboard. */
  hasSelection: boolean
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null)

function useRadioGroupContext() {
  const ctx = useContext(RadioGroupContext)
  if (!ctx) throw new Error('useRadioGroup must be used within a RadioGroup')
  return ctx
}

interface RadioGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  children: ReactNode
  selectedIndex?: number
  value?: string
  onValueChange?: (value: string) => void
  /** 模板新增：表单字段名（仅 `value` 模式）。在 `<form>` 内时 Radix 为选中项生成隐藏 radio，随表单提交 `value` */
  name?: string
  /** Pins the group's rows to one step of the size ladder (default 36px,
   *  compact 28px). Omitted, it follows the surrounding
   *  SizeProvider. */
  size?: SizeVariant
  // 可读名称：用 `aria-labelledby` 指向可见的标题（如「原因」），或用 `aria-label`；组件不提供默认文案
}

const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(
  ({ children, selectedIndex, value, onValueChange, name, size, className, ...props }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null)
    // Each child's `value`, in order, so a `value`-controlled group can find
    // the row index its selected background sits on.
    const childProps = Children.toArray(children)
      .filter(isValidElement)
      .map((child) => child.props as { value?: string; selected?: boolean })
    const hover = useFluidHover(containerRef)
    const { activeIndex, setActiveIndex, itemRects, handlers, registerItem } = hover
    const reduceMotion = useReducedMotion() ?? false

    const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
    // -1 when nothing matches, which hides the selected background.
    const resolvedSelectedIndex =
      value !== undefined
        ? childProps.findIndex((child) => child.value === value)
        : (selectedIndex ?? -1)
    // Covers all three selection APIs: value, selectedIndex, per-item selected.
    const hasSelection =
      resolvedSelectedIndex >= 0 || childProps.some((child) => child.selected === true)

    const focusRect = focusedIndex !== null ? itemRects[focusedIndex] : null
    const selectedRect = resolvedSelectedIndex >= 0 ? itemRects[resolvedSelectedIndex] : null
    const shape = useShape()

    const content = (
      <div
        ref={(node) => {
          containerRef.current = node
          assignRef(ref, node)
        }}
        onMouseEnter={handlers.onMouseEnter}
        onMouseMove={handlers.onMouseMove}
        onMouseLeave={handlers.onMouseLeave}
        onClick={handlers.onClick}
        // Focus drives the same activeIndex as hover, so the highlight, the
        // border and the label color follow the keyboard too. The focus ring
        // shows for keyboard focus only, never after a click.
        onFocus={(e) => {
          const indexAttr = (e.target as HTMLElement)
            .closest('[data-fluid-hover-index]')
            ?.getAttribute('data-fluid-hover-index')
          if (indexAttr != null) {
            const idx = Number(indexAttr)
            setActiveIndex(idx)
            // A row focused by its own mousedown gets no ring, even though
            // the browser reports that focus as :focus-visible.
            setFocusedIndex(
              !pointerFocusRedirect && (e.target as HTMLElement).matches(':focus-visible')
                ? idx
                : null,
            )
          }
        }}
        onBlur={(e) => {
          // Don't clear hover when focus moves to another item within the group
          if (containerRef.current?.contains(e.relatedTarget as Node)) return
          setFocusedIndex(null)
          setActiveIndex(null)
        }}
        onKeyDown={(e) => {
          // Scope to row wrappers only. The hidden radio primitive also
          // carries role="radio", so a bare [role="radio"] selector matches
          // twice per row and arrows land on the invisible control.
          const items = Array.from(
            containerRef.current?.querySelectorAll<HTMLElement>('[data-fluid-hover-index]') ?? [],
          )
          const currentIdx = items.indexOf(e.target as HTMLElement)
          if (currentIdx === -1) return

          // All four arrows move focus AND select, as native radios do, wrapping
          // at both ends; Home/End jump to the first or last row and select it.
          // Selecting goes through the row's click, so it runs the same handler
          // as a pointer press.
          let next: HTMLElement | undefined
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
            next = items[(currentIdx + 1) % items.length]
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            next = items[(currentIdx - 1 + items.length) % items.length]
          } else if (e.key === 'Home') {
            next = items[0]
          } else if (e.key === 'End') {
            next = items[items.length - 1]
          }
          if (!next) return
          e.preventDefault()
          next.focus()
          next.click()
        }}
        role="radiogroup"
        // 模板改动：Radix Root 经 asChild 合并到本元素时会带上 RovingFocusGroup 的 tabIndex=0，
        // 使整组多出一个 Tab 停靠点；焦点只落在行上（行自管 roving tabindex），容器固定为 -1
        tabIndex={-1}
        // select-none keeps rapid clicks on rows from selecting the label text.
        className={cn(
          'relative flex flex-col gap-0.5 w-72 max-w-full select-none outline-none',
          className,
        )}
        {...props}
      >
        {/* Selected background */}
        {/* One shared background springs (spring.moderate) from the old row to
            the new one instead of each row fading its own in and out.
            initial={false} places it without animating on first render. */}
        {selectedRect && (
          <motion.div
            data-slot="radio-group-indicator"
            className={cn('absolute bg-active pointer-events-none', shape.bg)}
            initial={false}
            animate={{
              top: selectedRect.top,
              left: selectedRect.left,
              width: selectedRect.width,
              height: selectedRect.height,
              opacity: 1,
            }}
            transition={positional(spring.moderate, reduceMotion, { duration: 0.08 })}
          />
        )}

        {/* Hover background */}
        <FluidHoverHighlight hover={hover} className={shape.bg} />

        {/* Focus ring */}
        <AnimatePresence>
          {focusRect && (
            <motion.div
              data-slot="radio-group-focus-ring"
              // 模板改动：上游为外扩 2px 的 1px 边框（带颜色字面量回退）；这里与 Tabs 一致，盒子贴合行、
              // 用 2px 描边 + 2px 间隙，描边沿用行自身的圆角向外扩，颜色只取 --focus-ring
              className={cn(
                'absolute pointer-events-none z-20 outline-solid outline-2 outline-offset-2 outline-(--focus-ring)',
                shape.bg,
              )}
              initial={false}
              animate={{
                left: focusRect.left,
                top: focusRect.top,
                width: focusRect.width,
                height: focusRect.height,
              }}
              exit={{ opacity: 0, transition: spring.fast.exit }}
              transition={positional(spring.fast, reduceMotion, { duration: 0.08 })}
            />
          )}
        </AnimatePresence>

        {children}
      </div>
    )

    // If `value` is provided (controlled-by-value mode), always wrap with the
    // Radix RadioGroup primitive — even when `onValueChange` is absent. The
    // inner `<RadioGroupPrimitive.Item>` rendered by each RadioItem requires a
    // parent RadioGroup context; without it, Radix throws on context reads.
    // The wrapper just doesn't forward changes when the consumer doesn't ask
    // to be notified.
    // A size prop pins every row in the group to one ladder step.
    const withSize = (node: ReactNode) =>
      size ? <SizeProvider size={size}>{node}</SizeProvider> : node

    if (value !== undefined) {
      return withSize(
        <MotionFeatures>
          <RadioGroupContext.Provider
            value={{
              registerItem,
              activeIndex,
              selectedIndex: resolvedSelectedIndex >= 0 ? resolvedSelectedIndex : null,
              selectedValue: value,
              onValueChange,
              hasSelection,
            }}
          >
            {/* asChild merges the primitive's props and handlers onto the
              container itself, so no wrapper div sits between the group and
              its rows. */}
            <RadioGroupPrimitive.Root
              value={value}
              onValueChange={(v) => onValueChange?.(v)}
              {...(name !== undefined && { name })}
              asChild
            >
              {content}
            </RadioGroupPrimitive.Root>
          </RadioGroupContext.Provider>
        </MotionFeatures>,
      )
    }

    return withSize(
      <MotionFeatures>
        <RadioGroupContext.Provider
          value={{
            registerItem,
            activeIndex,
            selectedIndex: selectedIndex ?? null,
            selectedValue: undefined,
            onValueChange: undefined,
            hasSelection,
          }}
        >
          {content}
        </RadioGroupContext.Provider>
      </MotionFeatures>,
    )
  },
)

RadioGroup.displayName = 'RadioGroup'

interface RadioItemProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  /** 选项文字，由应用按语言传入，同时作为该行的可读名称 */
  label: string
  index: number
  selected?: boolean
  onSelect?: () => void
  value?: string
}

const RadioItem = forwardRef<HTMLDivElement, RadioItemProps>(
  ({ label, index, selected, onSelect, value, className, ...props }, ref) => {
    const internalRef = useRef<HTMLDivElement | null>(null)
    const { registerItem, activeIndex, selectedIndex, selectedValue, onValueChange, hasSelection } =
      useRadioGroupContext()

    useRegisterFluidHoverItem(registerItem, index, internalRef)

    const isActive = activeIndex === index
    const shape = useShape()
    const sizeClasses = useSize()
    const compact = sizeClasses.variant === 'compact'
    // Value equality decides when both the item and the group have a value;
    // otherwise the item's own `selected` wins over the group's selectedIndex.
    const isSelected =
      value !== undefined && selectedValue !== undefined
        ? selectedValue === value
        : (selected ?? selectedIndex === index)

    // Value mode reports through the group's onValueChange, index and per-item
    // modes through onSelect; both fire when both are wired.
    const handleSelect = () => {
      if (value !== undefined) {
        onValueChange?.(value)
      }
      onSelect?.()
    }

    return (
      // biome-ignore lint/a11y/useSemanticElements: 上游以 div 承载 radio 行，隐藏的 Radix Item 负责表单值
      <div
        ref={(node) => {
          internalRef.current = node
          assignRef(ref, node)
        }}
        data-fluid-hover-index={index}
        // Roving tabindex: selected item is the tab stop; with no selection the
        // first item takes it so the group stays keyboard-reachable.
        tabIndex={isSelected ? 0 : !hasSelection && index === 0 ? 0 : -1}
        // The row, not the primitive, carries the role, state and name: it is
        // the element that takes focus.
        role="radio"
        aria-checked={isSelected}
        aria-label={label}
        onClick={handleSelect}
        onMouseDown={(e) => {
          // Pin focus to the row wrapper on press: the group keydown handler
          // only finds targets among the row wrappers, so focus anywhere else
          // dead-zones arrow-key nav. Prevent the native focus move (click
          // still fires) and land focus on the row instead. Skip genuinely
          // interactive children so we don't hijack their focus.
          const interactive = (e.target as HTMLElement).closest(
            'button:not([tabindex="-1"]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          )
          if (interactive && interactive !== e.currentTarget) return
          e.preventDefault()
          pointerFocusRedirect = true
          try {
            e.currentTarget.focus()
          } finally {
            pointerFocusRedirect = false
          }
        }}
        // The row is a div, so it handles Space and Enter itself;
        // preventDefault keeps Space from scrolling the page.
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            handleSelect()
          }
        }}
        className={cn(
          // A floor, not a fixed height: one line sits on the ladder's control
          // height (the padding alone stays under it, so the text-box trim on
          // the label can't shrink the row), and a long label wraps and grows
          // the row instead of spilling into the next one.
          // 模板改动：默认尺寸在触屏（粗指针）上把行高下限提到 44px，满足触控目标尺寸
          'relative z-10 flex items-center cursor-pointer outline-none',
          compact ? 'min-h-7 py-2' : 'min-h-9 py-3 pointer-coarse:min-h-11',
          sizeClasses.gap,
          shape.item,
          sizeClasses.px,
          className,
        )}
        {...props}
      >
        {/* Radio circle */}
        <div className={cn('relative shrink-0', compact ? 'size-3.5' : 'size-4')}>
          {/* Border */}
          {/* Selected: the border turns transparent and the dot alone marks
              the state. */}
          {/* 模板改动：未选中时静止边框用 --control-border（上游 --border 与背景约 1.4:1，
              圆圈是唯一的状态标识，需 ≥ 3:1）；悬停或聚焦加深到正文色（同 Checkbox） */}
          <div
            className={cn(
              'absolute inset-0 rounded-full border-[1.5px] border-solid transition-[border-color] duration-80',
              isSelected
                ? 'border-transparent'
                : isActive
                  ? 'border-foreground'
                  : 'border-control-border',
            )}
          />
          {/* Dot */}
          {/* Pops in on spring.fast from scale 0.3 and opacity 0, and shrinks
              back out over 0.04s. */}
          {/* initial={false}: a row selected at mount shows the dot at
              full size instead of popping it in, so default selections
              don't animate on page load. */}
          <AnimatePresence initial={false}>
            {isSelected && (
              <motion.div
                data-slot="radio-group-dot"
                className="absolute inset-0 flex items-center justify-center"
                initial={{ opacity: 0, scale: 0.3 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.3, transition: { duration: 0.04 } }}
                transition={spring.fast}
              >
                <div
                  className={cn('rounded-full bg-foreground', compact ? 'size-[7px]' : 'size-2')}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Label */}
        {/* Both stacked spans carry the text-box trim so the invisible bold
            sizer and the visible label keep identical boxes. */}
        <span className={cn('inline-grid min-w-0 [overflow-wrap:anywhere]', sizeClasses.text)}>
          {/* Always semibold, so the grid cell is sized for the heaviest
              weight and the row never shifts when the label gains weight. */}
          <span
            className="col-start-1 row-start-1 invisible [text-box:trim-both_cap_alphabetic]"
            style={{ fontVariationSettings: fontWeights.semibold }}
            aria-hidden="true"
          >
            {label}
          </span>
          {/* Weight changes only when selected ('wght' 400 → 550), so weight
              marks state; color goes muted → foreground when selected, hovered
              or focused. Both transition over 80ms. */}
          <span
            className={cn(
              'col-start-1 row-start-1 transition-[color,font-variation-settings] duration-80 [text-box:trim-both_cap_alphabetic]',
              isSelected || isActive ? 'text-foreground' : 'text-muted-foreground',
            )}
            style={{
              fontVariationSettings: isSelected ? fontWeights.semibold : fontWeights.normal,
            }}
          >
            {label}
          </span>
        </span>

        {/* Hidden Radix radio input for accessibility */}
        {/* Value mode only. Out of the tab order and hidden from assistive
            tech: the row already is the radio, so exposing the primitive too
            would announce every option twice. */}
        {value !== undefined && (
          <RadioGroupPrimitive.Item value={value} className="sr-only" tabIndex={-1} aria-hidden />
        )}
      </div>
    )
  },
)

RadioItem.displayName = 'RadioItem'

export type { RadioGroupProps, RadioItemProps }
export { RadioGroup, RadioItem }
