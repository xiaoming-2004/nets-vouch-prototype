import type { VouchTagId } from '../app/types'

export const merchant = {
  name: 'Café ABC',
  outlet: 'Café ABC — Orchard Demo Outlet',
}

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
