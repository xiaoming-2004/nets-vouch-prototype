import { ShieldCheck, Ticket, UserRound } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import type { ProfileTab, TransactionRecord, VouchRecord } from '../app/types'
import { TransactionList } from '../components/TransactionList'
import { VouchHistoryList } from '../components/VouchHistoryList'

interface ProfileScreenProps {
  activeTab: ProfileTab
  transactions: TransactionRecord[]
  vouches: VouchRecord[]
  onTab: (tab: ProfileTab) => void
  onTransaction: (transactionId: string) => void
  onSavedOffers: () => void
}

export function ProfileScreen({ activeTab, transactions, vouches, onTab, onTransaction, onSavedOffers }: ProfileScreenProps) {
  const selectTabFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, tab: ProfileTab) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    onTab(tab)
    window.requestAnimationFrame(() => document.getElementById(`${tab}-tab`)?.focus())
  }

  return (
    <div className="screen screen--profile">
      <header className="profile-header">
        <span className="profile-header__avatar" aria-hidden="true"><UserRound size={27} /></span>
        <div>
          <p className="eyebrow">Prototype profile</p>
          <h1 data-screen-heading tabIndex={-1}>Jia</h1>
          <p><ShieldCheck size={13} aria-hidden="true" /> Fictional NETS user</p>
        </div>
        <button type="button" className="saved-offers-link" onClick={onSavedOffers}>
          <Ticket size={17} aria-hidden="true" />
          <span>Saved Offers</span>
        </button>
      </header>

      <div className="profile-tabs" role="tablist" aria-label="Profile records">
        <button
          type="button"
          role="tab"
          id="transactions-tab"
          aria-selected={activeTab === 'transactions'}
          aria-controls="transactions-panel"
          tabIndex={activeTab === 'transactions' ? 0 : -1}
          onClick={() => onTab('transactions')}
          onKeyDown={(event) => selectTabFromKeyboard(event, 'vouches')}
        >
          Past Transactions <span>{transactions.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          id="vouches-tab"
          aria-selected={activeTab === 'vouches'}
          aria-controls="vouches-panel"
          tabIndex={activeTab === 'vouches' ? 0 : -1}
          onClick={() => onTab('vouches')}
          onKeyDown={(event) => selectTabFromKeyboard(event, 'transactions')}
        >
          My Vouches <span>{vouches.length}</span>
        </button>
      </div>

      {activeTab === 'transactions' ? (
        <section className="profile-panel" role="tabpanel" id="transactions-panel" aria-labelledby="transactions-tab">
          <div className="profile-panel__heading"><h2>Past Transactions</h2><p>Successful NETS payments made by Jia.</p></div>
          <TransactionList transactions={transactions} onSelect={onTransaction} />
        </section>
      ) : (
        <section className="profile-panel" role="tabpanel" id="vouches-panel" aria-labelledby="vouches-tab">
          <div className="profile-panel__heading"><h2>My Vouches</h2><p>Recommendations Jia created after verified visits.</p></div>
          <VouchHistoryList vouches={vouches} />
        </section>
      )}
    </div>
  )
}
