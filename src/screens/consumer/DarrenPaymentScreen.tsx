import { Check, CreditCard, Gift, LockKeyhole } from 'lucide-react'
import { Button } from '../../components/Button'
import { ScreenHeader } from '../../components/ScreenHeader'
import { merchant, offer, payments } from '../../data/mockData'

interface DarrenPaymentScreenProps {
  isPaying: boolean
  onBack: () => void
  onPay: () => void
}

export function DarrenPaymentScreen({ isPaying, onBack, onPay }: DarrenPaymentScreenProps) {
  return (
    <div className="screen screen--payment">
      <ScreenHeader eyebrow="Simulated NETS payment" title={`Pay ${merchant.name}`} onBack={isPaying ? undefined : onBack} />
      <div className="payment-summary">
        <p className="eyebrow">Amount due</p>
        <p className="payment-summary__amount">{payments.darren.displayAmount}</p>
        <div className="merchant-payment-line"><span className="merchant-monogram" aria-hidden="true">C</span><span>{merchant.name}<small>Orchard Demo Outlet</small></span></div>
      </div>
      <section className="applied-offer" aria-labelledby="applied-offer-title">
        <div className="applied-offer__heading">
          <span><Gift size={19} aria-hidden="true" /> Vouch Offer Applied</span>
          <Check size={18} aria-hidden="true" />
        </div>
        <h2 id="applied-offer-title">{offer.title}</h2>
        <p>Included with this eligible NETS payment</p>
      </section>
      <div className="pay-security"><LockKeyhole size={15} aria-hidden="true" />No bank or payment details are requested in this demo.</div>
      <div className="screen-actions screen-actions--bottom">
        <Button
          fullWidth
          onClick={onPay}
          disabled={isPaying}
          icon={isPaying ? undefined : <CreditCard size={19} />}
        >
          {isPaying ? 'Processing…' : `Pay ${payments.darren.displayAmount}`}
        </Button>
        <p className="action-helper">Simulated payment · No money will move</p>
      </div>
    </div>
  )
}
