import { ArrowRight, Clock3 } from 'lucide-react'
import { Button } from '../../components/Button'
import { OfferCard } from '../../components/OfferCard'
import { ScreenHeader } from '../../components/ScreenHeader'

interface MyOffersScreenProps {
  onBack: () => void
  onUse: () => void
}

export function MyOffersScreen({ onBack, onUse }: MyOffersScreenProps) {
  return (
    <div className="screen screen--offers">
      <ScreenHeader eyebrow="Saved to your account" title="My Offers" onBack={onBack} />
      <div className="timeline-marker"><Clock3 size={16} aria-hidden="true" /><span>Later, at Café ABC</span></div>
      <p className="screen-lede">Your claimed Vouch offer is ready when you are.</p>
      <OfferCard
        status="claimed"
        attribution="From Jia’s Vouch"
        action={<Button fullWidth onClick={onUse} icon={<ArrowRight size={19} />}>Use Offer</Button>}
      />
      <p className="account-note">Linked to Darren’s simulated NETS account · Not transferable</p>
    </div>
  )
}
