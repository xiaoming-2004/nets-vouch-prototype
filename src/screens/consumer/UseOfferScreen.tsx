import { ArrowRight, CheckCircle2, Clock3, CreditCard, ShieldCheck } from 'lucide-react'
import { Button } from '../../components/Button'
import { ScreenHeader } from '../../components/ScreenHeader'
import { merchant, offer } from '../../data/mockData'

interface UseOfferScreenProps {
  onBack: () => void
  onPay: () => void
}

export function UseOfferScreen({ onBack, onPay }: UseOfferScreenProps) {
  return (
    <div className="screen screen--use-offer">
      <ScreenHeader eyebrow="Later, at the café" title="Use Offer" onBack={onBack} />
      <article className="ready-offer">
        <div className="ready-offer__top">
          <span className="ready-status"><CheckCircle2 size={15} aria-hidden="true" />Ready to use</span>
          <span className="merchant-monogram" aria-hidden="true">C</span>
        </div>
        <p className="eyebrow">{merchant.name}</p>
        <h2>{offer.title}</h2>
        <div className="ready-offer__rules">
          <span><CreditCard size={18} aria-hidden="true" /><strong>Eligible NETS payment required</strong></span>
          <span><ShieldCheck size={18} aria-hidden="true" /><strong>One-time use</strong></span>
          <span><Clock3 size={18} aria-hidden="true" /><strong>{offer.validity}</strong></span>
        </div>
      </article>
      <div className="account-link-note">
        <ShieldCheck size={18} aria-hidden="true" />
        <span>This offer is already linked to Darren’s account. No code is needed.</span>
      </div>
      <div className="screen-actions screen-actions--bottom">
        <Button fullWidth onClick={onPay} icon={<ArrowRight size={19} />}>Pay with NETS</Button>
      </div>
    </div>
  )
}
