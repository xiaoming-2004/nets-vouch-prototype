import type { ConsumerScreen, ScreenId } from './types'

const consumerScreens = new Set<ScreenId>([
  'scanner',
  'payment-review',
  'payment-success',
  'create-vouch',
  'share-sheet',
  'vouch-complete',
  'whatsapp',
  'vouch-detail',
  'offer-claimed',
  'my-offers',
  'use-offer',
  'darren-payment',
  'redemption-success',
])

export function isConsumerScreen(screen: ScreenId): screen is ConsumerScreen | 'scanner' | 'payment-review' {
  return consumerScreens.has(screen)
}

export function showsBottomNavigation(screen: ScreenId): boolean {
  return screen === 'main-menu' || screen === 'profile'
}
