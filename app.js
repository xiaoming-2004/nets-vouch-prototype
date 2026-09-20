// Import packages
const express = require('express');
const session = require('express-session');
const path = require('path');

// Load local environment variables when a .env file exists (Node.js 22+).
try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const app = express();
const PORT = process.env.PORT || 3000;
const MINIMUM_ELIGIBLE_PAYMENT = 1.00;
const PLACES_REQUEST_TIMEOUT_MS = 3500;
const AI_RANKING_TIMEOUT_MS = 3000;
const CLAIM_EXPIRY_MS = 20 * 60 * 1000;
const REFERRAL_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

// Configure Express
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure session
const demoStore = new session.MemoryStore();
app.use(session({
  store: demoStore,
  secret: 'nets-vouch-ai-demo-secret',
  resave: false,
  saveUninitialized: false
}));

// Ensure demo session is always initialised before any route renders, even on fresh sessions
// where req.session.reload() in the queue middleware below has not yet fired.
app.use(function(req, res, next) {
  initialiseDemoSession(req);
  res.locals.demoUser = req.session.demo.user;
  next();
});

// Mock data
const merchants = {
  felicia: {
    id: 'felicia-chicken-rice',
    name: "Felicia's Chicken Rice",
    outlet: 'RP North Food Court · Stall 08'
  },
  greenBowl: {
    id: 'green-bowl',
    name: 'Green Bowl',
    outlet: 'Republic Polytechnic · North Food Court'
  },
  toastAndCo: {
    id: 'toast-and-co',
    name: 'Toast & Co.',
    outlet: 'Toast & Co. — Tiong Bahru Demo Outlet'
  },
  hawker88: {
    id: 'hawker-88',
    name: 'Hawker 88',
    outlet: 'Hawker 88 — Central Demo Outlet'
  }
};

// Configurable Open House location. This is a public venue, not Jia's home location.
const demoLocation = {
  name: 'Republic Polytechnic, Woodlands',
  latitude: 1.4428,
  longitude: 103.7854,
  searchRadiusMetres: 2000
};

// Local merchants keep the Open House demo working without an API key or internet.
const fallbackMerchants = [
  {
    id: 'felicia-chicken-rice',
    merchantId: merchants.felicia.id,
    merchantName: merchants.felicia.name,
    name: merchants.felicia.name,
    itemName: 'Chicken Rice',
    price: 5.00,
    category: 'chicken-rice',
    address: merchants.felicia.outlet,
    dietary: ['halal'],
    distanceMinutes: 8,
    coordinates: { latitude: 1.4433, longitude: 103.7860 },
    source: 'local-fallback',
    available: true
  },
  {
    id: merchants.greenBowl.id,
    merchantId: merchants.greenBowl.id,
    merchantName: merchants.greenBowl.name,
    name: merchants.greenBowl.name,
    itemName: 'Vegan Grain Bowl',
    price: 9.20,
    category: 'healthy-food',
    address: merchants.greenBowl.outlet,
    dietary: ['vegetarian', 'vegan'],
    distanceMinutes: 6,
    coordinates: { latitude: 1.4409, longitude: 103.7859 },
    source: 'local-fallback',
    available: true
  },
  {
    id: 'woodlands-noodle-bar',
    merchantId: 'woodlands-noodle-bar',
    merchantName: 'Woodlands Noodle Bar',
    name: 'Woodlands Noodle Bar',
    itemName: 'Mushroom Noodles',
    price: 6.80,
    category: 'noodles',
    address: 'Woodlands Demo Outlet',
    dietary: ['vegetarian'],
    distanceMinutes: 4,
    coordinates: { latitude: 1.4418, longitude: 103.7838 },
    source: 'local-fallback',
    available: true
  },
  {
    id: 'northside-wraps',
    merchantId: 'northside-wraps',
    merchantName: 'Northside Wraps',
    name: 'Northside Wraps',
    itemName: 'Vegan Crunch Wrap',
    price: 8.80,
    category: 'wraps',
    address: 'Woodlands Demo Outlet',
    dietary: ['vegetarian', 'vegan'],
    distanceMinutes: 9,
    coordinates: { latitude: 1.4450, longitude: 103.7880 },
    source: 'local-fallback',
    available: true
  },
  {
    id: 'spice-lane',
    merchantId: 'spice-lane',
    merchantName: 'Spice Lane',
    name: 'Spice Lane',
    itemName: 'Chicken Biryani',
    price: 8.50,
    category: 'indian-food',
    address: 'Woodlands Demo Outlet',
    dietary: ['halal'],
    distanceMinutes: 7,
    coordinates: { latitude: 1.4444, longitude: 103.7828 },
    source: 'local-fallback',
    available: true
  }
];

const rejectionReasons = [
  { id: 'too-far', label: 'Too far' },
  { id: 'too-expensive', label: 'Costs too much' },
  { id: 'not-in-mood', label: 'Not in the mood' },
  { id: 'ate-recently', label: 'Ate this recently' }
];

const dietaryPreferenceOptions = [
  { value: 'none', label: 'No dietary restriction' },
  { value: 'halal', label: 'Halal' },
  { value: 'vegetarian', label: 'Vegetarian' },
  { value: 'vegan', label: 'Vegan' }
];

const vouchTags = [
  { id: 'worth-it', label: 'Worth It' },
  { id: 'tasty', label: 'Tasty' },
  { id: 'hidden-gem', label: 'Hidden gem' },
  { id: 'would-return', label: 'Would return' }
];

// Shared links live across demo sessions, but disappear when this prototype restarts.
const sharedOffers = new Map();

// Prototype identity support: a stable userId per demo persona (no real auth). Lets
// self-referral and cooldown rules key off who someone actually is, not just their browser session.
const demoIdentities = {
  jia: { id: 'jia', name: 'Jia', fullName: 'Jia Yi' },
  darren: { id: 'darren', name: 'Darren', fullName: 'Darren Tan' }
};
function isValidDemoIdentity(id) { return Object.prototype.hasOwnProperty.call(demoIdentities, id); }

// Caps how often the same sender/recipient/merchant referral loop can earn a reward.
const referralCooldowns = new Map();
function referralCooldownKey(senderUserId, recipientUserId, merchantId) {
  return senderUserId + '|' + recipientUserId + '|' + merchantId;
}
function isReferralOnCooldown(senderUserId, recipientUserId, merchantId) {
  const last = referralCooldowns.get(referralCooldownKey(senderUserId, recipientUserId, merchantId));
  return Boolean(last && Date.now() - last < REFERRAL_COOLDOWN_MS);
}
function recordReferralConversion(senderUserId, recipientUserId, merchantId) {
  referralCooldowns.set(referralCooldownKey(senderUserId, recipientUserId, merchantId), Date.now());
}

// Simulated two-week baseline so the merchant results dashboard looks live from day one.
// dailyPayments: last 7 days oldest→newest [Sep 14 … Sep 20], shows natural growth trend.
const campaignSeedMetrics = {
  'felicia-chicken-rice': {
    smartMatchShown: 218, smartMatchAccepted: 167, smartMatchPayments: 143, smartMatchSales: 715.00,
    sharedVouchClaims: 89, sharedVouchPayments: 67, sharedVouchSales: 335.00,
    directScanPayments: 284, directScanSales: 1420.00,
    scans: 412, payments: 494, rewardCost: 120.00, platformFeeAccrued: 21.00,
    dailyPayments: [29, 33, 37, 40, 42, 44, 48]
  },
  'green-bowl': {
    smartMatchShown: 84, smartMatchAccepted: 69, smartMatchPayments: 58, smartMatchSales: 533.60,
    sharedVouchClaims: 31, sharedVouchPayments: 24, sharedVouchSales: 220.80,
    directScanPayments: 97, directScanSales: 892.40,
    scans: 145, payments: 179, rewardCost: 45.00, platformFeeAccrued: 8.20,
    dailyPayments: [10, 12, 11, 14, 15, 13, 16]
  },
  'toast-and-co': {
    smartMatchShown: 47, smartMatchAccepted: 36, smartMatchPayments: 31, smartMatchSales: 186.00,
    sharedVouchClaims: 25, sharedVouchPayments: 18, sharedVouchSales: 108.00,
    directScanPayments: 198, directScanSales: 1188.00,
    scans: 287, payments: 247, rewardCost: 33.50, platformFeeAccrued: 4.90,
    dailyPayments: [15, 17, 19, 21, 20, 23, 25]
  },
  'hawker-88': {
    smartMatchShown: 31, smartMatchAccepted: 24, smartMatchPayments: 19, smartMatchSales: 114.00,
    sharedVouchClaims: 15, sharedVouchPayments: 11, sharedVouchSales: 66.00,
    directScanPayments: 89, directScanSales: 534.00,
    scans: 134, payments: 119, rewardCost: 18.00, platformFeeAccrued: 3.00,
    dailyPayments: [7, 8, 9, 9, 10, 11, 12]
  }
};

