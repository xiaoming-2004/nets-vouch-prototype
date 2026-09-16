import { ArrowRight, BrainCircuit, Clock3, MessageCircleMore, ScanLine, WalletCards } from 'lucide-react'
import type { ProfileTab, TransactionRecord } from '../app/types'
import { TransactionList } from '../components/TransactionList'

interface Props { transactions: TransactionRecord[]; basicMode: boolean; recommendationsEnabled: boolean; campaignActive: boolean; orderReady: boolean; onRecommendation: () => void; onSettings: () => void; onScan: () => void; onProfile: (tab: ProfileTab) => void; onTransaction: (id: string) => void }

export function MainMenuScreen({ transactions, basicMode, recommendationsEnabled, campaignActive, orderReady, onRecommendation, onSettings, onScan, onProfile, onTransaction }: Props) {
  return <div className="screen screen--main-menu">
    <header className="main-menu-greeting"><div><p className="eyebrow">Good afternoon</p><h1 data-screen-heading tabIndex={-1}>Hi Darren</h1><p>Make lunch count.</p></div><span className="profile-avatar" aria-hidden="true">D</span></header>
    {orderReady ? <button className="ready-home-banner" type="button" onClick={onRecommendation}><strong>Order #104 is ready</strong><span>Open collection details <ArrowRight size={17} /></span></button> : !recommendationsEnabled || !campaignActive ? <button className="recommendation-paused" type="button" onClick={onSettings}><BrainCircuit size={22} aria-hidden="true" /><span><strong>{recommendationsEnabled ? 'Participating offer paused' : 'Recommendations paused'}</strong><small>{recommendationsEnabled ? 'Open settings or try again later' : 'Tap to manage personalisation'}</small></span></button> : <button className="ai-recommendation-hero" type="button" onClick={onRecommendation} aria-label="Open today’s lunch recommendation">
      <span className="ai-recommendation-hero__icon"><BrainCircuit size={27} aria-hidden="true" /></span><span><small>Lunch soon?</small><strong>One participating option matches</strong><em>Budget · preferences · location</em></span><ArrowRight size={22} aria-hidden="true" />
    </button>}
    <button type="button" className="personalisation-status" onClick={onSettings}><span>{basicMode ? 'Basic Mode' : 'Personalised'}</span><small>{basicMode ? 'Transaction analysis is off' : 'Using only data you allowed'}</small></button>
    <button className="scan-compact-card" type="button" onClick={onScan}><span><ScanLine size={22} aria-hidden="true" /></span><strong>Scan to Pay</strong><small>Simulate a merchant QR</small><ArrowRight size={18} aria-hidden="true" /></button>
    <section className="home-shortcuts" aria-labelledby="shortcuts-title"><h2 id="shortcuts-title" className="section-title">Your NETS activity</h2><div className="shortcut-grid shortcut-grid--two"><button type="button" onClick={() => onProfile('transactions')}><span className="shortcut-icon shortcut-icon--blue"><WalletCards size={20} /></span><strong>Transactions</strong></button><button type="button" onClick={() => onProfile('vouches')}><span className="shortcut-icon shortcut-icon--red"><MessageCircleMore size={20} /></span><strong>My Vouches</strong></button></div></section>
    <section className="recent-transactions" aria-labelledby="recent-title"><div className="section-heading-inline"><div><p className="eyebrow"><Clock3 size={13} /> Activity</p><h2 id="recent-title">Recent</h2></div><button onClick={() => onProfile('transactions')}>View all</button></div><TransactionList transactions={transactions.slice(0, 2)} onSelect={onTransaction} compact /></section>
    <p className="prototype-disclaimer">Fictional data · Simulated AI and payments</p>
  </div>
}
