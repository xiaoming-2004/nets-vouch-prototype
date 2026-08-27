import type { TransactionRecord, VouchRecord, VouchTagId } from '../app/types'

export const merchants = {
  cafeAbc: {
    id: 'cafe-abc',
    name: 'Café ABC',
    outlet: 'Café ABC — Orchard Demo Outlet',
  },
  toastAndCo: {
    id: 'toast-and-co',
    name: 'Toast & Co.',
    outlet: 'Toast & Co. — Tiong Bahru Demo Outlet',
  },
  hawker88: {
    id: 'hawker-88',
    name: 'Hawker 88',
    outlet: 'Hawker 88 — Central Demo Outlet',
  },
  gardenBistro: {
    id: 'garden-bistro',
    name: 'Garden Bistro',
    outlet: 'Garden Bistro — Marina Demo Outlet',
  },
}

export const merchant = merchants.cafeAbc

export const people = {
  sender: 'Jia',
  recipient: 'Darren',
}

export const payments = {
  jia: { displayAmount: '$8.50', amount: 8.5 },
  darren: { displayAmount: '$7.80', amount: 7.8 },
}

export const vouchTags: ReadonlyArray<{ id: VouchTagId; label: string; symbol: string }> = [
  { id: 'vouch-pick', label: 'Vouch Pick', symbol: '✦' },
  { id: 'good-value', label: 'Good Value', symbol: '$' },
  { id: 'worth-it', label: 'Worth It', symbol: '✓' },
  { id: 'good-hangout', label: 'Good Hangout', symbol: '☺' },
]

export const initialTransactions: ReadonlyArray<TransactionRecord> = [
  {
    id: 'tx-toast-001',
    merchantId: merchants.toastAndCo.id,
    merchantName: merchants.toastAndCo.name,
    outlet: merchants.toastAndCo.outlet,
    date: '26 Aug 2026',
    time: '8:10 AM',
    amount: 4.2,
    displayAmount: '$4.20',
    status: 'Successful',
    paymentMethod: 'NETS',
    vouchCreated: true,
  },
  {
    id: 'tx-hawker-001',
    merchantId: merchants.hawker88.id,
    merchantName: merchants.hawker88.name,
    outlet: merchants.hawker88.outlet,
    date: '24 Aug 2026',
    time: '12:42 PM',
    amount: 6.8,
    displayAmount: '$6.80',
    status: 'Successful',
    paymentMethod: 'NETS',
    vouchCreated: false,
  },
  {
    id: 'tx-garden-001',
    merchantId: merchants.gardenBistro.id,
    merchantName: merchants.gardenBistro.name,
    outlet: merchants.gardenBistro.outlet,
    date: '21 Aug 2026',
    time: '7:35 PM',
    amount: 24.6,
    displayAmount: '$24.60',
    status: 'Successful',
    paymentMethod: 'NETS',
    vouchCreated: true,
  },
]

export const initialVouches: ReadonlyArray<VouchRecord> = [
  {
    id: 'vouch-toast-001',
    transactionId: 'tx-toast-001',
    merchantId: merchants.toastAndCo.id,
    merchantName: merchants.toastAndCo.name,
    tag: 'good-value',
    date: '26 Aug 2026',
    status: 'Shared',
  },
  {
    id: 'vouch-garden-001',
    transactionId: 'tx-garden-001',
    merchantId: merchants.gardenBistro.id,
    merchantName: merchants.gardenBistro.name,
    tag: 'good-hangout',
    date: '21 Aug 2026',
    status: 'Completed',
  },
]

export const offer = {
  title: 'Free Matcha Latte Upsize',
  eligibility: 'with eligible NETS payment',
  funder: 'Funded by Café ABC',
  limit: 'One per user',
  validity: 'Valid until 30 September 2026',
}

export const campaign = {
  redemptionLimit: 100,
  validity: '28 August–30 September 2026',
  estimatedMaximum: 100,
}

export const businessRates = {
  card: '2.50%',
  nets: '0.80%',
  disclaimer: 'Illustrative published rates. Actual merchant fees vary.',
}

export const personalMessage = 'bro this place quite good HAHA'