// Each fictional participating merchant owns its own campaign.
// Metrics start at zero so live increments remain testable.
// The seed baseline is applied at render time by buildDisplayCampaign().
function createCampaigns() {
  const campaigns = [];
  fallbackMerchants.forEach(function(merchant) {
    campaigns.push({
      id: merchant.id + '-campaign', merchantId: merchant.id,
      rewardAmount: 0.50, minimumEligibleSpend: 5.00,
      maxRewardedPaymentsPerDay: 20, maxRewardBudgetPerDay: 10.00,
      startTime: '00:00', endTime: '23:59',
      senderReferralReward: 0.20, platformFeePerAttributedPayment: 0.10,
      platformFeeAccrued: 0, status: 'ACTIVE', redemptionsToday: 0, rewardBudgetSpentToday: 0, day: singaporeDay(),
      metrics: { smartMatchShown: 0, smartMatchAccepted: 0, smartMatchPayments: 0, smartMatchSales: 0,
        sharedVouchClaims: 0, sharedVouchPayments: 0, sharedVouchSales: 0,
        directScanPayments: 0, directScanSales: 0, scans: 0, payments: 0, rewardCost: 0 }
    });
  });
  return campaigns;
}

// Returns a shallow-copied campaign with the two-week seed baseline added to its metrics.
// Used only at render time — the stored campaign stays at its true live values for test correctness.
function buildDisplayCampaign(campaign) {
  const seed = campaignSeedMetrics[campaign.merchantId] || {};
  return Object.assign({}, campaign, {
    platformFeeAccrued: campaign.platformFeeAccrued + (seed.platformFeeAccrued || 0),
    trendDays: seed.dailyPayments || [],
    metrics: {
      smartMatchShown: campaign.metrics.smartMatchShown + (seed.smartMatchShown || 0),
      smartMatchAccepted: campaign.metrics.smartMatchAccepted + (seed.smartMatchAccepted || 0),
      smartMatchPayments: campaign.metrics.smartMatchPayments + (seed.smartMatchPayments || 0),
      smartMatchSales: campaign.metrics.smartMatchSales + (seed.smartMatchSales || 0),
      sharedVouchClaims: campaign.metrics.sharedVouchClaims + (seed.sharedVouchClaims || 0),
      sharedVouchPayments: campaign.metrics.sharedVouchPayments + (seed.sharedVouchPayments || 0),
      sharedVouchSales: campaign.metrics.sharedVouchSales + (seed.sharedVouchSales || 0),
      directScanPayments: campaign.metrics.directScanPayments + (seed.directScanPayments || 0),
      directScanSales: campaign.metrics.directScanSales + (seed.directScanSales || 0),
      scans: campaign.metrics.scans + (seed.scans || 0),
      payments: campaign.metrics.payments + (seed.payments || 0),
      rewardCost: campaign.metrics.rewardCost + (seed.rewardCost || 0)
    }
  });
}

// Merchant campaigns (caps, spend, metrics) are commercial state owned by the merchant,
// not by any one visitor's browser. Kept at module scope so every session shares it.
let merchantCampaignStore = createCampaigns();

// Cross-session payment feed so the merchant results tab shows real activity.
// Capped at 200 entries; newest entries are unshifted to the front.
const merchantPaymentFeed = [
  { merchantId: 'felicia-chicken-rice', displayAmount: '$5.00', source: 'SMART_MATCH', date: '2026-09-19', time: '12:47', itemName: 'Chicken Rice' },
  { merchantId: 'felicia-chicken-rice', displayAmount: '$5.00', source: 'DIRECT_SCAN', date: '2026-09-19', time: '12:31', itemName: null },
  { merchantId: 'felicia-chicken-rice', displayAmount: '$10.50', source: 'DIRECT_SCAN', date: '2026-09-19', time: '11:58', itemName: null },
  { merchantId: 'felicia-chicken-rice', displayAmount: '$5.00', source: 'SHARED_VOUCH', date: '2026-09-19', time: '11:22', itemName: 'Chicken Rice Set' },
  { merchantId: 'felicia-chicken-rice', displayAmount: '$8.00', source: 'SMART_MATCH', date: '2026-09-19', time: '10:47', itemName: null },
  { merchantId: 'felicia-chicken-rice', displayAmount: '$5.00', source: 'DIRECT_SCAN', date: '2026-09-18', time: '13:44', itemName: null },
  { merchantId: 'felicia-chicken-rice', displayAmount: '$7.50', source: 'DIRECT_SCAN', date: '2026-09-18', time: '13:11', itemName: null },
  { merchantId: 'felicia-chicken-rice', displayAmount: '$5.00', source: 'SHARED_VOUCH', date: '2026-09-18', time: '12:55', itemName: 'Chicken Rice' },
  { merchantId: 'felicia-chicken-rice', displayAmount: '$5.00', source: 'SMART_MATCH', date: '2026-09-18', time: '12:30', itemName: 'Chicken Rice' },
  { merchantId: 'felicia-chicken-rice', displayAmount: '$6.00', source: 'DIRECT_SCAN', date: '2026-09-18', time: '12:08', itemName: null },
  { merchantId: 'green-bowl', displayAmount: '$9.20', source: 'SMART_MATCH', date: '2026-09-19', time: '13:15', itemName: 'Vegan Grain Bowl' },
  { merchantId: 'green-bowl', displayAmount: '$9.20', source: 'DIRECT_SCAN', date: '2026-09-19', time: '12:50', itemName: null },
  { merchantId: 'green-bowl', displayAmount: '$9.20', source: 'SMART_MATCH', date: '2026-09-19', time: '11:30', itemName: 'Vegan Grain Bowl' },
  { merchantId: 'green-bowl', displayAmount: '$9.20', source: 'DIRECT_SCAN', date: '2026-09-18', time: '13:00', itemName: null },
  { merchantId: 'green-bowl', displayAmount: '$9.20', source: 'SHARED_VOUCH', date: '2026-09-18', time: '12:20', itemName: 'Vegan Grain Bowl' },
  { merchantId: 'green-bowl', displayAmount: '$18.40', source: 'DIRECT_SCAN', date: '2026-09-17', time: '12:45', itemName: null },
  { merchantId: 'green-bowl', displayAmount: '$9.20', source: 'SMART_MATCH', date: '2026-09-17', time: '11:55', itemName: 'Vegan Grain Bowl' },
  { merchantId: 'green-bowl', displayAmount: '$9.20', source: 'DIRECT_SCAN', date: '2026-09-16', time: '13:05', itemName: null },
  { merchantId: 'toast-and-co', displayAmount: '$6.50', source: 'SMART_MATCH', date: '2026-09-19', time: '09:14', itemName: 'Kaya Toast Set' },
  { merchantId: 'toast-and-co', displayAmount: '$4.50', source: 'DIRECT_SCAN', date: '2026-09-19', time: '08:55', itemName: null },
  { merchantId: 'toast-and-co', displayAmount: '$6.50', source: 'DIRECT_SCAN', date: '2026-09-18', time: '09:30', itemName: null },
  { merchantId: 'toast-and-co', displayAmount: '$6.50', source: 'SHARED_VOUCH', date: '2026-09-18', time: '09:05', itemName: 'Kaya Toast Set' },
  { merchantId: 'toast-and-co', displayAmount: '$13.00', source: 'DIRECT_SCAN', date: '2026-09-17', time: '08:50', itemName: null },
  { merchantId: 'hawker-88', displayAmount: '$7.00', source: 'SMART_MATCH', date: '2026-09-19', time: '12:40', itemName: 'Char Kway Teow' },
  { merchantId: 'hawker-88', displayAmount: '$7.00', source: 'DIRECT_SCAN', date: '2026-09-18', time: '13:20', itemName: null },
  { merchantId: 'hawker-88', displayAmount: '$14.00', source: 'DIRECT_SCAN', date: '2026-09-17', time: '12:35', itemName: null },
  { merchantId: 'hawker-88', displayAmount: '$7.00', source: 'SHARED_VOUCH', date: '2026-09-16', time: '12:55', itemName: 'Char Kway Teow' },
  { merchantId: 'hawker-88', displayAmount: '$7.00', source: 'DIRECT_SCAN', date: '2026-09-15', time: '13:10', itemName: null }
];

