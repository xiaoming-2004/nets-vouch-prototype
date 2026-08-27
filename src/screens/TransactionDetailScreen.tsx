import { BadgeCheck, CalendarDays, CreditCard, MapPin, MessageCircleMore } from 'lucide-react'
import type { TransactionRecord } from '../app/types'
import { Button } from '../components/Button'
import { ScreenHeader } from '../components/ScreenHeader'

interface TransactionDetailScreenProps {
  transaction: TransactionRecord
  onBack: () => void
  onVouch: () => void
  onViewVouches: () => void
}

export function TransactionDetailScreen({ transaction, onBack, onVouch, onViewVouches }: TransactionDetailScreenProps) {
  return (
    <div className="screen screen--transaction-detail">
      <ScreenHeader eyebrow="Past transaction" title="Transaction Detail" onBack={onBack} />
      <div className="transaction-detail-hero">
        <span className="merchant-monogram" aria-hidden="true">{transaction.merchantName.charAt(0)}</span>
        <h2>{transaction.merchantName}</h2>
        <p className="transaction-detail-hero__amount">{transaction.displayAmount}</p>
        <span className="success-label"><BadgeCheck size={15} aria-hidden="true" />Successful</span>
      </div>
      <dl className="transaction-detail-list">
        <div><dt><MapPin size={17} aria-hidden="true" />Outlet</dt><dd>{transaction.outlet}</dd></div>
        <div><dt><CalendarDays size={17} aria-hidden="true" />Date and time</dt><dd>{transaction.date}<small>{transaction.time}</small></dd></div>
        <div><dt><CreditCard size={17} aria-hidden="true" />Payment method</dt><dd>{transaction.paymentMethod}</dd></div>
        <div><dt><MessageCircleMore size={17} aria-hidden="true" />Vouch</dt><dd>{transaction.vouchCreated ? 'Created' : 'Not created'}</dd></div>
      </dl>
      <div className="transaction-vouch-cta">
        <MessageCircleMore size={22} aria-hidden="true" />
        <div>
          <h2>{transaction.vouchCreated ? 'Vouch created' : 'Worth sharing?'}</h2>
          <p>{transaction.vouchCreated ? 'This recommendation is saved in My Vouches.' : 'Create a Vouch from this verified NETS visit.'}</p>
        </div>
      </div>
      <div className="screen-actions screen-actions--bottom">
        {transaction.vouchCreated ? (
          <Button fullWidth variant="secondary" onClick={onViewVouches}>View My Vouches</Button>
        ) : (
          <Button fullWidth onClick={onVouch}>Vouch this merchant</Button>
        )}
      </div>
    </div>
  )
}
