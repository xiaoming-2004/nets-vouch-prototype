import { Building2, CreditCard, LockKeyhole, MapPin } from 'lucide-react'
import { Button } from '../components/Button'
import { ScreenHeader } from '../components/ScreenHeader'
import { merchant, payments } from '../data/mockData'

interface PaymentReviewScreenProps {
  isPaying: boolean
  onBack: () => void
  onPay: () => void
  onCancel: () => void
}

export function PaymentReviewScreen({ isPaying, onBack, onPay, onCancel }: PaymentReviewScreenProps) {
  return (
    <div className="screen screen--payment-review">
      <ScreenHeader eyebrow="Review before paying" title="Payment Review" onBack={isPaying ? undefined : onBack} />
      <section className="review-merchant-card" aria-labelledby="review-merchant-name">
        <span className="merchant-monogram" aria-hidden="true">C</span>
        <p className="eyebrow">You’re paying</p>
        <h2 id="review-merchant-name">{merchant.name}</h2>
        <p><MapPin size={14} aria-hidden="true" />{merchant.outlet}</p>
      </section>

      <div className="review-amount">
        <span>Amount</span>
        <strong>{payments.jia.displayAmount}</strong>
      </div>

      <dl className="review-details">
        <div><dt><Building2 size={17} aria-hidden="true" />Merchant</dt><dd>{merchant.name}</dd></div>
        <div><dt><CreditCard size={17} aria-hidden="true" />Payment method</dt><dd>NETS</dd></div>
      </dl>

      <div className="pay-security"><LockKeyhole size={15} aria-hidden="true" />Simulated payment only. No bank or payment details are requested.</div>
      <div className="screen-actions screen-actions--bottom">
        <Button fullWidth onClick={onPay} disabled={isPaying} icon={isPaying ? undefined : <CreditCard size={19} />}>
          {isPaying ? 'Processing…' : `Pay ${payments.jia.displayAmount}`}
        </Button>
        <Button variant="ghost" fullWidth onClick={onCancel} disabled={isPaying}>Cancel</Button>
      </div>
    </div>
  )
}
