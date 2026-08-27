import { ArrowRight, Clock3 } from 'lucide-react'
import { Button } from '../../components/Button'
import { OfferCard } from '../../components/OfferCard'
import { ScreenHeader } from '../../components/ScreenHeader'
import type { OfferStatus } from '../../app/types'

interface MyOffersScreenProps {
  offerStatus: OfferStatus
  onBack: () => void
  onUse: () => void
}

export function MyOffersScreen({ offerStatus, onBack, onUse }: MyOffersScreenProps) {
  return (
    <div className="screen screen--offers">
      <ScreenHeader eyebrow="Merchant offers received" title="Saved Offers" onBack={onBack} />
      {offerStatus === 'available' ? (
        <div className="empty-offers">
          <Clock3 size={24} aria-hidden="true" />
          <h2>No saved offers yet</h2>
          <p>Darren can claim Café ABC’s optional offer during the recipient demo.</p>
        </div>
      ) : (
        <>
          <div className="timeline-marker"><Clock3 size={16} aria-hidden="true" /><span>{offerStatus === 'claimed' ? 'Later, at Café ABC' : 'Used at Café ABC'}</span></div>
          <p className="screen-lede">{offerStatus === 'claimed' ? 'Your claimed Vouch offer is ready when you are.' : 'This one-time Vouch offer has been redeemed.'}</p>
          <OfferCard
            status={offerStatus}
            attribution="From Jia’s Vouch"
            action={offerStatus === 'claimed' ? <Button fullWidth onClick={onUse} icon={<ArrowRight size={19} />}>Use Offer</Button> : undefined}
          />
          <p className="account-note">Linked to Darren’s simulated NETS account · Not transferable</p>
        </>
      )}
    </div>
  )
}
