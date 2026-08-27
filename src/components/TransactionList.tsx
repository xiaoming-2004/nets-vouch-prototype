import { ArrowRight, BadgeCheck, MessageCircleMore } from 'lucide-react'
import type { TransactionRecord } from '../app/types'

interface TransactionListProps {
  transactions: TransactionRecord[]
  onSelect: (transactionId: string) => void
  compact?: boolean
}

export function TransactionList({ transactions, onSelect, compact = false }: TransactionListProps) {
  return (
    <div className={compact ? 'transaction-list transaction-list--compact' : 'transaction-list'}>
      {transactions.map((transaction) => (
        <button
          key={transaction.id}
          type="button"
          className="transaction-row"
          onClick={() => onSelect(transaction.id)}
          aria-label={`View ${transaction.merchantName} transaction, ${transaction.displayAmount}, ${transaction.status}`}
        >
          <span className="transaction-row__mark" aria-hidden="true">{transaction.merchantName.charAt(0)}</span>
          <span className="transaction-row__copy">
            <strong>{transaction.merchantName}</strong>
            <small>{transaction.date} · {transaction.time}</small>
            {!compact ? (
              <span className="transaction-row__meta">
                <span><BadgeCheck size={13} aria-hidden="true" />Successful</span>
                <span className={transaction.vouchCreated ? 'transaction-vouch transaction-vouch--yes' : 'transaction-vouch'}>
                  <MessageCircleMore size={13} aria-hidden="true" />
                  {transaction.vouchCreated ? 'Vouch created' : 'No Vouch yet'}
                </span>
              </span>
            ) : null}
          </span>
          <span className="transaction-row__amount">
            <strong>{transaction.displayAmount}</strong>
            <small>NETS</small>
          </span>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}
