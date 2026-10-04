import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { errorMessages, useAppForm } from '../src/index.ts'

afterEach(cleanup)

const schema = z.object({
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
})

function SignInForm({ onSubmit }: { onSubmit: (value: z.infer<typeof schema>) => Promise<void> }) {
  const form = useAppForm({
    defaultValues: { email: '', password: '' },
    validators: { onBlur: schema, onSubmit: schema },
    onSubmit: ({ value }) => onSubmit(value),
  })
  return (
    <form.AppForm>
      <form.Form aria-label="sign in">
        <form.AppField name="email">
          {(field) => <field.TextField label="Email" type="email" />}
        </form.AppField>
        <form.AppField name="password">
          {(field) => <field.TextField label="Password" type="password" />}
        </form.AppField>
        <form.SubmitButton pendingLabel="Signing in…">Sign in</form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}

describe('表单封装（TanStack Form + Zod）', () => {
  it('提交非法值时按字段显示 Zod 错误，且不调用 onSubmit', async () => {
    const onSubmit = vi.fn(async () => {})
    render(<SignInForm onSubmit={onSubmit} />)
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'sign in' }))
    })
    expect(await screen.findByText('Enter a valid email')).toBeTruthy()
    expect(screen.getByText('At least 8 characters')).toBeTruthy()
    const email = screen.getByLabelText('Email')
    expect(email.getAttribute('aria-invalid')).toBe('true')
    // 错误通过 aria-describedby 与输入框关联
    const describedBy = email.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(describedBy)?.textContent).toBe('Enter a valid email')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('合法值提交时调用 onSubmit，提交中按钮禁用并显示 pendingLabel', async () => {
    let resolve: () => void = () => {}
    const onSubmit = vi.fn(() => new Promise<void>((r) => (resolve = r)))
    render(<SignInForm onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } })
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'sign in' }))
    })
    expect(onSubmit).toHaveBeenCalledWith({ email: 'a@example.com', password: 'password123' })
    const button = screen.getByRole('button')
    expect(button.textContent).toBe('Signing in…')
    expect((button as HTMLButtonElement).disabled).toBe(true)
    await act(async () => resolve())
    expect(button.textContent).toBe('Sign in')
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })

  it('失焦时校验已触碰的字段，未触碰的字段不显示错误', async () => {
    render(<SignInForm onSubmit={async () => {}} />)
    const email = screen.getByLabelText('Email')
    fireEvent.change(email, { target: { value: 'not-an-email' } })
    await act(async () => {
      fireEvent.blur(email)
    })
    expect(await screen.findByText('Enter a valid email')).toBeTruthy()
    expect(screen.queryByText('At least 8 characters')).toBeNull()
  })

  it('errorMessages 取 issue 的 message 并去重', () => {
    expect(errorMessages(['a', { message: 'b' }, { message: 'a' }, null, { message: 1 }])).toEqual([
      'a',
      'b',
    ])
  })
})
