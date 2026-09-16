export type Persona = 'darren' | 'felicia'
export type ProfileTab = 'transactions' | 'vouches'
export type RejectionReason = 'too-far' | 'too-expensive' | 'not-in-mood' | 'ate-recently'
export type OrderStatus = 'none' | 'pending-payment' | 'paid' | 'preparing' | 'ready' | 'collected'
export type PaymentStatus = 'idle' | 'processing' | 'confirmed'
export type CampaignStatus = 'draft' | 'active'
export type MerchantTab = 'setup' | 'orders' | 'results'
export type VouchTagId = 'vouch-pick' | 'good-value' | 'worth-it' | 'good-hangout'
export type VouchRecordStatus = 'Shared' | 'Completed'

// Legacy prototype types are retained so the retired referral screens can still
// compile as reference components. They are no longer reachable from App.tsx.
export type Author = 'Jia' | 'Darren'
export type OfferStatus = 'available' | 'claimed' | 'redeemed'
export type ShareChannel = 'WhatsApp' | 'Telegram' | 'Messages' | 'Copy link'
export type LegacyCampaignStatus = 'draft' | 'launched'

export type ScreenId = 'personalisation' | 'main-menu' | 'recommendation' | 'rejection' | 'consumer-payment' | 'order-status' | 'collection-ready' | 'post-meal-vouch' | 'merchant' | 'scanner' | 'payment-review' | 'payment-success' | 'profile' | 'transaction-detail'

export interface PersonalisationSettings { completed: boolean; recommendations: boolean; transactionAnalysis: boolean; location: boolean; notifications: boolean }
export interface Recommendation { id: 'felicia-chicken-rice' | 'felicia-porridge'; merchantId: string; merchantName: string; itemName: string; price: number; displayPrice: string; distance: string; dietary: string; availability: string; vouchCount: number; reason: string }
export interface MerchantCampaign { status: CampaignStatus; cashback: number; minimumSpend: number; window: string; dailyCap: number; maximumDailyCost: number }
export interface Order { id: string; recommendationId: Recommendation['id']; merchantId: string; merchantName: string; itemName: string; amount: number; displayAmount: string; status: OrderStatus }
export interface Payment { status: PaymentStatus; amount: number; cashbackEarned: number; eligible: boolean }
export interface CampaignMetrics { recommendations: number; accepted: number; attributedPayments: number; cashbackCost: number }

export interface TransactionRecord { id: string; merchantId: string; merchantName: string; outlet: string; date: string; time: string; amount: number; displayAmount: string; status: 'Successful'; paymentMethod: 'NETS'; vouchCreated: boolean }
export interface VouchRecord { id: string; transactionId: string; merchantId: string; merchantName: string; tag: VouchTagId; date: string; status: VouchRecordStatus }

export interface DemoState {
  version: 1; activeScreen: ScreenId; history: ScreenId[]; persona: Persona; merchantTab: MerchantTab; navigatorOpen: boolean; restartArmed: boolean; notice: string | null;
  settings: PersonalisationSettings; recommendationId: Recommendation['id']; recommendationCounted: boolean; rejectionReason: RejectionReason | null;
  campaign: MerchantCampaign; metrics: CampaignMetrics; order: Order | null; payment: Payment; cashbackRecorded: boolean; vouchUnlocked: boolean; mealCompleted: boolean;
  isScanning: boolean; scannedMerchantId: string | null; currentTransactionId: string | null; selectedTransactionId: string | null;
  transactions: TransactionRecord[]; vouches: VouchRecord[]; profileTab: ProfileTab; transactionSequence: number; vouchSequence: number;
}

export type DemoAction =
  | { type: 'SAVE_SETTINGS'; settings: Omit<PersonalisationSettings, 'completed'> } | { type: 'OPEN_SETTINGS' } | { type: 'OPEN_RECOMMENDATION' }
  | { type: 'REJECT_RECOMMENDATION' } | { type: 'SELECT_REJECTION_REASON'; reason: RejectionReason } | { type: 'ACCEPT_RECOMMENDATION' }
  | { type: 'BEGIN_AI_PAYMENT' } | { type: 'COMPLETE_AI_PAYMENT' } | { type: 'START_PREPARING' } | { type: 'MARK_READY' } | { type: 'MARK_COLLECTED' }
  | { type: 'COMPLETE_MEAL' } | { type: 'CREATE_VOUCH' } | { type: 'SKIP_VOUCH' } | { type: 'SWITCH_PERSONA'; persona: Persona }
  | { type: 'SET_MERCHANT_TAB'; tab: MerchantTab } | { type: 'UPDATE_CAMPAIGN'; values: Partial<Pick<MerchantCampaign, 'cashback' | 'minimumSpend' | 'dailyCap'>> } | { type: 'PUBLISH_CAMPAIGN' } | { type: 'BACK' } | { type: 'GO_HOME'; notice?: string }
  | { type: 'OPEN_SCAN' } | { type: 'SIMULATE_SCAN' } | { type: 'COMPLETE_SCAN' } | { type: 'BEGIN_SCAN_PAYMENT' } | { type: 'COMPLETE_SCAN_PAYMENT' }
  | { type: 'OPEN_PROFILE'; tab?: ProfileTab } | { type: 'SELECT_TRANSACTION'; transactionId: string } | { type: 'OPEN_NAVIGATOR' } | { type: 'CLOSE_NAVIGATOR' }
  | { type: 'SHOW_NOTICE'; notice: string } | { type: 'CLEAR_NOTICE' } | { type: 'ARM_RESTART' } | { type: 'RESTART' }
