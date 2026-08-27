import { CalendarDays } from 'lucide-react'
import type { VouchRecord } from '../app/types'
import { vouchTags } from '../data/mockData'
import { VerifiedVisitBadge } from './VerifiedVisitBadge'

export function VouchHistoryList({ vouches }: { vouches: VouchRecord[] }) {
  return (
    <div className="vouch-history-list">
      {vouches.map((vouch) => {
        const tag = vouchTags.find((item) => item.id === vouch.tag)?.label ?? 'Vouch Pick'
        return (
          <article className="vouch-history-card" key={vouch.id}>
            <div className="vouch-history-card__mark" aria-hidden="true">{vouch.merchantName.charAt(0)}</div>
            <div className="vouch-history-card__copy">
              <div className="vouch-history-card__topline">
                <h3>{vouch.merchantName}</h3>
                <span className={`history-status history-status--${vouch.status.toLowerCase()}`}>{vouch.status}</span>
              </div>
              <div className="badge-row">
                <span className="vouch-tag-chip">{tag}</span>
                <VerifiedVisitBadge />
              </div>
              <p><CalendarDays size={13} aria-hidden="true" />{vouch.date}</p>
            </div>
          </article>
        )
      })}
    </div>
  )
}
