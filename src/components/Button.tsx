import type { ButtonHTMLAttributes, ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'success'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  fullWidth?: boolean
  icon?: ReactNode
}

export function Button({
  variant = 'primary',
  fullWidth = false,
  icon,
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`button button--${variant} ${fullWidth ? 'button--full' : ''} ${className}`.trim()}
      {...props}
    >
      {icon ? <span className="button__icon" aria-hidden="true">{icon}</span> : null}
      <span>{children}</span>
    </button>
  )
}
