import { Check } from 'lucide-react'

interface SuccessStateProps {
  eyebrow?: string
  title: string
  merchant: string
  amount?: string
}

export function SuccessState({ eyebrow, title, merchant, amount }: SuccessStateProps) {
  return (
    <div className="success-state">
      {eyebrow ? <p className="eyebrow success-state__eyebrow">{eyebrow}</p> : null}
      <div className="success-mark" aria-hidden="true"><Check size={36} strokeWidth={3} /></div>
      <h1 data-screen-heading tabIndex={-1}>{title}</h1>
      <p className="success-state__merchant">{merchant}</p>
      {amount ? <p className="success-state__amount">{amount}</p> : null}
    </div>
  )
}
