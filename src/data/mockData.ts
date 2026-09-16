import type { Recommendation, TransactionRecord, VouchRecord, VouchTagId } from '../app/types'

export const merchants = {
  felicia: { id: 'felicia-chicken-rice', name: "Felicia's Chicken Rice", outlet: 'RP North Food Court · Stall 08' },
  cafeAbc: { id: 'cafe-abc', name: 'Café ABC', outlet: 'Café ABC — Orchard Demo Outlet' },
  toastAndCo: { id: 'toast-and-co', name: 'Toast & Co.', outlet: 'Toast & Co. — Tiong Bahru Demo Outlet' },
  hawker88: { id: 'hawker-88', name: 'Hawker 88', outlet: 'Hawker 88 — Central Demo Outlet' },
}

// Retained for the secondary Scan-to-Pay journey.
export const merchant = merchants.cafeAbc
export const payments = { jia: { displayAmount: '$8.50', amount: 8.5 }, darren: { displayAmount: '$7.50', amount: 7.5 } }

// Compatibility data for retired referral screens. The active prototype no
// longer exposes these screens or uses this offer/funding explanation.
export const offer = {
  title: 'Free upsize with NETS',
  validity: 'Valid for 2 months',
  eligibility: 'Complete an eligible NETS payment to redeem.',
  funder: 'Merchant-funded',
  limit: 'One redemption per customer',
}
export const campaign = { redemptionLimit: '20 per day', validity: '2 months', estimatedMaximum: 1200 }
export const businessRates = {
  card: '2.50%',
  nets: '0.80%',
  disclaimer: 'Legacy illustrative example — not used to fund the current cashback model.',
}
export const personalMessage = 'Thought you might like this place.'

export const recommendations: Record<Recommendation['id'], Recommendation> = {
  'felicia-chicken-rice': {
    id: 'felicia-chicken-rice', merchantId: merchants.felicia.id, merchantName: merchants.felicia.name, itemName: 'Chicken Rice',
    price: 7.5, displayPrice: '$7.50', distance: '8-minute walk', dietary: 'Halal', availability: 'Accepting pickup orders', vouchCount: 18,
    reason: 'Fits your under-$8 preference and walking distance.',
  },
  'felicia-porridge': {
    id: 'felicia-porridge', merchantId: merchants.felicia.id, merchantName: merchants.felicia.name, itemName: 'Chicken Porridge',
    price: 6.9, displayPrice: '$6.90', distance: '4-minute walk', dietary: 'Halal', availability: 'Express counter available', vouchCount: 12,
    reason: 'Adjusted using the reason you selected.',
  },
}

export const rejectionLabels = { 'too-far': 'Too far', 'too-expensive': 'Costs too much', 'not-in-mood': 'Not in the mood', 'ate-recently': 'Ate this recently' } as const
export const vouchTags: ReadonlyArray<{ id: VouchTagId; label: string; symbol: string }> = [
  { id: 'vouch-pick', label: 'Vouch Pick', symbol: '✦' }, { id: 'good-value', label: 'Good Value', symbol: '$' },
  { id: 'worth-it', label: 'Worth It', symbol: '✓' }, { id: 'good-hangout', label: 'Good Hangout', symbol: '☺' },
]

export const initialTransactions: ReadonlyArray<TransactionRecord> = [
  { id: 'tx-toast-001', merchantId: merchants.toastAndCo.id, merchantName: merchants.toastAndCo.name, outlet: merchants.toastAndCo.outlet, date: '1 Sep 2026', time: '8:10 AM', amount: 4.2, displayAmount: '$4.20', status: 'Successful', paymentMethod: 'NETS', vouchCreated: true },
  { id: 'tx-hawker-001', merchantId: merchants.hawker88.id, merchantName: merchants.hawker88.name, outlet: merchants.hawker88.outlet, date: '30 Aug 2026', time: '12:42 PM', amount: 6.8, displayAmount: '$6.80', status: 'Successful', paymentMethod: 'NETS', vouchCreated: false },
]

export const initialVouches: ReadonlyArray<VouchRecord> = [
  { id: 'vouch-toast-001', transactionId: 'tx-toast-001', merchantId: merchants.toastAndCo.id, merchantName: merchants.toastAndCo.name, tag: 'good-value', date: '1 Sep 2026', status: 'Completed' },
]
