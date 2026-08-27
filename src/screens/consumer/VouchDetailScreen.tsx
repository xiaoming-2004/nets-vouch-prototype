import { ArrowRight, Gift, HeartHandshake, Info, Store } from 'lucide-react'
import type { Author, OfferStatus, VouchTagId } from '../../app/types'
import { Button } from '../../components/Button'
import { ScreenHeader } from '../../components/ScreenHeader'
import { VerifiedVisitBadge } from '../../components/VerifiedVisitBadge'
import { merchant, offer, vouchTags } from '../../data/mockData'

interface VouchDetailScreenProps {
  author: Author
  selectedTag: VouchTagId
  offerStatus: OfferStatus
  onBack: () => void
  onClaim: () => void
  onViewSaved: () => void
}

export function VouchDetailScreen({ author, selectedTag, offerStatus, onBack, onClaim, onViewSaved }: VouchDetailScreenProps) {
  const selectedLabel = vouchTags.find((tag) => tag.id === selectedTag)?.label ?? 'Vouch Pick'

  return (
    <div className="screen screen--vouch-detail">
      <ScreenHeader eyebrow="Shared with Darren" title="A Vouch from a friend" onBack={onBack} />

      <article className="recommendation-card">
        <div className="merchant-cover">
          <span className="merchant-cover__mark" aria-hidden="true">C</span>
          <span className="merchant-cover__type"><Store size={15} aria-hidden="true" /> Café · Orchard</span>
        </div>
        <div className="recommendation-card__body">
          <p className="eyebrow">Trusted recommendation</p>
          <h2>{merchant.name}</h2>
          <div className="friend-vouch-line">
            <span className="friend-avatar" aria-hidden="true">{author.charAt(0)}</span>
            <span><strong>{author}</strong> Vouched for this place</span>
          </div>
          <div className="badge-row">
            <span className="vouch-tag-chip"><HeartHandshake size={14} aria-hidden="true" />{selectedLabel}</span>
            <VerifiedVisitBadge />
          </div>
        </div>
      </article>

      <div className="separation-label"><span />Optional merchant offer<span /></div>

      <section className="optional-offer" aria-labelledby="optional-offer-title">
        <div className="optional-offer__icon"><Gift size={24} aria-hidden="true" /></div>
        <p className="eyebrow">Optional NETS Vouch Offer</p>
        <h2 id="optional-offer-title">{offer.title}</h2>
        <p className="offer-eligibility">{offer.eligibility}</p>
        <div className="offer-funder"><Store size={15} aria-hidden="true" />{offer.funder}</div>
        <ul className="offer-meta">
          <li>{offer.limit}</li>
          <li>{offer.validity}</li>
          <li>Account-linked · no promo code</li>
        </ul>
        {offerStatus === 'available' ? (
          <Button fullWidth onClick={onClaim} icon={<ArrowRight size={19} />}>Claim Offer</Button>
        ) : offerStatus === 'claimed' ? (
          <Button fullWidth variant="success" onClick={onViewSaved}>View Saved Offer</Button>
        ) : (
          <Button fullWidth disabled>Offer Redeemed</Button>
        )}
        <div className="offer-separation-note"><Info size={15} aria-hidden="true" />The offer is funded by Café ABC. {author} receives no reward.</div>
      </section>
    </div>
  )
}
