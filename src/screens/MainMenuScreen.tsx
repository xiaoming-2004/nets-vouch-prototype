import { ArrowRight, Clock3, MessageCircleMore, QrCode, ScanLine, Ticket, WalletCards } from 'lucide-react'
import type { ProfileTab, TransactionRecord } from '../app/types'
import { TransactionList } from '../components/TransactionList'

interface MainMenuScreenProps {
  transactions: TransactionRecord[]
  onScan: () => void
  onProfile: (tab: ProfileTab) => void
  onSavedOffers: () => void
  onTransaction: (transactionId: string) => void
}

export function MainMenuScreen({ transactions, onScan, onProfile, onSavedOffers, onTransaction }: MainMenuScreenProps) {
  return (
    <div className="screen screen--main-menu">
      <header className="main-menu-greeting">
        <div>
          <p className="eyebrow">Good evening</p>
          <h1 data-screen-heading tabIndex={-1}>Hi Jia</h1>
          <p>What would you like to do?</p>
        </div>
        <span className="profile-avatar" aria-hidden="true">J</span>
      </header>

      <button className="scan-hero-card" type="button" onClick={onScan} aria-label="Scan to Pay">
        <span className="scan-hero-card__glow" aria-hidden="true" />
        <span className="scan-hero-card__icon"><ScanLine size={30} aria-hidden="true" /></span>
        <span className="scan-hero-card__copy">
          <small>Pay securely with NETS</small>
          <strong>Scan to Pay</strong>
          <span>Tap a merchant QR to begin</span>
        </span>
        <ArrowRight size={22} aria-hidden="true" />
      </button>

      <section className="home-shortcuts" aria-labelledby="shortcuts-title">
        <h2 id="shortcuts-title" className="section-title">Shortcuts</h2>
        <div className="shortcut-grid">
          <button type="button" onClick={() => onProfile('transactions')}>
            <span className="shortcut-icon shortcut-icon--blue"><WalletCards size={20} aria-hidden="true" /></span>
            <strong>My Transactions</strong>
          </button>
          <button type="button" onClick={() => onProfile('vouches')}>
            <span className="shortcut-icon shortcut-icon--red"><MessageCircleMore size={20} aria-hidden="true" /></span>
            <strong>My Vouches</strong>
          </button>
          <button type="button" onClick={onSavedOffers}>
            <span className="shortcut-icon shortcut-icon--green"><Ticket size={20} aria-hidden="true" /></span>
            <strong>Saved Offers</strong>
          </button>
        </div>
      </section>

      <section className="recent-transactions" aria-labelledby="recent-transactions-title">
        <div className="section-heading-inline">
          <div>
            <p className="eyebrow"><Clock3 size={13} aria-hidden="true" /> Activity</p>
            <h2 id="recent-transactions-title">Recent Transactions</h2>
          </div>
          <button type="button" onClick={() => onProfile('transactions')}>View all</button>
        </div>
        <TransactionList transactions={transactions.slice(0, 3)} onSelect={onTransaction} compact />
      </section>

      <p className="prototype-disclaimer"><QrCode size={12} aria-hidden="true" /> Fictional data · Simulated payments</p>
    </div>
  )
}