const seedTransactions = [
  { id: 'tx-h1', source: 'DIRECT_SCAN', merchantId: 'felicia-chicken-rice', merchantName: "Felicia's Chicken Rice",
    outlet: 'RP North Food Court · Stall 08', itemName: 'Chicken Rice',
    purchaseAmount: 5.00, merchantCreditUsed: 0, netsPaid: 5.00,
    merchantRewardEarned: 0.50, cashbackAwarded: 0.50, promisedReward: 0.50,
    rewardReleased: true, status: 'Successful', collected: true, eligible: true,
    vouchDecision: 'created', vouchCreated: true,
    date: '2026-09-13', time: '12:34', displayAmount: '$5.00', paymentMethod: 'NETS' },
  { id: 'tx-h2', source: 'SMART_MATCH', merchantId: 'green-bowl', merchantName: 'Green Bowl',
    outlet: 'Republic Polytechnic · North Food Court', itemName: 'Vegan Grain Bowl',
    purchaseAmount: 9.20, merchantCreditUsed: 0, netsPaid: 9.20,
    merchantRewardEarned: 0.50, cashbackAwarded: 0.50, promisedReward: 0.50,
    rewardReleased: true, status: 'Successful', collected: true, eligible: true,
    vouchDecision: 'created', vouchCreated: true,
    date: '2026-09-12', time: '13:05', displayAmount: '$9.20', paymentMethod: 'NETS' },
  { id: 'tx-h3', source: 'DIRECT_SCAN', merchantId: 'felicia-chicken-rice', merchantName: "Felicia's Chicken Rice",
    outlet: 'RP North Food Court · Stall 08', itemName: null,
    purchaseAmount: 7.50, merchantCreditUsed: 0.50, netsPaid: 7.00,
    merchantRewardEarned: 0.50, cashbackAwarded: 0.50, promisedReward: 0.50,
    rewardReleased: true, status: 'Successful', collected: true, eligible: true,
    vouchDecision: 'not-eligible', vouchCreated: false,
    date: '2026-09-10', time: '12:11', displayAmount: '$7.00', paymentMethod: 'NETS' },
  { id: 'tx-h4', source: 'SMART_MATCH', merchantId: 'felicia-chicken-rice', merchantName: "Felicia's Chicken Rice",
    outlet: 'RP North Food Court · Stall 08', itemName: 'Chicken Rice',
    purchaseAmount: 5.00, merchantCreditUsed: 0, netsPaid: 5.00,
    merchantRewardEarned: 0.50, cashbackAwarded: 0.50, promisedReward: 0.50,
    rewardReleased: true, status: 'Successful', collected: true, eligible: true,
    vouchDecision: 'created', vouchCreated: true,
    date: '2026-09-08', time: '11:58', displayAmount: '$5.00', paymentMethod: 'NETS' },
  { id: 'tx-h5', source: 'DIRECT_SCAN', merchantId: 'green-bowl', merchantName: 'Green Bowl',
    outlet: 'Republic Polytechnic · North Food Court', itemName: null,
    purchaseAmount: 9.20, merchantCreditUsed: 0, netsPaid: 9.20,
    merchantRewardEarned: 0, cashbackAwarded: 0, promisedReward: 0,
    rewardReleased: true, status: 'Successful', collected: true, eligible: false,
    vouchDecision: 'not-eligible', vouchCreated: false,
    date: '2026-09-06', time: '12:47', displayAmount: '$9.20', paymentMethod: 'NETS' }
];

const seedPromotionalRedemptions = [
  { transactionId: 'tx-h1', merchantName: "Felicia's Chicken Rice", itemName: 'Chicken Rice', rewardAmount: 0.50, date: '2026-09-13', status: 'Redeemed' },
  { transactionId: 'tx-h2', merchantName: 'Green Bowl', itemName: 'Vegan Grain Bowl', rewardAmount: 0.50, date: '2026-09-12', status: 'Redeemed' },
  { transactionId: 'tx-h3', merchantName: "Felicia's Chicken Rice", itemName: 'In-store purchase', rewardAmount: 0.50, date: '2026-09-10', status: 'Redeemed' },
  { transactionId: 'tx-h4', merchantName: "Felicia's Chicken Rice", itemName: 'Chicken Rice', rewardAmount: 0.50, date: '2026-09-08', status: 'Redeemed' }
];

function createInitialDemo(userId) {
  const identityId = isValidDemoIdentity(userId) ? userId : 'jia';
  return {
    version: 13,
    user: { ...demoIdentities[identityId] },
    profile: { dietaryPreference: 'none', budget: 10, maxDistanceMinutes: 10, notifications: true },
    vouchCredits: {}, dailyMerchantRewards: {},
    nearbyMerchants: [], selectedMerchantId: null, selectedMerchantReason: null, recommendationAccepted: false, rejectedMerchantIds: [],
    recommendationFeedback: [], shownMerchantIds: [],
    currentScanPayment: null, activeVouchClaim: null,
    transactions: [], paymentVerifiedVouches: [], promotionalRedemptions: [],
    nextScanNumber: 1, nextTransactionNumber: 1, nextVouchNumber: 1
  };
}

function initialiseDemoSession(req) {
  if (!req.session.demo || req.session.demo.version !== 13) {
    req.session.demo = createInitialDemo('jia');
    req.session.demoUserStates = {};
  }
  if (!req.session.demoUserStates) req.session.demoUserStates = {};
}

function copyObjects(items) {
  return items.map(function(item) { return { ...item }; });
}

function getMerchantCredit(demo, merchantId) {
  return money(demo.vouchCredits[merchantId] || 0);
}

function addMerchantCredit(demo, merchantId, amount) {
  demo.vouchCredits[merchantId] = money(getMerchantCredit(demo, merchantId) + amount);
}

function useMerchantCredit(demo, merchantId, amount) {
  demo.vouchCredits[merchantId] = money(Math.max(0, getMerchantCredit(demo, merchantId) - amount));
}

function getRewardCredits(demo) {
  const credits = [];
  fallbackMerchants.forEach(function(merchant) {
    const amount = getMerchantCredit(demo, merchant.id);
    if (amount > 0) credits.push({ merchantId: merchant.id, merchantName: merchant.merchantName, amount: amount });
  });
  return credits;
}

function findMerchantById(merchantList, merchantId) {
  for (let i = 0; i < merchantList.length; i++) {
    if (merchantList[i].id === merchantId) return merchantList[i];
  }
  return null;
}

function findMerchantForDemo(demo, merchantId) {
  const nearbyMerchant = findMerchantById(demo.nearbyMerchants, merchantId);
  if (nearbyMerchant) return nearbyMerchant;
  return findMerchantById(fallbackMerchants, merchantId);
}

function findTransactionById(transactions, transactionId) {
  for (let i = 0; i < transactions.length; i++) {
    if (transactions[i].id === transactionId) return transactions[i];
  }
  return null;
}

function isValidRejectionReason(reason) {
  for (let i = 0; i < rejectionReasons.length; i++) {
    if (rejectionReasons[i].id === reason) return true;
  }
  return false;
}

function getRejectionReasonLabel(reason) {
  for (let i = 0; i < rejectionReasons.length; i++) {
    if (rejectionReasons[i].id === reason) return rejectionReasons[i].label;
  }
  return '';
}

function isValidDietaryPreference(preference) {
  for (let i = 0; i < dietaryPreferenceOptions.length; i++) {
    if (dietaryPreferenceOptions[i].value === preference) return true;
  }
  return false;
}

function isValidVouchTag(tag) {
  for (let i = 0; i < vouchTags.length; i++) {
    if (vouchTags[i].id === tag) return true;
  }
  return false;
}

function getVouchTagLabel(tag) {
  for (let i = 0; i < vouchTags.length; i++) {
    if (vouchTags[i].id === tag) return vouchTags[i].label;
  }
  return '';
}

function getDietaryPreferenceLabel(preference) {
  for (let i = 0; i < dietaryPreferenceOptions.length; i++) {
    if (dietaryPreferenceOptions[i].value === preference) {
      return dietaryPreferenceOptions[i].label;
    }
  }
  return 'No dietary restriction';
}

function merchantMatchesProfile(merchant, profile) {
  if (merchant.price !== null && merchant.price > profile.budget) return false;
  if (merchant.distanceMinutes > profile.maxDistanceMinutes) return false;
  if (profile.dietaryPreference === 'none') return true;

  for (let i = 0; i < merchant.dietary.length; i++) {
    if (merchant.dietary[i] === profile.dietaryPreference) return true;
  }
  return false;
}

function calculateDistanceMinutes(latitude, longitude) {
  const earthRadiusKm = 6371;
  const latitudeDifference = (latitude - demoLocation.latitude) * Math.PI / 180;
  const longitudeDifference = (longitude - demoLocation.longitude) * Math.PI / 180;
  const firstLatitude = demoLocation.latitude * Math.PI / 180;
  const secondLatitude = latitude * Math.PI / 180;
  const a = Math.sin(latitudeDifference / 2) * Math.sin(latitudeDifference / 2) +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) *
    Math.sin(longitudeDifference / 2) * Math.sin(longitudeDifference / 2);
  const distanceKm = earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.max(1, Math.round(distanceKm / 0.08));
}

function parseGooglePlaces(places) {
  const nearbyMerchants = [];
  if (!Array.isArray(places)) return nearbyMerchants;

  for (let i = 0; i < places.length; i++) {
    const place = places[i];
    if (!place.id || !place.displayName || !place.location) continue;
    const name = place.displayName.text;
    const category = place.primaryType || 'restaurant';
    const categoryLabel = place.primaryTypeDisplayName && place.primaryTypeDisplayName.text
      ? place.primaryTypeDisplayName.text
      : 'Nearby restaurant';
    nearbyMerchants.push({
      id: 'google-' + place.id,
      merchantId: 'google-' + place.id,
      merchantName: name,
      name: name,
      itemName: categoryLabel,
      price: null,
      category: category,
      address: place.formattedAddress || 'Near Republic Polytechnic',
      dietary: [],
      distanceMinutes: calculateDistanceMinutes(
        place.location.latitude,
        place.location.longitude
      ),
      coordinates: {
        latitude: place.location.latitude,
        longitude: place.location.longitude
      },
      source: 'google-places',
      available: !place.currentOpeningHours || place.currentOpeningHours.openNow !== false
    });
  }
  return nearbyMerchants;
}

