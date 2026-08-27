export type AppScreen =
  | 'main-menu'
  | 'scanner'
  | 'payment-review'
  | 'profile'
  | 'transaction-detail'

export type ConsumerScreen =
  | 'payment-success'
  | 'create-vouch'
  | 'share-sheet'
  | 'vouch-complete'
  | 'whatsapp'
  | 'vouch-detail'
  | 'offer-claimed'
  | 'my-offers'
  | 'use-offer'
  | 'darren-payment'
  | 'redemption-success'

export type SupportingScreen = 'merchant-campaign' | 'business-logic'
export type ScreenId = AppScreen | ConsumerScreen | SupportingScreen
export type VouchTagId = 'vouch-pick' | 'good-value' | 'worth-it' | 'good-hangout'
export type OfferStatus = 'available' | 'claimed' | 'redeemed'
export type CampaignStatus = 'draft' | 'launched'
export type Author = 'Jia' | 'Darren'
export type ProfileTab = 'transactions' | 'vouches'
export type ShareChannel = 'WhatsApp' | 'Telegram' | 'Messages' | 'Copy link'
export type VouchRecordStatus = 'Shared' | 'Completed'

export interface TransactionRecord {
  id: string
  merchantId: string
  merchantName: string
  outlet: string
  date: string
  time: string
  amount: number
  displayAmount: string
  status: 'Successful'
  paymentMethod: 'NETS'
  vouchCreated: boolean
}

export interface VouchRecord {
  id: string
  transactionId: string
  merchantId: string
  merchantName: string
  tag: VouchTagId
  date: string
  status: VouchRecordStatus
}

export interface DemoState {
  activeScreen: ScreenId
  consumerScreen: ConsumerScreen | 'scanner' | 'payment-review'
  history: ScreenId[]
  supportingReturnScreen: ScreenId
  selectedTag: VouchTagId | null
  currentAuthor: Author
  currentPersona: Author
  cycleNumber: number
  offerStatus: OfferStatus
  campaignStatus: CampaignStatus
  navigatorOpen: boolean
  notice: string | null
  isScanning: boolean
  isPaying: boolean
  hasStarted: boolean
  restartArmed: boolean
  scannedMerchantId: string | null
  currentTransactionId: string | null
  selectedTransactionId: string | null
  transactions: TransactionRecord[]
  vouches: VouchRecord[]
  profileTab: ProfileTab
  lastShareChannel: ShareChannel | null
  transactionSequence: number
  vouchSequence: number
}

export type DemoAction =
  | { type: 'START_OR_RESUME' }
  | { type: 'NAVIGATE'; screen: ConsumerScreen }
  | { type: 'BACK' }
  | { type: 'GO_HOME'; notice?: string }
  | { type: 'OPEN_SCAN' }
  | { type: 'SIMULATE_SCAN' }
  | { type: 'COMPLETE_SCAN' }
  | { type: 'BEGIN_SCAN_PAYMENT' }
  | { type: 'COMPLETE_SCAN_PAYMENT' }
  | { type: 'OPEN_PROFILE'; tab?: ProfileTab }
  | { type: 'OPEN_SAVED_OFFERS' }
  | { type: 'SELECT_TRANSACTION'; transactionId: string }
  | { type: 'START_VOUCH'; transactionId: string | null; author: Author }
  | { type: 'SELECT_TAG'; tag: VouchTagId }
  | { type: 'SKIP_VOUCH' }
  | { type: 'COMPLETE_VOUCH'; channel: ShareChannel }
  | { type: 'CONTINUE_AS_DARREN' }
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
