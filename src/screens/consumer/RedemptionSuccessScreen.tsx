import { ArrowRight, Gift, RefreshCw } from 'lucide-react'
import { Button } from '../../components/Button'
import { SuccessState } from '../../components/SuccessState'
import { merchant, offer } from '../../data/mockData'

interface RedemptionSuccessScreenProps {
  onVouch: () => void
  onDone: () => void
}

export function RedemptionSuccessScreen({ onVouch, onDone }: RedemptionSuccessScreenProps) {
  return (
    <div className="screen screen--redemption-success">
      <SuccessState title="Payment Successful" merchant={merchant.name} />
      <section className="redeemed-card">
        <span className="redeemed-card__icon"><Gift size={20} aria-hidden="true" /></span>
        <div>
          <p className="eyebrow">Vouch Offer Redeemed</p>
          <h2>{offer.title}</h2>
          <p>Used once · This offer is now complete</p>
        </div>
      </section>
      <section className="next-payment-card">
        <span className="loop-symbol" aria-hidden="true"><RefreshCw size={22} /></span>
        <p className="eyebrow">One payment creates the next</p>
        <h2>Worth sharing?</h2>
        <p>Darren’s completed NETS payment can now become the next trusted Vouch.</p>
        <Button fullWidth onClick={onVouch} icon={<ArrowRight size={19} />}>Vouch Café ABC</Button>
      </section>
      <Button variant="ghost" fullWidth onClick={onDone}>Done</Button>
    </div>
  )
}