function normaliseMerchantName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function combineMerchantLists(localMerchants, apiMerchants) {
  const combined = copyObjects(localMerchants);
  for (let i = 0; i < apiMerchants.length; i++) {
    let alreadyAdded = false;
    for (let j = 0; j < combined.length; j++) {
      if (normaliseMerchantName(combined[j].merchantName) ===
          normaliseMerchantName(apiMerchants[i].merchantName)) {
        alreadyAdded = true;
      }
    }
    if (!alreadyAdded) combined.push(apiMerchants[i]);
  }
  return combined;
}

async function getNearbyMerchants() {
  if (!process.env.PLACES_API_KEY) {
    return { merchants: copyObjects(fallbackMerchants), source: 'local-fallback' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(function() {
    controller.abort();
  }, PLACES_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.PLACES_API_KEY,
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
          'places.primaryType',
          'places.primaryTypeDisplayName',
          'places.currentOpeningHours.openNow'
        ].join(',')
      },
      body: JSON.stringify({
        includedTypes: ['restaurant'],
        maxResultCount: 10,
        rankPreference: 'DISTANCE',
        locationRestriction: {
          circle: {
            center: {
              latitude: demoLocation.latitude,
              longitude: demoLocation.longitude
            },
            radius: demoLocation.searchRadiusMetres
          }
        }
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error('Google Places request failed');
    const data = await response.json();
    const apiMerchants = parseGooglePlaces(data.places);
    if (apiMerchants.length === 0) throw new Error('Google Places returned no merchants');
    return {
      merchants: combineMerchantLists(fallbackMerchants, apiMerchants),
      source: 'google-places'
    };
  } catch (error) {
    console.log('Nearby Places unavailable. Using local demo merchants.');
    return { merchants: copyObjects(fallbackMerchants), source: 'local-fallback' };
  } finally {
    clearTimeout(timeout);
  }
}

function findCampaign(demo, merchantId) {
  for (let i = 0; i < merchantCampaignStore.length; i++) {
    const campaign = merchantCampaignStore[i];
    if (campaign.merchantId === merchantId) {
      if (campaign.day !== singaporeDay()) {
        campaign.day = singaporeDay();
        campaign.redemptionsToday = 0;
        campaign.rewardBudgetSpentToday = 0;
      }
      return campaign;
    }
  }
  return null;
}

function findCampaignForMerchant(merchant, demo) {
  if (!merchant) return null;
  const campaign = findCampaign(demo, merchant.id);
  if (!campaign || !getCampaignAvailability(campaign, false).available) return null;
  return campaign;
}

function parsePaymentAmount(value) {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) return null;
  return money(amount);
}

function wasMerchantRejected(merchantId, rejectedMerchantIds) {
  for (let i = 0; i < rejectedMerchantIds.length; i++) {
    if (rejectedMerchantIds[i] === merchantId) return true;
  }
  return false;
}

function getLastFeedback(feedbackItems) {
  if (feedbackItems.length === 0) return null;
  return feedbackItems[feedbackItems.length - 1];
}

async function getAIRanking(profile, eligible, feedbackItems) {
  const merchantSummaries = eligible.map(function(m) {
    return {
      id: m.id,
      name: m.merchantName,
      dish: m.itemName || 'menu item',
      price: m.price !== null ? '$' + m.price.toFixed(2) : 'varies',
      walk: m.distanceMinutes + ' min',
      dietary: m.dietary.length ? m.dietary.join(', ') : 'any',
      location: m.address || ''
    };
  });

  const lastFeedback = getLastFeedback(feedbackItems);
  let feedbackNote = '';
  if (lastFeedback) {
    if (lastFeedback.reason === 'too-far') {
      feedbackNote = 'The user rejected a merchant at ' + lastFeedback.distanceMinutes + ' min away as too far. Prioritise the nearest option and mention its walk time in the reason.';
    } else if (lastFeedback.reason === 'too-expensive') {
      const rejPrice = lastFeedback.price !== null ? '$' + lastFeedback.price.toFixed(2) : 'an unknown price';
      feedbackNote = 'The user rejected a merchant priced at ' + rejPrice + ' as too expensive. Prioritise the cheapest option and mention the price in the reason.';
    } else {
      feedbackNote = 'The user rejected a previous suggestion. Pick something meaningfully different.';
    }
  }

  const system = [
    'You are Smart Match, the recommendation engine in NETS Vouch AI — a Singapore payments app rewarding people for eating at local merchants.',
    'Pick the single best merchant for this user. Write a short, specific reason a real person would find useful.',
    '',
    'GOOD reasons name a concrete detail — dish, price, or walk time:',
    '  {"merchantId":"felicia-chicken-rice","reason":"Chicken Rice for $5 — closest halal option here."}',
    '  {"merchantId":"green-bowl","reason":"Vegan grain bowl, 6 min walk, well under your budget."}',
    '  {"merchantId":"felicia-chicken-rice","reason":"Much closer than your last suggestion at just 3 min."}',
    '',
    'BAD reasons are vague and must never be written:',
    '  "Best match for your preferences."  "Matches your dietary preference and budget."  "Good option for you."',
    '',
    'Reply with valid JSON only — no markdown, no extra text.'
  ].join('\n');

  const userParts = [
    'User profile:',
    '- Dietary: ' + profile.dietaryPreference,
    '- Budget: $' + profile.budget,
    '- Max walk: ' + profile.maxDistanceMinutes + ' min',
    ''
  ];
  if (feedbackNote) userParts.push(feedbackNote, '');
  userParts.push(
    'Eligible merchants:',
    JSON.stringify(merchantSummaries),
    '',
    'Output: {"merchantId":"<exact id>","reason":"<specific one sentence, max 15 words>"}'
  );
  const userMessage = userParts.join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(function() { controller.abort(); }, AI_RANKING_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system: system,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    if (!response.ok) throw new Error('Anthropic API returned ' + response.status);
    const data = await response.json();
    const parsed = JSON.parse(data.content[0].text.trim());
    if (typeof parsed.merchantId !== 'string' || typeof parsed.reason !== 'string') {
      throw new Error('AI response missing merchantId or reason');
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function getEligibleMerchants(profile, nearbyMerchants, rejectedMerchantIds, demo) {
  return nearbyMerchants.filter(function(merchant) {
    return merchant.available &&
      !wasMerchantRejected(merchant.id, rejectedMerchantIds) &&
      merchantMatchesProfile(merchant, profile) &&
      Boolean(findCampaignForMerchant(merchant, demo));
  });
}

function getFallbackRecommendation(eligible, feedbackItems, profile) {
  let bestMerchant = null;
  let bestScore = -1000;
  const lastFeedback = getLastFeedback(feedbackItems);
  for (let i = 0; i < eligible.length; i++) {
    const merchant = eligible[i];
    let score = 100 - merchant.distanceMinutes + 50;
    if (!lastFeedback && merchant.id === 'felicia-chicken-rice') score += 15;
    if (merchant.price !== null) score += Math.max(0, profile.budget - merchant.price);
    if (lastFeedback && lastFeedback.reason === 'too-far') {
      score += Math.max(0, 20 - merchant.distanceMinutes * 2);
    }
    if (lastFeedback && lastFeedback.reason === 'too-expensive' && merchant.price !== null) {
      score += Math.max(0, 20 - merchant.price);
    }
    if (lastFeedback &&
        (lastFeedback.reason === 'not-in-mood' || lastFeedback.reason === 'ate-recently') &&
        merchant.category === lastFeedback.category) {
      score -= 30;
    }
    if (score > bestScore) { bestMerchant = merchant; bestScore = score; }
  }
  return bestMerchant;
}

async function getSmartRecommendation(profile, nearbyMerchants, rejectedMerchantIds, feedbackItems, demo) {
  const eligible = getEligibleMerchants(profile, nearbyMerchants, rejectedMerchantIds, demo);
  if (eligible.length === 0) return { merchant: null, reason: null };

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const ranking = await getAIRanking(profile, eligible, feedbackItems);
      const aiMerchant = findMerchantById(eligible, ranking.merchantId);
      if (aiMerchant) return { merchant: aiMerchant, reason: ranking.reason };
    } catch (error) {
      console.log('AI ranking unavailable, using rule-based fallback:', error.message);
    }
  }

  return { merchant: getFallbackRecommendation(eligible, feedbackItems, profile), reason: null };
}

function getMatchReasons(profile, merchant, feedbackItems) {
  const reasons = [];
  const lastFeedback = getLastFeedback(feedbackItems);
  if (merchant.price !== null && merchant.price <= profile.budget) {
    reasons.push('Within your budget');
  }
  if (profile.dietaryPreference !== 'none') {
    reasons.push('Matches your dietary preference');
  }
  if (merchant.distanceMinutes <= profile.maxDistanceMinutes) {
    reasons.push('Nearby right now');
  }
  if (lastFeedback && lastFeedback.reason === 'too-far' &&
      merchant.distanceMinutes < lastFeedback.distanceMinutes) {
    reasons.push('Closer than your last match');
  }
  if (lastFeedback && lastFeedback.reason === 'too-expensive' &&
      merchant.price !== null && lastFeedback.price !== null &&
      merchant.price < lastFeedback.price) {
    reasons.push('Costs less than your last match');
  }
  if (reasons.length === 0) reasons.push('A nearby option that fits your settings');
  return reasons.slice(0, 3);
}

function getCurrentDateAndTime() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    date: now.toLocaleDateString('en-SG', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore'
    }),
    time: now.toLocaleTimeString('en-SG', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Singapore'
    })
  };
}

