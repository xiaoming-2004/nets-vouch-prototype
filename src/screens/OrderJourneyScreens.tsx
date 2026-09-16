import { BadgeDollarSign, CheckCircle2, MapPinned, PackageCheck, Store } from 'lucide-react'
import type { Order } from '../app/types'
import { Button } from '../components/Button'

export function OrderStatusScreen({ order, onMerchant }: { order: Order; onMerchant: () => void }) {
  return <div className="screen screen--order-status"><div className="order-success"><CheckCircle2 size={54} aria-hidden="true" /><p className="eyebrow">NETS payment confirmed</p><h1 data-screen-heading tabIndex={-1}>Order sent to Felicia</h1><p>{order.id} · {order.itemName}</p></div>
    <div className="cashback-earned"><BadgeDollarSign size={24} aria-hidden="true" /><div><strong>$0.50 cashback earned</strong><span>Recorded from the redeemed merchant offer</span></div></div>
    <section className="waiting-card"><Store size={24} aria-hidden="true" /><div><h2>{order.status === 'preparing' ? 'Felicia is preparing it' : 'Waiting for Felicia'}</h2><p>The merchant controls preparation and will mark the order ready. No AI cooking-time promise.</p></div></section>
    <div className="screen-actions screen-actions--bottom"><Button fullWidth variant="secondary" onClick={onMerchant}>View Felicia’s side</Button></div>
  </div>
}

export function CollectionReadyScreen({ order, onCollected }: { order: Order; onCollected: () => void }) {
  return <div className="screen screen--collection"><div className="ready-hero"><PackageCheck size={58} aria-hidden="true" /><p className="eyebrow">Merchant confirmed</p><h1 data-screen-heading tabIndex={-1}>Ready for collection</h1><p>{order.id} · {order.itemName}</p></div>
    <div className="collection-card"><h2>{order.merchantName}</h2><p><MapPinned size={16} aria-hidden="true" />RP North Food Court · 8-minute walk</p><strong>Show collection number {order.id}</strong></div>
    <div className="screen-actions screen-actions--bottom"><Button fullWidth onClick={onCollected}>I collected my order</Button></div>
  </div>
}
