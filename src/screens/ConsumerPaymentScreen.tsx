import { CreditCard, Gift, LockKeyhole } from 'lucide-react'
import type { Order, PaymentStatus } from '../app/types'
import { Button } from '../components/Button'
import { ScreenHeader } from '../components/ScreenHeader'

export function ConsumerPaymentScreen({ order, status, onPay, onBack }: { order: Order; status: PaymentStatus; onPay: () => void; onBack: () => void }) {
  return <div className="screen screen--payment"><ScreenHeader eyebrow="Simulated NETS payment" title="Review and pay" onBack={status === 'processing' ? undefined : onBack} />
    <div className="payment-summary"><p className="eyebrow">You are paying</p><h2>{order.merchantName}</h2><p>{order.itemName}</p><p className="payment-summary__amount">{order.displayAmount}</p></div>
    <section className="cashback-explainer"><Gift size={22} aria-hidden="true" /><div><strong>$0.50 cashback after payment</strong><p>You pay the full {order.displayAmount}. Cashback is recorded separately after an eligible NETS confirmation.</p></div></section>
    <div className="pay-security"><LockKeyhole size={15} aria-hidden="true" />No real payment details or money are used.</div>
    <div className="screen-actions screen-actions--bottom"><Button fullWidth onClick={onPay} disabled={status === 'processing'} icon={<CreditCard size={19} />}>{status === 'processing' ? 'Processing…' : `Pay ${order.displayAmount} with NETS`}</Button><p className="action-helper">Simulated payment · Merchant handoff follows</p></div>
  </div>
}