function getHomeGreeting() {
  const hour = Math.floor(getSingaporeMinutesNow() / 60);
  if (hour < 12) return { greeting: 'Good morning', prompt: 'Finding something nearby?' };
  if (hour < 17) return { greeting: 'Good afternoon', prompt: 'Lunch in 10 minutes?' };
  return { greeting: 'Good evening', prompt: 'Looking for a quick bite?' };
}

function timeToMinutes(timeText) {
  if (typeof timeText !== 'string') return null;
  const parts = timeText.split(':');
  if (parts.length !== 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function getSingaporeMinutesNow() {
  const parts = new Intl.DateTimeFormat('en-SG', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Singapore'
  }).formatToParts(new Date());
  let hours = 0;
  let minutes = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type === 'hour') hours = Number(parts[i].value);
    if (parts[i].type === 'minute') minutes = Number(parts[i].value);
  }
  if (hours === 24) hours = 0;
  return hours * 60 + minutes;
}

function getCampaignAvailability(campaign, alreadyRedeemed) {
  if (campaign.status !== 'ACTIVE') {
    return { code: 'UNAVAILABLE', title: 'Vouch Currently Unavailable', available: false };
  }
  const startMinutes = timeToMinutes(campaign.startTime);
  const endMinutes = timeToMinutes(campaign.endTime);
  if (startMinutes === null || endMinutes === null) {
    return { code: 'UNAVAILABLE', title: 'Vouch Currently Unavailable', available: false };
  }
  const currentMinutes = getSingaporeMinutesNow();
  let withinWindow = false;
  if (startMinutes <= endMinutes) {
    withinWindow = currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    if (currentMinutes > endMinutes) {
      return { code: 'ENDED', title: 'Campaign Ended', available: false };
    }
  } else {
    withinWindow = currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  }
  if (!withinWindow) {
    return { code: 'UNAVAILABLE', title: 'Vouch Currently Unavailable', available: false };
  }
  if (campaign.redemptionsToday >= campaign.maxRewardedPaymentsPerDay) {
    return { code: 'FULLY_REDEEMED', title: 'Fully Redeemed Today', available: false };
  }
  if (campaign.rewardBudgetSpentToday >= campaign.maxRewardBudgetPerDay) {
    return { code: 'BUDGET_REACHED', title: 'Reward Budget Reached Today', available: false };
  }
  if (alreadyRedeemed) {
    return { code: 'ALREADY_REDEEMED', title: 'Already Redeemed', available: false };
  }
  return { code: 'AVAILABLE', title: 'Vouch Available', available: true };
}

// Worst-case daily spend if every reward slot were used - illustrative only, not a profit/ROI claim.
function getMaxDailyCostEstimate(campaign) {
  const platformFee = money(campaign.maxRewardedPaymentsPerDay * campaign.platformFeePerAttributedPayment);
  return {
    rewardBudget: campaign.maxRewardBudgetPerDay,
    platformFee: platformFee,
    total: money(campaign.maxRewardBudgetPerDay + platformFee)
  };
}

// Money is calculated in cents so offsets and rewards never drift.
function money(value) { return Math.round(value * 100) / 100; }
function singaporeDay() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); }
function receiptUrl(transaction) { return '/payment-success/' + transaction.id; }
function countVouches(demo, merchantId) {
  let count = 0;
  demo.paymentVerifiedVouches.forEach(function(vouch) {
    if (vouch.merchantId === merchantId) count += 1;
  });
  return count;
}

function paymentBreakdown(merchantCredit, amount, useCredit) {
  const purchaseCents = Math.round(amount * 100);
  const maximumCashbackCents = Math.max(0, purchaseCents - 100);
  const usedCents = useCredit ? Math.min(Math.round(merchantCredit * 100), maximumCashbackCents) : 0;
  return { merchantCreditUsed: usedCents / 100, netsPaid: (purchaseCents - usedCents) / 100 };
}

function hasEarnedNormalRewardToday(demo, merchantId) {
  return demo.dailyMerchantRewards[merchantId] === singaporeDay();
}

// Both journeys use this function; the routes choose the journey explicitly.
function recordPayment(demo, journey, amount, useCashback) {
  if (journey.transactionId) return findTransactionById(demo.transactions, journey.transactionId);
  const merchantCredit = getMerchantCredit(demo, journey.merchantId);
  const breakdown = paymentBreakdown(merchantCredit, amount, useCashback);
  const date = getCurrentDateAndTime();
  const campaign = findCampaign(demo, journey.merchantId);
  const eligible = breakdown.netsPaid >= MINIMUM_ELIGIBLE_PAYMENT;
  const effectiveClaim = getEffectiveVouchClaim(demo);
  const matchingClaim = effectiveClaim && effectiveClaim.status === 'CLAIMED' &&
    effectiveClaim.merchantId === journey.merchantId &&
    effectiveClaim.senderUserId !== effectiveClaim.recipientUserId &&
    !isReferralOnCooldown(effectiveClaim.senderUserId, effectiveClaim.recipientUserId, journey.merchantId) ?
    effectiveClaim : null;
  // The acquisition channel is a fact about how this visit happened, not about reward eligibility -
  // a Direct Scan must never be counted as a Smart Match conversion just because it was also eligible.
  const acquisitionSource = matchingClaim ? 'SHARED_VOUCH' :
    journey.attributionSource === 'smart-match' ? 'SMART_MATCH' : 'DIRECT_SCAN';
  const potentialReward = matchingClaim ? matchingClaim.rewardAmount : (campaign ? campaign.rewardAmount : 0);
  const meetsMinimumSpend = Boolean(campaign) && amount >= campaign.minimumEligibleSpend;
  const withinRewardBudget = Boolean(campaign) &&
    money(campaign.rewardBudgetSpentToday + potentialReward) <= campaign.maxRewardBudgetPerDay;
  const dailyNormalRewardAvailable = matchingClaim || !hasEarnedNormalRewardToday(demo, journey.merchantId);
  const rewardEligible = eligible && campaign && meetsMinimumSpend && withinRewardBudget && dailyNormalRewardAvailable &&
    getCampaignAvailability(campaign, false).available;
  let senderReferralReward = 0;
  const remainingBudgetAfterCustomerReward = campaign ? money(
    campaign.maxRewardBudgetPerDay - campaign.rewardBudgetSpentToday - potentialReward
  ) : 0;
  if (rewardEligible && matchingClaim && campaign.senderReferralReward > 0 &&
      campaign.senderReferralReward <= remainingBudgetAfterCustomerReward) {
    senderReferralReward = campaign.senderReferralReward;
  }
  const transaction = {
    id: 'tx-' + demo.nextTransactionNumber++,
    journeyId: journey.id, source: acquisitionSource, journeySource: journey.source,
    merchantId: journey.merchantId, merchantName: journey.merchantName, outlet: journey.outlet,
    itemName: journey.source === 'smart-match' ? journey.itemName : null,
    purchaseAmount: amount, merchantCreditUsed: breakdown.merchantCreditUsed,
    cashbackUsed: breakdown.merchantCreditUsed, netsPaid: breakdown.netsPaid,
    merchantRewardEarned: 0, cashbackAwarded: 0,
    promisedReward: rewardEligible ? potentialReward : 0,
    normalDailyRewardAwarded: rewardEligible && !matchingClaim,
    rewardReleased: false, status: 'Successful', eligible: eligible,
    collected: false, vouchDecision: eligible ? 'pending' : 'not-eligible', vouchCreated: false,
    campaignId: campaign ? campaign.id : null,
    date: date.date, time: date.time, createdAt: date.iso,
    displayAmount: '$' + breakdown.netsPaid.toFixed(2), paymentMethod: 'NETS'
  };
  demo.transactions.unshift(transaction);
  merchantPaymentFeed.unshift({ merchantId: transaction.merchantId, displayAmount: transaction.displayAmount,
    source: acquisitionSource, date: date.date, time: date.time, itemName: transaction.itemName || null });
  if (merchantPaymentFeed.length > 200) merchantPaymentFeed.length = 200;
  useMerchantCredit(demo, journey.merchantId, breakdown.merchantCreditUsed);
  journey.transactionId = transaction.id;
  journey.paymentRecorded = true;
  journey.status = 'PAID';
  journey.cashbackUsed = breakdown.merchantCreditUsed;
  journey.netsPaid = breakdown.netsPaid;
  journey.vouchDecision = transaction.vouchDecision;
  if (campaign) {
    campaign.metrics.payments += 1;
    if (acquisitionSource === 'SMART_MATCH') {
      campaign.metrics.smartMatchPayments += 1;
      campaign.metrics.smartMatchSales = money(campaign.metrics.smartMatchSales + amount);
    } else if (acquisitionSource === 'SHARED_VOUCH') {
      campaign.metrics.sharedVouchPayments += 1;
      campaign.metrics.sharedVouchSales = money(campaign.metrics.sharedVouchSales + amount);
    } else {
      campaign.metrics.directScanPayments += 1;
      campaign.metrics.directScanSales = money(campaign.metrics.directScanSales + amount);
    }
    if (rewardEligible) {
      campaign.redemptionsToday += 1;
      if (!matchingClaim) demo.dailyMerchantRewards[journey.merchantId] = singaporeDay();
      // The daily reward budget genuinely caps merchant-funded spend: the customer reward and
      // any sender referral bonus both count against it, not just the payment count.
      campaign.rewardBudgetSpentToday = money(campaign.rewardBudgetSpentToday + potentialReward);
      // Illustrative campaign success fee: only Smart Match and Shared Vouch are attributed
      // acquisition channels. A Direct Scan is not a campaign conversion, so no fee applies.
      if (acquisitionSource === 'SMART_MATCH' || acquisitionSource === 'SHARED_VOUCH') {
        campaign.platformFeeAccrued = money(campaign.platformFeeAccrued + campaign.platformFeePerAttributedPayment);
      }
      if (matchingClaim) {
        matchingClaim.status = 'REDEEMED';
        matchingClaim.transactionId = transaction.id;
        recordReferralConversion(matchingClaim.senderUserId, matchingClaim.recipientUserId, journey.merchantId);
        const offer = sharedOffers.get(matchingClaim.token);
        if (offer) {
          offer.redeemed = true;
          offer.referredTransactionId = transaction.id;
          offer.senderReferralPending = senderReferralReward;
          offer.senderReferralCredited = false;
        }
        if (senderReferralReward > 0) {
          campaign.rewardBudgetSpentToday = money(campaign.rewardBudgetSpentToday + senderReferralReward);
          campaign.metrics.rewardCost = money(campaign.metrics.rewardCost + senderReferralReward);
        }
      }
    }
  }
  if (journey.source === 'scan') releaseMerchantReward(demo, transaction, journey);
  return transaction;
}

