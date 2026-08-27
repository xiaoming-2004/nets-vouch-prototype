import type { ReactNode } from 'react'
import { CalendarDays, LockKeyhole, Store } from 'lucide-react'
import type { OfferStatus } from '../app/types'
import { merchant, offer } from '../data/mockData'

interface OfferCardProps {
  status: OfferStatus
  attribution?: string
  action?: ReactNode
  compact?: boolean
}

const statusLabels: Record<OfferStatus, string> = {
  available: 'Available to claim',
  claimed: 'Claimed',
  redeemed: 'Redeemed',
}

export function OfferCard({ status, attribution, action, compact = false }: OfferCardProps) {
  return (
    <article className={`offer-card offer-card--${status} ${compact ? 'offer-card--compact' : ''}`}>
      <div className="offer-card__topline">
        <span className="offer-status">{statusLabels[status]}</span>
        <span className="offer-card__merchant"><Store size={14} aria-hidden="true" /> {merchant.name}</span>
      </div>
      <h2>{offer.title}</h2>
      {attribution ? <p className="offer-card__attribution">{attribution}</p> : null}
      <div className="offer-card__terms">
        <span><CalendarDays size={15} aria-hidden="true" />{offer.validity}</span>
        <span><LockKeyhole size={15} aria-hidden="true" />Account-linked · One-time use</span>
      </div>
      {action ? <div className="offer-card__action">{action}</div> : null}
    </article>
  )
}
