import { ArrowRight, CreditCard, Share2 } from 'lucide-react'
import { Button } from '../../components/Button'
import { SuccessState } from '../../components/SuccessState'

interface PaymentSuccessScreenProps {
  merchantName: string
  amount: string
  onVouch: () => void
  onDone: () => void
}

export function PaymentSuccessScreen({ merchantName, amount, onVouch, onDone }: PaymentSuccessScreenProps) {
  return (
    <div className="screen screen--receipt">
      <SuccessState title="Payment Successful" merchant={merchantName} amount={amount} />
      <div className="payment-method">
        <CreditCard size={18} aria-hidden="true" />
        <span>Paid with NETS</span>
        <span className="payment-method__status">Complete</span>
      </div>
      <Button variant="ghost" fullWidth onClick={onDone}>Done</Button>

      <section className="vouch-invitation" aria-labelledby="worth-sharing-title">
        <div className="vouch-invitation__icon"><Share2 size={22} aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">Payment complete</p>
          <h2 id="worth-sharing-title">Worth sharing?</h2>
          <p>Pass on a trusted recommendation. There’s no reward for you.</p>
        </div>
        <Button fullWidth onClick={onVouch} icon={<ArrowRight size={19} />}>Vouch this place</Button>
      </section>
    </div>
  )
}