function releaseMerchantReward(demo, transaction, journey) {
  if (transaction.rewardReleased) return;
  transaction.rewardReleased = true;
  transaction.merchantRewardEarned = transaction.promisedReward;
  transaction.cashbackAwarded = transaction.merchantRewardEarned;
  journey.cashbackReleased = true;
  journey.cashbackAwarded = transaction.merchantRewardEarned;
  addMerchantCredit(demo, transaction.merchantId, transaction.merchantRewardEarned);
  if (transaction.merchantRewardEarned > 0) {
    const campaign = findCampaign(demo, transaction.merchantId);
    campaign.metrics.rewardCost = money(campaign.metrics.rewardCost + transaction.merchantRewardEarned);
    demo.promotionalRedemptions.unshift({
      transactionId: transaction.id, merchantName: transaction.merchantName,
      itemName: transaction.itemName || 'In-store purchase',
      rewardAmount: transaction.merchantRewardEarned, date: transaction.date, status: 'Redeemed'
    });
  }
}

function canVouch(transaction) {
  return transaction && transaction.status === 'Successful' && transaction.eligible &&
    transaction.journeySource === 'scan';
}

// A claim older than CLAIM_EXPIRY_MS can no longer be redeemed. Checked lazily wherever
// the claim is read, so nothing needs a background timer to expire it.
function getEffectiveVouchClaim(demo) {
  const claim = demo.activeVouchClaim;
  if (claim && claim.status === 'CLAIMED' && Date.now() > claim.expiresAt) {
    claim.status = 'EXPIRED';
  }
  return claim;
}

function setVouchDecision(demo, transaction, decision) {
  transaction.vouchDecision = decision;
  const journey = transaction.journeySource === 'scan' ? demo.currentScanPayment :
    findOrderByTransactionId(demo, transaction.id);
  if (journey && journey.transactionId === transaction.id) {
    journey.vouchDecision = decision;
    if (transaction.journeySource === 'scan') {
      journey.status = 'COMPLETE';
      if (demo.selectedMerchantId === transaction.merchantId) {
        demo.selectedMerchantId = null;
        demo.recommendationAccepted = false;
      }
    }
  }
}

function matchView(demo, recommendation) {
  return {
    recommendation: recommendation,
    campaign: recommendation ? findCampaignForMerchant(recommendation, demo) : null,
    matchReasons: recommendation ? getMatchReasons(demo.profile, recommendation, demo.recommendationFeedback) : [],
    rejectionReasons: rejectionReasons, recommendationAccepted: demo.recommendationAccepted,
    dailyRewardEarned: recommendation ? hasEarnedNormalRewardToday(demo, recommendation.id) : false,
    vouchCount: recommendation ? countVouches(demo, recommendation.id) : 0,
    dietaryTagLabel: recommendation && recommendation.dietary.length ?
      getDietaryPreferenceLabel(recommendation.dietary[recommendation.dietary.length - 1]) : null,
    aiReason: demo.selectedMerchantReason || null
  };
}

function applyPendingReferralCredits(req) {
  sharedOffers.forEach(function(offer) {
    if (offer.senderUserId === req.session.demo.user.id && offer.senderReferralPending > 0 &&
        offer.senderReferralCredited === false) {
      addMerchantCredit(req.session.demo, offer.merchantId, offer.senderReferralPending);
      offer.senderReferralCredited = true;
    }
  });
}

// Serialise requests from the same demo session, including double-clicked payments.
// Reload after waiting so two requests cannot spend the same cashback balance.
const sessionQueues = new Map();
app.use(function(req, res, next) {
  const key = req.sessionID;
  if (!sessionQueues.has(key)) sessionQueues.set(key, []);
  const queue = sessionQueues.get(key);
  queue.push(run);
  if (queue.length === 1) run();
  function run() {
    let released = false;
    function release() {
      if (released) return;
      released = true;
      queue.shift();
      if (queue.length) queue[0]();
      else sessionQueues.delete(key);
    }
    res.once('finish', release);
    req.session.reload(function() {
      initialiseDemoSession(req);
      applyPendingReferralCredits(req);
      res.locals.demoUser = req.session.demo.user;
      res.set('Cache-Control', 'no-store');
      next();
    });
  }
});

// Home and persistent Smart Match
app.get('/', function(req, res) { res.redirect('/welcome'); });
app.get('/welcome', function(req, res) { res.render('welcome'); });
app.get('/home', function(req, res) {
  const demo = req.session.demo;
  const recommendation = findMerchantForDemo(demo, demo.selectedMerchantId);
  res.render('home', {
    ...matchView(demo, recommendation), user: demo.user,
    matchingAgain: req.query.matching === 'again', homeGreeting: getHomeGreeting()
  });
});

app.get('/smart-match/result', async function(req, res) {
  const demo = req.session.demo;
  let recommendation = findMerchantForDemo(demo, demo.selectedMerchantId);
  if (!recommendation) {
    if (!demo.nearbyMerchants.length) demo.nearbyMerchants = (await getNearbyMerchants()).merchants;
    const result = await getSmartRecommendation(demo.profile, demo.nearbyMerchants,
      demo.rejectedMerchantIds, demo.recommendationFeedback, demo);
    recommendation = result.merchant;
    if (recommendation) {
      demo.selectedMerchantId = recommendation.id;
      demo.selectedMerchantReason = result.reason;
      if (!demo.shownMerchantIds.includes(recommendation.id)) {
        demo.shownMerchantIds.push(recommendation.id);
        findCampaign(demo, recommendation.id).metrics.smartMatchShown += 1;
      }
    }
  }
  if (!recommendation) return res.render('smart-match-empty', { profile: demo.profile });
  res.render('smart-match-card', matchView(demo, recommendation));
});

// Plain HTML fallback for visitors with JavaScript disabled.
app.get('/smart-match/static', async function(req, res) {
  const demo = req.session.demo;
  if (!demo.selectedMerchantId) {
    demo.nearbyMerchants = copyObjects(fallbackMerchants);
    const result = await getSmartRecommendation(demo.profile, demo.nearbyMerchants,
      demo.rejectedMerchantIds, demo.recommendationFeedback, demo);
    const merchant = result.merchant;
    if (merchant) {
      demo.selectedMerchantId = merchant.id;
      demo.selectedMerchantReason = result.reason;
      if (!demo.shownMerchantIds.includes(merchant.id)) {
        demo.shownMerchantIds.push(merchant.id);
        findCampaign(demo, merchant.id).metrics.smartMatchShown += 1;
      }
    }
  }
  res.redirect('/home');
});

app.get('/recommendation', function(req, res) { res.redirect('/home'); });
app.get('/recommendation/reject', function(req, res) { res.redirect('/home#feedback'); });
app.post('/recommendation/reject', function(req, res) {
  const demo = req.session.demo;
  const merchant = findMerchantForDemo(demo, demo.selectedMerchantId);
  if (!merchant || req.body.merchantId !== merchant.id ||
      !isValidRejectionReason(req.body.reason)) {
    if (req.get('X-Requested-With') === 'smart-match') return res.status(409).send('Refresh Home and try again.');
    return res.redirect('/home');
  }
  demo.rejectedMerchantIds.push(merchant.id);
  demo.recommendationFeedback.push({ merchantId: merchant.id, reason: req.body.reason,
    category: merchant.category, price: merchant.price, distanceMinutes: merchant.distanceMinutes });
  demo.selectedMerchantId = null;
  demo.recommendationAccepted = false;
  if (req.get('X-Requested-With') === 'smart-match') return res.sendStatus(204);
  res.redirect('/home?matching=again');
});

