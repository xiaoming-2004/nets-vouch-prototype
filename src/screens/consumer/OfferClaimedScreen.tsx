import { ArrowRight, BookmarkCheck, Check, Store } from 'lucide-react'
import { Button } from '../../components/Button'
import { OfferCard } from '../../components/OfferCard'
import { ScreenHeader } from '../../components/ScreenHeader'
import { merchant, offer } from '../../data/mockData'

interface OfferClaimedScreenProps {
  onBack: () => void
  onViewSaved: () => void
  onDone: () => void
}

export function OfferClaimedScreen({ onBack, onViewSaved, onDone }: OfferClaimedScreenProps) {
  return (
    <div className="screen screen--offer-claimed">
      <ScreenHeader title="Offer saved" onBack={onBack} />
      <div className="saved-success">
        <div className="saved-success__mark"><Check size={30} strokeWidth={3} aria-hidden="true" /></div>
        <p className="eyebrow">Ready for later</p>
        <h2>{offer.title}</h2>
        <p><Store size={15} aria-hidden="true" /> {merchant.name}</p>
      </div>
      <OfferCard status="claimed" compact />
      <div className="instruction-card">
        <BookmarkCheck size={21} aria-hidden="true" />
        <div>
          <strong>Use it on your next visit</strong>
          <p>Visit {merchant.name}, open your saved offer, and pay with NETS.</p>
        </div>
      </div>
      <div className="screen-actions screen-actions--bottom">
        <Button fullWidth onClick={onViewSaved} icon={<ArrowRight size={19} />}>View Saved Offer</Button>
        <Button variant="ghost" fullWidth onClick={onDone}>Done</Button>
      </div>
    </div>
  )
}
