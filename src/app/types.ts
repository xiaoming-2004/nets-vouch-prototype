export type ConsumerScreen =
  | 'payment-success'
  | 'create-vouch'
  | 'share-sheet'
  | 'whatsapp'
  | 'vouch-detail'
  | 'offer-claimed'
  | 'my-offers'
  | 'use-offer'
  | 'darren-payment'
  | 'redemption-success'

export type SupportingScreen = 'merchant-campaign' | 'business-logic'
export type ScreenId = 'demo-home' | ConsumerScreen | SupportingScreen
export type VouchTagId = 'vouch-pick' | 'good-value' | 'worth-it' | 'good-hangout'
export type OfferStatus = 'available' | 'claimed' | 'redeemed'
export type CampaignStatus = 'draft' | 'launched'
export type Author = 'Jia' | 'Darren'

export interface DemoState {
  activeScreen: ScreenId
  consumerScreen: ConsumerScreen
  history: ScreenId[]
  supportingReturnScreen: ConsumerScreen | 'demo-home'
  selectedTag: VouchTagId | null
  currentAuthor: Author
  cycleNumber: number
  offerStatus: OfferStatus
  campaignStatus: CampaignStatus
  navigatorOpen: boolean
  notice: string | null
  isPaying: boolean
  hasStarted: boolean
  restartArmed: boolean
}

export type DemoAction =
  | { type: 'START_OR_RESUME' }
  | { type: 'NAVIGATE'; screen: ConsumerScreen }
  | { type: 'BACK' }
  | { type: 'GO_HOME'; notice?: string }
  | { type: 'SELECT_TAG'; tag: VouchTagId }
  | { type: 'SKIP_VOUCH' }
  | { type: 'CLAIM_OFFER' }
  | { type: 'USE_OFFER' }
  | { type: 'BEGIN_PAYMENT' }
  | { type: 'COMPLETE_PAYMENT' }
  | { type: 'CREATE_NEXT_VOUCH' }
  | { type: 'OPEN_NAVIGATOR' }
  | { type: 'CLOSE_NAVIGATOR' }
  | { type: 'OPEN_SUPPORT'; screen: SupportingScreen }
  | { type: 'CLOSE_SUPPORT' }
  | { type: 'SUPPORT_BACK' }
  | { type: 'SUPPORT_NEXT' }
  | { type: 'LAUNCH_CAMPAIGN' }
  | { type: 'SHOW_NOTICE'; notice: string }
  | { type: 'CLEAR_NOTICE' }
  | { type: 'ARM_RESTART' }
  | { type: 'RESTART' }