function restartMatch(req, res) {
  const demo = req.session.demo;
  demo.selectedMerchantId = null;
  demo.recommendationAccepted = false;
  demo.shownMerchantIds = [];
  if (req.path === '/recommendation/try-again') demo.rejectedMerchantIds = [];
  if (req.path === '/recommendation/widen-distance') {
    demo.profile.maxDistanceMinutes = Math.min(60, demo.profile.maxDistanceMinutes + 5);
  }
  res.redirect('/home');
}
app.post('/recommendation/next', restartMatch);
app.post('/recommendation/try-again', restartMatch);
app.post('/recommendation/widen-distance', restartMatch);

app.post('/recommendation/accept', function(req, res) {
  const demo = req.session.demo;
  const merchant = findMerchantForDemo(demo, demo.selectedMerchantId);
  if (!merchant || merchant.id !== req.body.merchantId ||
      !merchantMatchesProfile(merchant, demo.profile) || !findCampaignForMerchant(merchant, demo)) {
    return res.redirect('/home?error=offer');
  }
  if (!demo.recommendationAccepted) findCampaign(demo, merchant.id).metrics.smartMatchAccepted += 1;
  demo.recommendationAccepted = true;
  res.redirect('/scan');
});

// Preorder payment is retired. In-store Scan is the only payment entry.
app.get('/payment', function(req, res) { res.redirect('/scan'); });
app.post('/payment', function(req, res) { res.redirect('/scan'); });

// Standalone scan: merchant identity -> amount and cashback -> Pay.
app.get('/scan', function(req, res) {
  const demo = req.session.demo;
  const scan = demo.currentScanPayment;
  if (scan && scan.status === 'MERCHANT_FOUND') return res.redirect('/scan/payment');
  if (scan && scan.status === 'PAID') return res.redirect(receiptUrl(findTransactionById(demo.transactions, scan.transactionId)));
  const activeClaim = getEffectiveVouchClaim(demo);
  res.render('scan', { error: req.query.error === 'invalid',
    merchantId: activeClaim && activeClaim.status === 'CLAIMED' ?
      activeClaim.merchantId :
      demo.recommendationAccepted && demo.selectedMerchantId ? demo.selectedMerchantId : 'green-bowl' });
});
app.post('/scan', function(req, res) {
  const demo = req.session.demo;
  const merchantId = req.body.merchantId || 'green-bowl';
  const merchant = findMerchantById(fallbackMerchants, merchantId);
  if (!merchant || req.body.campaignId && req.body.campaignId !== merchant.id + '-campaign') {
    return res.redirect('/scan?error=invalid');
  }
  const existing = demo.currentScanPayment;
  if (existing && existing.status === 'PAID') return res.redirect('/vouch/' + existing.transactionId);
  if (existing && existing.status === 'MERCHANT_FOUND') return res.redirect('/scan/payment');
  demo.currentScanPayment = {
    id: 'scan-' + demo.nextScanNumber++, source: 'scan',
    attributionSource: demo.recommendationAccepted && demo.selectedMerchantId === merchant.id ? 'smart-match' : 'scan',
    merchantId: merchant.id, merchantName: merchant.merchantName, outlet: merchant.address,
    enteredAmount: null, status: 'MERCHANT_FOUND', transactionId: null,
    cashbackUsed: 0, netsPaid: 0, cashbackAwarded: 0, vouchDecision: 'pending'
  };
  findCampaign(demo, merchant.id).metrics.scans += 1;
  res.redirect('/scan/payment');
});
app.get('/scan/payment', function(req, res) {
  const demo = req.session.demo;
  const scan = demo.currentScanPayment;
  if (!scan || scan.status === 'COMPLETE') return res.redirect('/scan');
  if (scan.transactionId) {
    const existingTransaction = findTransactionById(demo.transactions, scan.transactionId);
    return res.redirect(receiptUrl(existingTransaction));
  }
  const claim = getEffectiveVouchClaim(demo);
  const matchingSharedClaim = claim && claim.status === 'CLAIMED' && claim.merchantId === scan.merchantId;
  res.render('payment', { journey: scan, scan: true,
    merchantCredit: getMerchantCredit(demo, scan.merchantId),
    campaign: findCampaignForMerchant(findMerchantForDemo(demo, scan.merchantId), demo),
    dailyRewardEarned: hasEarnedNormalRewardToday(demo, scan.merchantId) && !matchingSharedClaim,
    error: req.query.error === 'amount' ? 'Enter $0.01–$1,000 with no more than two decimal places.' : null });
});
app.post('/scan/payment', function(req, res) {
  const demo = req.session.demo;
  const scan = demo.currentScanPayment;
  if (!scan || req.body.journeyId !== scan.id) return res.redirect('/scan');
  if (scan.transactionId) {
    const existingTransaction = findTransactionById(demo.transactions, scan.transactionId);
    return res.redirect(receiptUrl(existingTransaction));
  }
  const amount = parsePaymentAmount(req.body.amount);
  if (amount === null) return res.redirect('/scan/payment?error=amount');
  scan.enteredAmount = amount;
  const transaction = recordPayment(demo, scan, amount, req.body.useCashback === 'on');
  res.redirect(receiptUrl(transaction));
});
app.post('/scan/cancel', function(req, res) {
  const demo = req.session.demo;
  if (demo.currentScanPayment && demo.currentScanPayment.status === 'MERCHANT_FOUND' &&
      req.body.journeyId === demo.currentScanPayment.id) demo.currentScanPayment = null;
  res.redirect('/scan');
});

// Receipts always identify a transaction, never a global latest payment.
app.get('/payment-success', function(req, res) { res.redirect('/home'); });
app.get('/payment-success/:id', function(req, res) {
  const demo = req.session.demo;
  const transaction = findTransactionById(demo.transactions, req.params.id);
  if (!transaction) return res.redirect('/home');
  res.render('payment-success', { transaction: transaction, canVouch: canVouch(transaction), vouchTags: vouchTags });
});

app.get('/order', function(req, res) { res.redirect('/home'); });
app.get('/order/state', function(req, res) { res.json({ id: null, status: null }); });
app.get('/collection', function(req, res) { res.redirect('/home'); });
app.post('/collection', function(req, res) { res.redirect('/home'); });

// Payment-Verified Vouches: one decision per transaction.
app.get('/vouch', function(req, res) { res.redirect('/home'); });
app.get('/vouch/:id', function(req, res) {
  const transaction = findTransactionById(req.session.demo.transactions, req.params.id);
  if (!canVouch(transaction) || transaction.vouchDecision === 'skipped') return res.redirect('/home');
  if (transaction.vouchDecision === 'created') return res.redirect('/vouch/' + transaction.id + '/success');
  res.render('vouch', { transaction: transaction, vouchTags: vouchTags,
    tagError: req.query.error === 'tag' });
});
app.post('/vouch/:id', function(req, res) {
  const demo = req.session.demo;
  const transaction = findTransactionById(demo.transactions, req.params.id);
  if (!canVouch(transaction)) return res.redirect('/home');
  if (transaction.vouchDecision === 'pending' && req.body.action === 'create') {
    const number = demo.nextVouchNumber++;
    const shareToken = 'vouch-' + number + '-' + Date.now().toString(36);
    const tag = isValidVouchTag(req.body.tag) ? req.body.tag : null;
    const vouch = {
      id: 'vouch-' + number, user: demo.user.name,
      merchantId: transaction.merchantId, merchantName: transaction.merchantName,
      transactionId: transaction.id, date: getCurrentDateAndTime().date,
      status: 'Completed', verifiedStatus: 'Payment-Verified (Simulated)',
      tag: tag, tagLabel: tag ? getVouchTagLabel(tag) : 'Payment-Verified', shareToken: shareToken
    };
    demo.paymentVerifiedVouches.unshift(vouch);
    const campaign = findCampaign(demo, transaction.merchantId);
    sharedOffers.set(shareToken, {
      token: shareToken, vouchId: vouch.id, ownerSessionId: req.sessionID, senderUserId: demo.user.id,
      merchantId: transaction.merchantId,
      merchantName: transaction.merchantName, user: demo.user.name, tagLabel: vouch.tagLabel,
      rewardAmount: campaign ? campaign.rewardAmount : 0.50
    });
    transaction.vouchCreated = true;
    setVouchDecision(demo, transaction, 'created');
  } else if (transaction.vouchDecision === 'pending' && req.body.action === 'skip') {
    setVouchDecision(demo, transaction, 'skipped');
  }
  if (transaction.vouchDecision === 'created') return res.redirect('/vouch/' + transaction.id + '/success');
  if (transaction.vouchDecision === 'pending') return res.redirect('/vouch/' + transaction.id);
  res.redirect('/home');
});
app.get('/vouch/:id/success', function(req, res) {
  const demo = req.session.demo;
  const transaction = findTransactionById(demo.transactions, req.params.id);
  if (!transaction || transaction.vouchDecision !== 'created') return res.redirect('/home');
  let vouch = null;
  for (let i = 0; i < demo.paymentVerifiedVouches.length; i++) {
    if (demo.paymentVerifiedVouches[i].transactionId === transaction.id) vouch = demo.paymentVerifiedVouches[i];
  }
  if (!vouch) return res.redirect('/home');
  res.render('vouch-success', { transaction: transaction, vouch: vouch,
    sharePath: '/offers/' + vouch.shareToken,
    campaign: findCampaign(demo, transaction.merchantId) });
});

