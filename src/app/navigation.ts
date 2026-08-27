import type { ConsumerScreen, ScreenId } from './types'

const consumerScreens = new Set<ScreenId>([
  'payment-success',
  'create-vouch',
  'share-sheet',
  'whatsapp',
  'vouch-detail',
  'offer-claimed',
  'my-offers',
  'use-offer',
  'darren-payment',
  'redemption-success',
])

export function isConsumerScreen(screen: ScreenId): screen is ConsumerScreen {
  return consumerScreens.has(screen)
}