// A copied Vouch link can be opened by another demo session and claimed once.
app.get('/offers/:token', function(req, res) {
  const offer = sharedOffers.get(req.params.token);
  if (!offer) return res.status(404).render('shared-offer', { offer: null, claimed: false, own: false });
  const demo = req.session.demo;
  const claim = getEffectiveVouchClaim(demo);
  const claimed = Boolean(claim && claim.vouchId === offer.vouchId);
  res.render('shared-offer', { offer: offer, claimed: claimed, claim: claim,
    own: offer.senderUserId === demo.user.id });
});
app.post('/offers/:token/claim', function(req, res) {
  const demo = req.session.demo;
  const offer = sharedOffers.get(req.params.token);
  // A person cannot refer themselves, even from a different browser/session - identity is what matters.
  if (!offer || offer.senderUserId === demo.user.id) return res.redirect('/offers/' + req.params.token);
  const campaign = findCampaign(demo, offer.merchantId);
  if (!campaign || !getCampaignAvailability(campaign, false).available) {
    return res.redirect('/offers/' + req.params.token);
  }
  const activeClaim = getEffectiveVouchClaim(demo);
  if (!activeClaim || activeClaim.vouchId !== offer.vouchId || activeClaim.status !== 'CLAIMED') {
    demo.activeVouchClaim = {
      vouchId: offer.vouchId, token: offer.token, merchantId: offer.merchantId,
      merchantName: offer.merchantName, rewardAmount: offer.rewardAmount, status: 'CLAIMED',
      senderUserId: offer.senderUserId, recipientUserId: demo.user.id,
      claimedAt: getCurrentDateAndTime().iso, expiresAt: Date.now() + CLAIM_EXPIRY_MS, transactionId: null
    };
    campaign.metrics.sharedVouchClaims += 1;
  }
  res.redirect('/offers/' + offer.token);
});
app.post('/transactions/:id/done', function(req, res) {
  const demo = req.session.demo;
  const transaction = findTransactionById(demo.transactions, req.params.id);
  if (transaction && transaction.journeySource === 'scan' && transaction.vouchDecision !== 'pending' &&
      demo.currentScanPayment && demo.currentScanPayment.transactionId === transaction.id) {
    demo.currentScanPayment.status = 'COMPLETE';
  }
  res.redirect('/home');
});

// Profile and history
app.get('/profile', function(req, res) {
  if (req.query.tab === 'vouches') return res.redirect('/profile/vouches');
  if (req.query.tab === 'transactions') return res.redirect('/profile/activity');
  const demo = req.session.demo;
  res.render('profile', { user: demo.user, profile: demo.profile,
    rewardCredits: getRewardCredits(demo), dietaryLabel: getDietaryPreferenceLabel(demo.profile.dietaryPreference) });
});
app.get('/profile/rewards', function(req, res) {
  res.render('profile-rewards', { rewardCredits: getRewardCredits(req.session.demo) });
});
app.get('/profile/preferences', function(req, res) {
  const demo = req.session.demo;
  res.render('profile-preferences', { profile: demo.profile,
    dietaryPreferenceOptions: dietaryPreferenceOptions, settingsError: req.query.error === 'invalid' });
});
app.get('/profile/vouches', function(req, res) {
  res.render('profile-vouches', { paymentVerifiedVouches: req.session.demo.paymentVerifiedVouches });
});
app.get('/profile/activity', function(req, res) {
  const live = req.session.demo.transactions;
  const display = live.length ? live : live.concat(seedTransactions);
  res.render('profile-activity', { transactions: display });
});
app.post('/profile', function(req, res) {
  const demo = req.session.demo;
  const budget = parsePaymentAmount(req.body.budget);
  const distance = Number(req.body.maxDistanceMinutes);
  if (!isValidDietaryPreference(req.body.dietaryPreference) || budget === null || budget > 100 ||
      !Number.isInteger(distance) || distance < 1 || distance > 60) {
    return res.redirect('/profile/preferences?error=invalid');
  }
  demo.profile = { dietaryPreference: req.body.dietaryPreference, budget: budget,
    maxDistanceMinutes: distance, notifications: req.body.notifications === 'on' };
  demo.selectedMerchantId = null;
  demo.recommendationAccepted = false;
  demo.rejectedMerchantIds = [];
  demo.recommendationFeedback = [];
  demo.shownMerchantIds = [];
  demo.nearbyMerchants = [];
  res.redirect('/home?matching=again');
});
app.get('/transactions/:id', function(req, res) {
  const transaction = findTransactionById(req.session.demo.transactions, req.params.id);
  if (!transaction) return res.redirect('/profile/activity');
  res.render('transaction-detail', { transaction: transaction });
});

app.get('/demo', function(req, res) {
  res.render('demo', { user: req.session.demo.user, identities: demoIdentities });
});
app.post('/demo/identity', function(req, res) {
  if (isValidDemoIdentity(req.body.userId)) {
    const currentUserId = req.session.demo.user.id;
    req.session.demoUserStates[currentUserId] = req.session.demo;
    if (!req.session.demoUserStates[req.body.userId]) {
      req.session.demoUserStates[req.body.userId] = createInitialDemo(req.body.userId);
    }
    req.session.demo = req.session.demoUserStates[req.body.userId];
  }
  res.redirect('/demo');
});

// Merchant demo: switch merchant without changing Jia's selected recommendation.
app.get('/merchant', function(req, res) {
  const demo = req.session.demo;
  const defaultId = demo.selectedMerchantId || fallbackMerchants[0].id;
  const merchant = findMerchantById(fallbackMerchants, req.query.merchantId || defaultId);
  if (!merchant) return res.redirect('/merchant');
  const campaign = findCampaign(demo, merchant.id);
  const displayCampaign = buildDisplayCampaign(campaign);
  res.render('merchant', {
    merchants: fallbackMerchants, merchant: merchant, campaign: displayCampaign,
    tab: req.query.tab === 'results' ? 'results' : 'campaign',
    availability: getCampaignAvailability(campaign, false),
    maxDailyCost: getMaxDailyCostEstimate(campaign),
    error: req.query.error === 'invalid',
    recentPayments: merchantPaymentFeed.filter(function(p) { return p.merchantId === merchant.id; }).slice(0, 12)
  });
});
app.post('/merchant/start-preparing', function(req, res) { res.redirect('/merchant'); });
app.post('/merchant/mark-ready', function(req, res) { res.redirect('/merchant'); });
app.post('/merchant/offer', function(req, res) {
  const campaign = findCampaign(req.session.demo, req.body.merchantId);
  const reward = Number(req.body.rewardAmount);
  const minimumSpend = Number(req.body.minimumEligibleSpend);
  const paymentsCap = Number(req.body.maxRewardedPaymentsPerDay);
  const budgetCap = Number(req.body.maxRewardBudgetPerDay);
  const destination = '/merchant?merchantId=' + encodeURIComponent(req.body.merchantId || '');
  if (!campaign || !Number.isFinite(reward) || reward < 0 || reward > 50 ||
      !Number.isFinite(minimumSpend) || minimumSpend < 0 || minimumSpend > 1000 ||
      !Number.isInteger(paymentsCap) || paymentsCap < 1 || paymentsCap > 1000 ||
      !Number.isFinite(budgetCap) || budgetCap < 0 || budgetCap > 100000 ||
      timeToMinutes(req.body.startTime) === null || timeToMinutes(req.body.endTime) === null) {
    return res.redirect(destination + '&error=invalid');
  }
  campaign.rewardAmount = money(reward);
  campaign.minimumEligibleSpend = money(minimumSpend);
  campaign.maxRewardedPaymentsPerDay = paymentsCap;
  campaign.maxRewardBudgetPerDay = money(budgetCap);
  campaign.startTime = req.body.startTime;
  campaign.endTime = req.body.endTime;
  campaign.status = req.body.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
  res.redirect(destination);
});
app.post('/reset-demo', function(req, res) {
  sharedOffers.forEach(function(offer, token) {
    if (offer.ownerSessionId === req.sessionID) sharedOffers.delete(token);
  });
  req.session.demo = createInitialDemo('jia');
  req.session.demoUserStates = {};
  merchantCampaignStore = createCampaigns();
  res.redirect('/home');
});

// Start server. Export the app and demo factory for local automated tests.
if (require.main === module) {
  app.listen(PORT, function() { console.log('NETS Vouch AI running on http://localhost:' + PORT); });
}
module.exports = { app: app, createInitialDemo: createInitialDemo, demoStore: demoStore,
  getMerchantCampaigns: function() { return merchantCampaignStore; },
  resetMerchantCampaigns: function() { merchantCampaignStore = createCampaigns(); },
  resetReferralCooldowns: function() { referralCooldowns.clear(); } };
