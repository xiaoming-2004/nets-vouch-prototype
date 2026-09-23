// Import packages
const express = require('express');
const session = require('express-session');
const path = require('path');
const { randomUUID } = require('node:crypto');

// Load local environment variables when a .env file exists (Node.js 22+).
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const app = express();
const PORT = process.env.PORT || 3000;
const MINIMUM_ELIGIBLE_PAYMENT = 1.00;
const PLACES_REQUEST_TIMEOUT_MS = 5000;
const AI_RANKING_TIMEOUT_MS = 8000;
// Foursquare's practical maximum results-per-request for Place Search.
const FOURSQUARE_RESULT_LIMIT = 50;
// Foursquare's dated Places API version header, matched to the manually-verified request.
const FOURSQUARE_API_VERSION = '2025-06-17';
const CLAIM_EXPIRY_MS = 20 * 60 * 1000;
const REFERRAL_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

// Configure Express
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure session
const demoStore = new session.MemoryStore();
let demoResetGeneration = 0;
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

function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

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

const moodCuisineOptions = [
  { value: 'any', label: 'Anything' },
  { value: 'rice', label: 'Rice dishes' },
  { value: 'noodles', label: 'Noodles' },
  { value: 'healthy', label: 'Healthy bowls' },
  { value: 'indian', label: 'Indian food' },
  { value: 'wraps', label: 'Wraps' }
];

const moodCategoryMap = {
  rice: ['chicken-rice'],
  noodles: ['noodles'],
  healthy: ['healthy-food'],
  indian: ['indian-food'],
  wraps: ['wraps']
};

// Keyword hints used only to interpret factual cuisine tags Foursquare actually returns
// (see parseFoursquareCuisineTags) - never used to invent a merchant's cuisine.
const moodCuisineKeywords = {
  rice: ['rice', 'chinese', 'cantonese', 'nasi'],
  noodles: ['noodle', 'noodles', 'mee', 'ramen', 'pho', 'laksa'],
  healthy: ['healthy', 'salad', 'vegetarian', 'vegan', 'bowl'],
  indian: ['indian', 'curry', 'briyani', 'biryani'],
  wraps: ['wrap', 'wraps', 'sandwich', 'western', 'burger']
};

// Cravings that mean "no real preference" - these drive Foursquare's broad query=food search
// and never produce a craving match/non-match (Issue 1).
const genericCravingPhrases = ['', 'anything', 'any', 'no preference', 'nothing particular', 'whatever', 'surprise me'];

function normaliseCravingQuery(craving) {
  return typeof craving === 'string' ? craving.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function isSpecificCraving(craving) {
  const normalized = normaliseCravingQuery(craving);
  return normalized.length > 0 && genericCravingPhrases.indexOf(normalized) === -1;
}

// Conservative hints that help recognise when Foursquare's own factual category/cuisine data
// satisfies a specific craving (e.g. a "Bakery" satisfies "bread") - the user's own words remain
// the primary signal; this only fills obvious gaps and never invents a merchant's identity.
const cravingKeywordHints = {
  bread: ['bakery', 'bread'],
  bakery: ['bakery'],
  sushi: ['sushi', 'japanese'],
  ramen: ['ramen', 'noodles', 'japanese'],
  noodles: ['noodles', 'noodle'],
  pizza: ['pizza', 'italian'],
  dessert: ['dessert', 'bakery', 'ice cream'],
  'bubble tea': ['bubble tea', 'tea', 'coffee'],
  western: ['western'],
  'chicken rice': ['chicken rice', 'rice', 'chinese'],
  coffee: ['coffee', 'cafe']
};

// Step 1 of Issue 1: tri-state, same discipline as mood/dietary matching. A generic craving (or
// none) is always UNKNOWN/neutral. A specific craving is MATCH only when the user's own words or
// a conservative hint actually appear in the merchant's factual name/category/cuisine data -
// never inferred by AI, never assumed from an unrelated merchant simply being nearby.
function getCravingMatchState(merchant, craving) {
  if (!isSpecificCraving(craving)) return MATCH_STATE.UNKNOWN;
  const normalized = normaliseCravingQuery(craving);
  const words = normalized.split(' ').filter(function(w) { return w.length > 2; });
  const tags = merchantCuisineTags(merchant);
  const haystack = (merchant.merchantName + ' ' + (merchant.itemName || '') + ' ' +
    (merchant.categoryLabel || '') + ' ' + tags.join(' ')).toLowerCase();
  const hints = cravingKeywordHints[normalized] || [];
  const directMatch = haystack.indexOf(normalized) !== -1 ||
    words.some(function(w) { return haystack.indexOf(w) !== -1; });
  const hintMatch = hints.some(function(hint) { return haystack.indexOf(hint) !== -1; });
  if (directMatch || hintMatch) return MATCH_STATE.MATCH;
  const hasFactualData = tags.length > 0 || (merchant.categoryLabel && merchant.categoryLabel !== 'Food & drink');
  return hasFactualData ? MATCH_STATE.NON_MATCH : MATCH_STATE.UNKNOWN;
}

// Conservative, explicit Foursquare category-name -> factual cuisine tag mapping. Only obvious
// factual categories are mapped; a generic "Restaurant" is deliberately left unmapped so it
// stays UNKNOWN rather than being guessed. Never infer dietary facts (halal/vegetarian/vegan)
// from a category name - those come only from parseCateringFacts-style explicit data.
const foursquareCategoryCuisineMap = {
  'chinese restaurant': 'chinese',
  'cantonese restaurant': 'chinese',
  'hong kong restaurant': 'chinese',
  'dim sum restaurant': 'chinese',
  'malay restaurant': 'malay',
  'indonesian restaurant': 'malay',
  'indian restaurant': 'indian',
  'north indian restaurant': 'indian',
  'south indian restaurant': 'indian',
  'korean restaurant': 'korean',
  'japanese restaurant': 'japanese',
  'sushi restaurant': 'japanese',
  'ramen restaurant': 'noodles',
  'noodle restaurant': 'noodles',
  'vietnamese restaurant': 'vietnamese',
  'thai restaurant': 'thai',
  'bakery': 'bakery',
  'snack place': 'snacks',
  'coffee shop': 'coffee',
  'café': 'cafe',
  'cafe': 'cafe'
};

function parseFoursquareCuisineTags(categories) {
  const tags = [];
  if (!Array.isArray(categories)) return tags;
  categories.forEach(function(category) {
    const name = category && typeof category.name === 'string' ? category.name.trim().toLowerCase() : '';
    const mapped = foursquareCategoryCuisineMap[name];
    if (mapped && tags.indexOf(mapped) === -1) tags.push(mapped);
  });
  return tags;
}

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

// Illustrative sample baseline, displayed separately from live Open House activity.
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
// The illustrative baseline is displayed separately; live metrics start at zero.
function createDemoCampaign(merchantId, participationMode) {
  return {
      id: merchantId + '-campaign', merchantId: merchantId,
      participationMode: participationMode,
      rewardAmount: 0.50, minimumEligibleSpend: 5.00,
      maxRewardedPaymentsPerDay: 20, maxRewardBudgetPerDay: 10.00,
      startTime: '00:00', endTime: '23:59',
      senderReferralReward: 0.20, platformFeePerAttributedPayment: 0.10,
      platformFeeAccrued: 0, status: 'ACTIVE', redemptionsToday: 0, rewardBudgetSpentToday: 0, day: singaporeDay(),
      metrics: { smartMatchShown: 0, smartMatchAccepted: 0, smartMatchPayments: 0, smartMatchSales: 0,
        sharedVouchClaims: 0, sharedVouchPayments: 0, sharedVouchSales: 0,
        directScanPayments: 0, directScanSales: 0, scans: 0, payments: 0, rewardCost: 0 }
    };
}

function createCampaigns() {
  const campaigns = [];
  fallbackMerchants.forEach(function(merchant) {
    campaigns.push(createDemoCampaign(merchant.id, 'LOCAL_DEMO'));
  });
  return campaigns;
}

// Merchant campaigns (caps, spend, metrics) are commercial state owned by the merchant,
// not by any one visitor's browser. Kept at module scope so every session shares it.
let merchantCampaignStore = createCampaigns();
// Public Places are only demo participants; this registry is merchant data, not user locations.
const discoveredMerchants = new Map();
function registerDemoMerchant(merchant) {
  discoveredMerchants.set(merchant.id, merchant);
  if (!merchantCampaignStore.some(function(campaign) { return campaign.merchantId === merchant.id; })) {
    merchantCampaignStore.push(createDemoCampaign(merchant.id, 'DEMO_SIMULATED'));
  }
}

// Cross-session payment feed with labelled illustrative examples and live payments.
// Capped at 200 entries; newest live entries are unshifted to the front.
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
merchantPaymentFeed.forEach(function(payment) { payment.illustrative = true; });
const initialMerchantPaymentFeed = merchantPaymentFeed.map(function(payment) { return { ...payment }; });

const seedPromotionalRedemptions = [
  { transactionId: 'tx-h1', merchantName: "Felicia's Chicken Rice", itemName: 'Chicken Rice', rewardAmount: 0.50, date: '2026-09-13', status: 'Redeemed' },
  { transactionId: 'tx-h2', merchantName: 'Green Bowl', itemName: 'Vegan Grain Bowl', rewardAmount: 0.50, date: '2026-09-12', status: 'Redeemed' },
  { transactionId: 'tx-h3', merchantName: "Felicia's Chicken Rice", itemName: 'In-store purchase', rewardAmount: 0.50, date: '2026-09-10', status: 'Redeemed' },
  { transactionId: 'tx-h4', merchantName: "Felicia's Chicken Rice", itemName: 'Chicken Rice', rewardAmount: 0.50, date: '2026-09-08', status: 'Redeemed' }
];

function createInitialDemo(userId) {
  const identityId = isValidDemoIdentity(userId) ? userId : 'jia';
  return {
    version: 16,
    user: { ...demoIdentities[identityId] },
    profile: { dietaryPreference: 'none', moodCuisine: 'any', craving: '', budget: 10, maxDistanceMinutes: 10, notifications: true },
    hasSetPreferences: false,
    vouchCredits: {}, dailyMerchantRewards: {},
    nearbyMerchants: [], selectedMerchantId: null, selectedMerchantReason: null, recommendationAccepted: false, rejectedMerchantIds: [],
    discoveryLocation: null, locationAttempted: false, nearbySource: null, nearbyRefreshAttempted: false,
    recommendationFeedback: [], shownMerchantIds: [],
    currentScanPayment: null, activeVouchClaim: null,
    transactions: [], paymentVerifiedVouches: [], promotionalRedemptions: [],
    nextScanNumber: 1, nextTransactionNumber: 1, nextVouchNumber: 1,
    processedPaymentAttempts: {}
  };
}

function initialiseDemoSession(req) {
  if (req.session.demoResetGeneration !== demoResetGeneration &&
      (req.session.demoResetGeneration !== undefined || demoResetGeneration > 0)) {
    req.session.demo = createInitialDemo('jia');
    req.session.demoUserStates = {};
  }
  req.session.demoResetGeneration = demoResetGeneration;
  if (!req.session.demo || req.session.demo.version !== 16) {
    req.session.demo = createInitialDemo('jia');
    req.session.demoUserStates = {};
  }
  if (!req.session.demoUserStates) req.session.demoUserStates = {};
  if (!req.session.demo.processedPaymentAttempts) req.session.demo.processedPaymentAttempts = {};
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
  discoveredMerchants.forEach(function(merchant) {
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
  return findMerchantById(fallbackMerchants, merchantId) || discoveredMerchants.get(merchantId) || null;
}

function findTransactionById(transactions, transactionId) {
  for (let i = 0; i < transactions.length; i++) {
    if (transactions[i].id === transactionId) return transactions[i];
  }
  return null;
}

function getOwnedTransaction(demo, transactionId) {
  const transaction = findTransactionById(demo.transactions, transactionId);
  return transaction && transaction.ownerUserId === demo.user.id ? transaction : null;
}

function isCompletedActivityTransaction(transaction) {
  return transaction && transaction.status === 'Successful' && transaction.paymentMethod === 'NETS' &&
    typeof transaction.merchantName === 'string' && transaction.merchantName.length > 0 &&
    Number.isFinite(transaction.netsPaid) && transaction.netsPaid > 0 &&
    Number.isFinite(Date.parse(transaction.createdAt));
}

function getActivityTransactions(demo) {
  return demo.transactions.filter(function(transaction) {
    return transaction && transaction.ownerUserId === demo.user.id && isCompletedActivityTransaction(transaction);
  }).sort(function(a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); });
}

function transactionNotFound(res) {
  return res.status(404).send('Payment not found');
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

function isValidMoodCuisine(value) {
  for (let i = 0; i < moodCuisineOptions.length; i++) {
    if (moodCuisineOptions[i].value === value) return true;
  }
  return false;
}

function getMoodCuisineLabel(value) {
  for (let i = 0; i < moodCuisineOptions.length; i++) {
    if (moodCuisineOptions[i].value === value) return moodCuisineOptions[i].label;
  }
  return 'Anything';
}

function sanitizeCraving(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>]/g, '').trim().slice(0, 100);
}

function merchantMatchesProfile(merchant, profile) {
  if (merchant.price !== null && merchant.price > profile.budget) return false;
  if (merchant.distanceMinutes > profile.maxDistanceMinutes) return false;
  if (profile.dietaryPreference === 'none') return true;
  // A real discovered merchant (Foursquare) does not verify dietary suitability the way the
  // curated local demo merchants do. Unknown is not a confirmed mismatch - it stays eligible.
  if (merchant.source === 'FOURSQUARE' && merchant.dietary.length === 0) return true;

  for (let i = 0; i < merchant.dietary.length; i++) {
    if (merchant.dietary[i] === profile.dietaryPreference) return true;
  }
  return false;
}

function calculateDistanceMetres(latitude, longitude, origin) {
  const earthRadiusKm = 6371;
  const latitudeDifference = (latitude - origin.latitude) * Math.PI / 180;
  const longitudeDifference = (longitude - origin.longitude) * Math.PI / 180;
  const firstLatitude = origin.latitude * Math.PI / 180;
  const secondLatitude = latitude * Math.PI / 180;
  const a = Math.sin(latitudeDifference / 2) * Math.sin(latitudeDifference / 2) +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) *
    Math.sin(longitudeDifference / 2) * Math.sin(longitudeDifference / 2);
  const distanceKm = earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(distanceKm * 1000);
}

// Factual Foursquare category names that clearly indicate a non-food place. Used only to
// exclude obvious non-food results that the `query=food` search term can still surface -
// never used to guess a merchant's cuisine.
const nonFoodCategoryKeywords = ['salon', 'spa', 'gym', 'fitness', 'hotel', 'bank', 'atm',
  'pharmacy', 'hospital', 'clinic', 'school', 'office', 'retail', 'clothing', 'electronics',
  'hardware', 'laundry', 'parking', 'gas station', 'bus stop', 'metro station', 'park',
  'playground', 'residence', 'apartment', 'real estate', 'insurance', 'lawyer', 'dentist'];
const foodCategoryKeywords = ['restaurant', 'café', 'cafe', 'coffee', 'bakery', 'dessert',
  'food', 'snack', 'diner', 'tea', 'noodle', 'bistro', 'eatery', 'grill', 'kitchen', 'hawker',
  'pizzeria', 'buffet', 'deli', 'sandwich', 'burger', 'sushi', 'ramen', 'dim sum', 'bbq',
  'steakhouse', 'bar', 'pub', 'brewery'];

// Category names are the only factual signal used - an unrecognised category is kept, not
// excluded, so a real merchant is never dropped just because our keyword list is incomplete.
function isFoursquareFoodCategory(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return true;
  const names = categories.map(function(c) {
    return c && typeof c.name === 'string' ? c.name.toLowerCase() : '';
  });
  if (names.some(function(n) { return foodCategoryKeywords.some(function(k) { return n.indexOf(k) !== -1; }); })) {
    return true;
  }
  if (names.some(function(n) { return nonFoodCategoryKeywords.some(function(k) { return n.indexOf(k) !== -1; }); })) {
    return false;
  }
  return true;
}

// Explicit container/venue categories (Part G). Deliberately does NOT include "coffee shop" or
// "café" - a coffee-shop venue is only ever treated as a container via the factual parent
// relationship below (Part H), never guessed from its category name alone.
const containerCategoryKeywords = ['food court', 'hawker centre', 'hawker center', 'shopping mall', 'market'];

function isContainerCategory(categories) {
  if (!Array.isArray(categories)) return false;
  return categories.some(function(c) {
    const name = c && typeof c.name === 'string' ? c.name.toLowerCase() : '';
    return containerCategoryKeywords.some(function(k) { return name.indexOf(k) !== -1; });
  });
}

// Obvious Singapore container venue names, matched only as whole words/phrases so a brand such
// as "The Coffee Bean & Tea Leaf" is never caught just for containing "Coffee". A "Coffee Shop"
// CATEGORY alone is deliberately not enough - many standalone cafés carry it.
const containerNamePattern = /\b(food court|food centre|food center|hawker centre|hawker center|kopitiam|coffeeshop|coffee shop)\b/i;

function isContainerName(name) {
  return typeof name === 'string' && containerNamePattern.test(name);
}

// Part F: a place is acting as a container/parent venue when some OTHER returned place names
// it as `related_places.parent`. Computed over the full raw response, since even a place that
// itself fails the food-category check still proves its parent is a container.
function identifyContainerPlaceIds(results) {
  const ids = new Set();
  if (!Array.isArray(results)) return ids;
  results.forEach(function(place) {
    const parentId = place && place.related_places && place.related_places.parent &&
      place.related_places.parent.fsq_place_id;
    if (typeof parentId === 'string' && parentId.trim()) ids.add(parentId);
  });
  return ids;
}

// Normalises a Foursquare Places Search response into Smart Match candidates. Foursquare is
// the sole broad discovery provider (Sprint 1.8/1.9) - individual merchants/stalls survive,
// but a place acting as the factual parent of other returned merchants (Part F) or carrying an
// explicit container category (Part G) is excluded so Smart Match never recommends the
// building/venue itself when real merchants inside it are available (Part I: a standalone
// restaurant/café with no parent is unaffected and remains fully eligible).
function parseFoursquareNearbyPlaces(results, origin) {
  const merchants = [];
  if (!Array.isArray(results)) return merchants;

  const containerIds = identifyContainerPlaceIds(results);
  const placeNames = new Map();
  results.forEach(function(place) {
    if (place && typeof place.fsq_place_id === 'string' && typeof place.name === 'string' && place.name.trim()) {
      placeNames.set(place.fsq_place_id, place.name.trim());
    }
  });
  const suppressed = [];

  for (let i = 0; i < results.length; i++) {
    const place = results[i];
    if (!place || typeof place.fsq_place_id !== 'string' || !place.fsq_place_id.trim() ||
        typeof place.name !== 'string' || !place.name.trim()) continue;
    if (!isFoursquareFoodCategory(place.categories)) continue;
    if (containerIds.has(place.fsq_place_id)) {
      suppressed.push({ name: place.name.trim(), reason: 'parent of another returned merchant' });
      continue;
    }
    if (isContainerCategory(place.categories)) {
      suppressed.push({ name: place.name.trim(), reason: 'container category' });
      continue;
    }
    if (isContainerName(place.name)) {
      suppressed.push({ name: place.name.trim(), reason: 'container name' });
      continue;
    }
    const geocodeMain = place.geocodes && place.geocodes.main ? place.geocodes.main : {};
    const latitude = Number.isFinite(place.latitude) ? place.latitude : Number(geocodeMain.latitude);
    const longitude = Number.isFinite(place.longitude) ? place.longitude : Number(geocodeMain.longitude);
    if (!validCoordinates(latitude, longitude)) continue;
    const name = place.name.trim();
    const distanceMetres = Number.isFinite(place.distance) && place.distance >= 0
      ? Math.round(place.distance) : calculateDistanceMetres(latitude, longitude, origin);
    const merchantId = 'foursquare-' + place.fsq_place_id;
    const parent = place.related_places && place.related_places.parent;
    // Parent name comes from the child's own related_places, or else from the factual parent
    // place returned elsewhere in the same (combined) discovery results - never guessed.
    const parentVenueName = parent && typeof parent.name === 'string' && parent.name.trim() ?
      parent.name.trim() : (parent && placeNames.get(parent.fsq_place_id)) || null;
    const address = place.location && typeof place.location.formatted_address === 'string' &&
      place.location.formatted_address.trim() ? place.location.formatted_address.trim() : 'Address unavailable';
    const categoryLabel = Array.isArray(place.categories) && place.categories[0] &&
      typeof place.categories[0].name === 'string' ? place.categories[0].name : 'Food & drink';
    merchants.push({
      id: merchantId,
      merchantId: merchantId,
      externalPlaceId: place.fsq_place_id,
      merchantName: name,
      name: name,
      itemName: null,
      price: null,
      category: 'foursquare.place',
      categoryLabel: categoryLabel,
      address: address,
      dietary: [],
      cuisineTags: parseFoursquareCuisineTags(place.categories),
      // Used only for the existing distance filter; the UI displays metres, never walking time.
      distanceMinutes: Math.max(1, Math.round(distanceMetres / 80)),
      distanceMetres: distanceMetres,
      distanceLabel: distanceMetres < 1000 ? distanceMetres + ' m away' :
        (distanceMetres / 1000).toFixed(1) + ' km away',
      coordinates: { latitude: latitude, longitude: longitude },
      source: 'FOURSQUARE', participationMode: 'DEMO_SIMULATED',
      rating: null,
      priceLevel: null,
      available: true,
      parentVenueName: parentVenueName
    });
  }
  if (suppressed.length) {
    logDiscovery('Container venues suppressed: ' + suppressed.length + '\n' +
      suppressed.map(function(s) { return '- ' + s.name + ' (' + s.reason + ')'; }).join('\n'));
  }
  // No early cap here - craving relevance and seen-history filtering need the full useful pool
  // (Sprint 1.10: "Do not cap too early"). Capping only happens later, for the AI prompt itself.
  return { merchants: merchants, containersRemoved: suppressed.length };
}

// Two entries are the same real place only when both the normalised name matches AND the
// coordinates are very close - sharing an address (e.g. two stalls in the same food court)
// must never be treated as a duplicate on its own (Step 13).
function isSameMerchant(a, b) {
  if (normaliseMerchantName(a.merchantName) !== normaliseMerchantName(b.merchantName)) return false;
  if (!a.coordinates || !b.coordinates) return false;
  return calculateDistanceMetres(a.coordinates.latitude, a.coordinates.longitude, b.coordinates) < 50;
}

// Keeps the first-seen record's identity (so rejection/campaign history stays stable) and
// fills in any gaps from the duplicate.
function mergeMerchantFacts(primary, secondary) {
  return Object.assign({}, primary, {
    cuisineTags: primary.cuisineTags && primary.cuisineTags.length ? primary.cuisineTags : secondary.cuisineTags,
    dietary: primary.dietary && primary.dietary.length ? primary.dietary : secondary.dietary,
    parentVenueName: primary.parentVenueName || secondary.parentVenueName
  });
}

function dedupeMerchantPool(merchantList) {
  const result = [];
  for (let i = 0; i < merchantList.length; i++) {
    const candidate = merchantList[i];
    const existingIndex = result.findIndex(function(m) { return isSameMerchant(m, candidate); });
    if (existingIndex === -1) { result.push(candidate); continue; }
    result[existingIndex] = mergeMerchantFacts(result[existingIndex], candidate);
  }
  return result;
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

// Minimum useful pool size before we bother with a broader fallback search (Issue 1's
// "if that produces too few useful merchant candidates, perform at most ONE broader fallback").
const MIN_CRAVING_POOL_SIZE = 5;
const DISCOVERY_CACHE_TTL_MS = 15 * 60 * 1000;
const DISCOVERY_CACHE_MAX_ENTRIES = 200;
const discoveryCache = new Map();

// Roughly 110 m latitude buckets near Singapore; query is part of the key so
// craving-specific and broad food searches never share provider results.
function discoveryCacheKey(location, query) {
  const bucket = location.latitude.toFixed(3) + ',' + location.longitude.toFixed(3);
  return bucket + '|' + query.trim().toLowerCase().replace(/\s+/g, ' ');
}

function clearDiscoveryCache() {
  discoveryCache.clear();
}

function removeExpiredDiscoveryEntries(now) {
  for (const [key, entry] of discoveryCache) {
    if (entry.expiresAt <= now) discoveryCache.delete(key);
  }
}

function cachedFoursquareResults(entry, location) {
  const results = structuredClone(entry.results);
  if (entry.latitude !== location.latitude || entry.longitude !== location.longitude) {
    // Provider distances belong to the first caller. Recalculate for this visitor
    // without mutating the shared raw discovery or any other session's results.
    results.forEach(function(place) {
      const main = place.geocodes && place.geocodes.main ? place.geocodes.main : {};
      const latitude = Number.isFinite(place.latitude) ? place.latitude : Number(main.latitude);
      const longitude = Number.isFinite(place.longitude) ? place.longitude : Number(main.longitude);
      if (validCoordinates(latitude, longitude)) {
        place.distance = calculateDistanceMetres(latitude, longitude, location);
      }
    });
  }
  return results;
}

// One Foursquare Place Search call with a given query string. Returns raw/food-filtered/
// container-removed counts alongside the merchants so callers can log and merge safely.
async function fetchFoursquarePlaces(searchLocation, query) {
  const now = Date.now();
  removeExpiredDiscoveryEntries(now);
  const cacheKey = discoveryCacheKey(searchLocation, query);
  const cached = discoveryCache.get(cacheKey);
  if (cached) {
    logDiscovery('FOURSQUARE CACHE HIT\nbucket: ' + cacheKey.split('|')[0] +
      '\nquery: ' + query + '\nage: ' + Math.floor((now - cached.createdAt) / 1000) + 's');
    const results = cachedFoursquareResults(cached, searchLocation);
    const parsed = parseFoursquareNearbyPlaces(results, searchLocation);
    return { ok: true, rawCount: results.length, results: results, merchants: parsed.merchants,
      containersRemoved: parsed.containersRemoved, note: results.length === 0 ? 'empty response' : null };
  }
  logDiscovery('FOURSQUARE CACHE MISS\nbucket: ' + cacheKey.split('|')[0] + '\nquery: ' + query);
  const controller = new AbortController();
  const timeout = setTimeout(function() { controller.abort(); }, PLACES_REQUEST_TIMEOUT_MS);
  try {
    const url = new URL('https://places-api.foursquare.com/places/search');
    url.searchParams.set('ll', searchLocation.latitude + ',' + searchLocation.longitude);
    url.searchParams.set('radius', String(demoLocation.searchRadiusMetres));
    url.searchParams.set('query', query);
    url.searchParams.set('sort', 'DISTANCE');
    url.searchParams.set('limit', String(FOURSQUARE_RESULT_LIMIT));
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + process.env.FOURSQUARE_API_KEY,
        'X-Places-Api-Version': FOURSQUARE_API_VERSION,
        'Accept': 'application/json'
      }
    });
    if (!response.ok) return { ok: false, rawCount: 0, merchants: [], containersRemoved: 0, note: 'HTTP ' + response.status };
    const data = await response.json();
    if (!data || !Array.isArray(data.results)) {
      return { ok: false, rawCount: 0, merchants: [], containersRemoved: 0, note: 'malformed response' };
    }
    const parsed = parseFoursquareNearbyPlaces(data.results, searchLocation);
    removeExpiredDiscoveryEntries(Date.now());
    if (discoveryCache.size >= DISCOVERY_CACHE_MAX_ENTRIES) {
      discoveryCache.delete(discoveryCache.keys().next().value);
    }
    const createdAt = Date.now();
    discoveryCache.set(cacheKey, { createdAt: createdAt, expiresAt: createdAt + DISCOVERY_CACHE_TTL_MS,
      latitude: searchLocation.latitude, longitude: searchLocation.longitude,
      results: structuredClone(data.results) });
    return { ok: true, rawCount: data.results.length, results: data.results, merchants: parsed.merchants,
      containersRemoved: parsed.containersRemoved, note: data.results.length === 0 ? 'empty response' : null };
  } catch (error) {
    return { ok: false, rawCount: 0, merchants: [], containersRemoved: 0,
      note: controller.signal.aborted ? 'timeout' : error.message };
  } finally {
    clearTimeout(timeout);
  }
}

// Sprint 1.8: Foursquare is now the sole broad Smart Match discovery provider - Geoapify no
// longer participates (see NETS_Vouch_Claude_Code_Handover_Clean.md sprint history). When the
// key is missing or the live call fails for any reason, the curated local demo merchants keep
// the Open House prototype working, exactly as the old Geoapify fallback used to.
// Sprint 1.10 (Issue 1): a specific craving drives the Foursquare query itself, with at most one
// broader query=food fallback if that produces too few useful candidates.
async function getNearbyMerchants(location, sessionLabel, craving) {
  const searchLocation = location && validCoordinates(location.latitude, location.longitude)
    ? location : demoLocation;
  const usingDemoLocation = searchLocation === demoLocation;
  const specificCraving = isSpecificCraving(craving);
  const normalizedCraving = normaliseCravingQuery(craving);
  const primaryQuery = specificCraving ? normalizedCraving : 'food';
  logDiscovery('SMART MATCH LOCATION\nsession: ' + (sessionLabel || 'unknown') +
    '\nlatitude: ' + searchLocation.latitude + '\nlongitude: ' + searchLocation.longitude +
    '\nsource: ' + (usingDemoLocation ? 'demo fallback (no real browser coordinates)' : 'browser') +
    '\nCraving: ' + (specificCraving ? normalizedCraving : 'none') + '\nForeground query: ' + primaryQuery);
  if (!process.env.FOURSQUARE_API_KEY) {
    logDiscovery('Foursquare fallback: key missing');
    return { merchants: copyObjects(fallbackMerchants), source: 'local-fallback' };
  }

  const primary = await fetchFoursquarePlaces(searchLocation, primaryQuery);
  if (!primary.ok) {
    logDiscovery('Foursquare fallback: ' + primary.note);
    return { merchants: copyObjects(fallbackMerchants), source: 'local-fallback' };
  }

  let apiMerchants = dedupeMerchantPool(primary.merchants);
  let fallbackUsed = false;
  let fallbackRawCount = 0;
  let containersRemoved = primary.containersRemoved;
  if (specificCraving && apiMerchants.length < MIN_CRAVING_POOL_SIZE) {
    const fallback = await fetchFoursquarePlaces(searchLocation, 'food');
    fallbackUsed = true;
    if (fallback.ok) {
      fallbackRawCount = fallback.rawCount;
      // Container suppression must see BOTH responses: a parent returned only by one query is
      // still a container if its child stall was returned by the other. Merge the raw places
      // (first occurrence wins) and parse once, rather than merging two finalised pools.
      const seenPlaceIds = new Set();
      const combinedResults = primary.results.concat(fallback.results).filter(function(place) {
        const id = place && place.fsq_place_id;
        if (typeof id !== 'string' || seenPlaceIds.has(id)) return false;
        seenPlaceIds.add(id);
        return true;
      });
      const combined = parseFoursquareNearbyPlaces(combinedResults, searchLocation);
      containersRemoved = combined.containersRemoved;
      apiMerchants = dedupeMerchantPool(combined.merchants);
    }
  }

  logDiscovery('FOURSQUARE DISCOVERY\nPrimary raw results: ' + primary.rawCount +
    '\nFallback food query used: ' + (fallbackUsed ? 'yes (' + fallbackRawCount + ' raw)' : 'no') +
    '\ncontainer venues removed: ' + containersRemoved +
    '\nMerchant pool: ' + apiMerchants.length);
  if (apiMerchants.length === 0) {
    logDiscovery('Foursquare fallback: zero usable food merchants');
    return { merchants: copyObjects(fallbackMerchants), source: 'local-fallback' };
  }
  apiMerchants.forEach(registerDemoMerchant);
  return {
    merchants: usingDemoLocation ? combineMerchantLists(fallbackMerchants, apiMerchants) : apiMerchants,
    source: 'foursquare'
  };
}

// Called at most once per recommendation cycle when the current nearby batch is exhausted.
// Returns true only if the fresh discovery produced merchants not already in the current batch.
async function refreshNearbyBatch(demo) {
  const nearby = await getNearbyMerchants(demo.discoveryLocation, demo.user.id, demo.profile.craving);
  const newMerchants = nearby.merchants.filter(function(merchant) {
    return !findMerchantById(demo.nearbyMerchants, merchant.id);
  });
  logDiscovery('Smart Match batch refresh: ' + newMerchants.length + ' new merchant(s)');
  if (newMerchants.length === 0) return false;
  demo.nearbyMerchants = demo.nearbyMerchants.concat(newMerchants);
  return true;
}

function logDiscovery(message) {
  if (process.env.NODE_ENV !== 'production') console.info(message);
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

async function getAIRanking(profile, eligible, feedbackItems, demo) {
  const merchantSummaries = eligible.map(function(m) {
    return {
      id: m.id,
      name: m.merchantName,
      insideFoodCourt: m.parentVenueName || null,
      dish: m.itemName || 'unknown',
      price: m.price !== null ? '$' + m.price.toFixed(2) : 'unknown',
      distance: m.distanceLabel || m.distanceMinutes + ' min walk (demo estimate)',
      distanceMetres: Number.isFinite(m.distanceMetres) ? m.distanceMetres : null,
      cuisine: merchantCuisineTags(m).length ? merchantCuisineTags(m).join(', ') : 'unknown',
      dietary: m.dietary.length ? m.dietary.join(', ') : 'unknown',
      matchesCurrentMood: merchantMatchesMood(m, profile.moodCuisine),
      matchesDietaryPreference: profile.dietaryPreference !== 'none' &&
        m.dietary.indexOf(profile.dietaryPreference) !== -1,
      cravingMatch: matchStateLabel(getCravingMatchState(m, profile.craving)),
      location: m.address || ''
    };
  });

  const lastFeedback = getLastFeedback(feedbackItems);
  let feedbackNote = '';
  if (lastFeedback) {
    if (lastFeedback.reason === 'too-far') {
      feedbackNote = 'The user rejected a merchant at ' +
        (lastFeedback.distanceLabel || lastFeedback.distanceMinutes + ' min away') +
        ' as too far. Prioritise a nearer option; do not invent a walking time.';
    } else if (lastFeedback.reason === 'too-expensive') {
      const rejPrice = lastFeedback.price !== null ? '$' + lastFeedback.price.toFixed(2) : 'an unknown price';
      feedbackNote = 'The user rejected a merchant priced at ' + rejPrice + ' as too expensive. Prioritise the cheapest option and mention the price in the reason.';
    } else {
      feedbackNote = 'The user rejected a previous suggestion. Pick something meaningfully different.';
    }
  }

  const system = [
    'You are Smart Match, the recommendation engine in NETS Vouch AI — a Singapore payments app rewarding people for eating at local merchants.',
    'Pick the single best merchant for this user from the supplied "Eligible merchants" list only. Write a short, specific reason a real person would find useful.',
    'Only use supplied facts. Unknown dietary suitability, cuisine, exact prices, menu items and walking times must not be inferred.',
    '',
    'Weigh signals in this order: (1) cravingMatch === "match" when the user gave a specific craving, (2) matchesDietaryPreference, (3) matchesCurrentMood, (4) distanceMetres - a candidate materially nearer than the others should usually win unless another candidate clearly matches the craving/preference and this one does not.',
    'cravingMatch is "unknown" whenever the merchant\'s factual data does not confirm or rule out the craving - treat "unknown" exactly like "non-match": never pick it AS the reason for the match, and never claim a merchant satisfies the craving unless cravingMatch is literally "match". A near merchant with cravingMatch "unknown" must not be described as matching the craving.',
    'A far generic merchant must not casually outrank a much nearer merchant that already matches the craving/mood/preference. matchesCurrentMood/matchesDietaryPreference being false is neutral, not a confirmed mismatch - never say a merchant "doesn\'t match" because a field is unknown.',
    'When insideFoodCourt is set, the candidate is a specific stall inside that food court - recommend the stall, not the food court name.',
    '',
    'GOOD reasons name a concrete supplied detail, such as cuisine, matchesCurrentMood, or straight-line distance.',
    'For discovered places, do not turn straight-line distance into a walking time.',
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
    '- Food mood today: ' + (profile.moodCuisine && profile.moodCuisine !== 'any' ? getMoodCuisineLabel(profile.moodCuisine) : 'no preference'),
    ''
  ];
  if (profile.craving) userParts.splice(userParts.length - 1, 0, '- Specific craving: ' + profile.craving);
  if (feedbackNote) userParts.push(feedbackNote, '');
  const recentPayments = [];
  for (let i = 0; i < demo.transactions.length && recentPayments.length < 3; i++) {
    const transaction = demo.transactions[i];
    if (transaction.ownerUserId === demo.user.id && transaction.status === 'Successful') {
      recentPayments.push({ merchant: transaction.merchantName,
        outcome: transaction.source === 'SMART_MATCH' ? 'recommended, accepted, payment completed' : 'payment completed' });
    }
  }
  if (recentPayments.length) userParts.push('Recent completed-payment outcomes:', JSON.stringify(recentPayments), '');
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
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 100,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMessage }
        ]
      })
    });
    if (!response.ok) throw new Error('OpenAI API returned ' + response.status);
    const data = await response.json();
    let aiContent = data.choices[0].message.content.trim();
    aiContent = aiContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(aiContent);
    if (typeof parsed.merchantId !== 'string' || typeof parsed.reason !== 'string' ||
        !parsed.reason.trim() || parsed.reason.trim().length > 160 || /[\r\n<>]/.test(parsed.reason)) {
      throw new Error('AI response missing merchantId or reason');
    }
    return { merchantId: parsed.merchantId, reason: parsed.reason.trim() };
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

// Real metres give far more meaningful resolution than the derived walking-minute bucket -
// e.g. two food court stalls 180m and 650m apart both round to a handful of minutes.
// Local demo merchants only carry distanceMinutes, so they keep the original coarse scale.
function distancePenalty(merchant) {
  return Number.isFinite(merchant.distanceMetres) ? merchant.distanceMetres / 20 : merchant.distanceMinutes;
}

function merchantDistanceMetres(merchant) {
  return Number.isFinite(merchant.distanceMetres) ? merchant.distanceMetres : merchant.distanceMinutes * 80;
}

function merchantCuisineTags(merchant) {
  return Array.isArray(merchant.cuisineTags) ? merchant.cuisineTags : [];
}

// Step 4: every factual comparison distinguishes MATCH / NON_MATCH / UNKNOWN - unknown data
// must never collapse into a mismatch.
const MATCH_STATE = { MATCH: 'match', NON_MATCH: 'non-match', UNKNOWN: 'unknown' };

// All local-demo categories that moodCategoryMap actually maps to. A merchant carrying one of
// these has a definite, known cuisine - if it isn't the requested mood's category, that is a
// confirmed non-match, not an unknown.
const knownSpecificCategories = Object.keys(moodCategoryMap).reduce(function(list, mood) {
  return list.concat(moodCategoryMap[mood]);
}, []);

function getMoodMatchState(merchant, moodCuisine) {
  if (!moodCuisine || moodCuisine === 'any') return MATCH_STATE.UNKNOWN;
  const moodCats = moodCategoryMap[moodCuisine] || [];
  if (moodCats.indexOf(merchant.category) !== -1) return MATCH_STATE.MATCH;
  const keywords = moodCuisineKeywords[moodCuisine] || [];
  const tags = merchantCuisineTags(merchant);
  if (tags.some(function(tag) { return keywords.indexOf(tag) !== -1; })) return MATCH_STATE.MATCH;
  const hasKnownCuisine = tags.length > 0 || knownSpecificCategories.indexOf(merchant.category) !== -1;
  return hasKnownCuisine ? MATCH_STATE.NON_MATCH : MATCH_STATE.UNKNOWN;
}

function getDietaryMatchState(merchant, dietaryPreference) {
  if (!dietaryPreference || dietaryPreference === 'none') return MATCH_STATE.UNKNOWN;
  if (merchant.dietary.indexOf(dietaryPreference) !== -1) return MATCH_STATE.MATCH;
  return merchant.dietary.length > 0 ? MATCH_STATE.NON_MATCH : MATCH_STATE.UNKNOWN;
}

// Kept for the "Why this match" copy, which only needs a yes/no.
function merchantMatchesMood(merchant, moodCuisine) {
  return getMoodMatchState(merchant, moodCuisine) === MATCH_STATE.MATCH;
}

// Step 5-9: a rejection reason with an obvious deterministic meaning must actually constrain
// the next candidate pool, not just nudge a score. Only "too-far" has a hard, unambiguous
// meaning (strictly closer than the rejected merchant); the others stay soft/scoring signals
// because "cheaper"/"different cuisine" cannot be enforced without risking a fabricated
// comparison against unknown data.
function applyDeterministicRejectionConstraint(eligible, lastFeedback) {
  if (!lastFeedback || lastFeedback.reason !== 'too-far') {
    return { candidates: eligible, noCloserMatch: false };
  }
  const rejectedMetres = Number.isFinite(lastFeedback.distanceMetres) ? lastFeedback.distanceMetres :
    Number.isFinite(lastFeedback.distanceMinutes) ? lastFeedback.distanceMinutes * 80 : null;
  if (rejectedMetres === null) return { candidates: eligible, noCloserMatch: false };
  const closer = eligible.filter(function(merchant) { return merchantDistanceMetres(merchant) < rejectedMetres; });
  return { candidates: closer, noCloserMatch: closer.length === 0 };
}

function getFallbackRecommendation(candidates, feedbackItems, profile) {
  let bestMerchant = null;
  let bestScore = -1000;
  const lastFeedback = getLastFeedback(feedbackItems);
  for (let i = 0; i < candidates.length; i++) {
    const merchant = candidates[i];
    // Proximity: a HIGH-priority signal (Step 10/12), not merely decorative context.
    let score = 150 - distancePenalty(merchant);
    if (!lastFeedback && merchant.id === 'felicia-chicken-rice') score += 15;
    if (merchant.price !== null) score += Math.max(0, profile.budget - merchant.price);
    // Issue 1: a specific craving is the strongest ranking signal - a factual match must not be
    // casually outranked by a merely-closer unrelated merchant. Unknown/non-match stays neutral.
    if (getCravingMatchState(merchant, profile.craving) === MATCH_STATE.MATCH) score += 100;
    // Explicit factual preference match only - unknown/non-match dietary data stays neutral.
    if (getDietaryMatchState(merchant, profile.dietaryPreference) === MATCH_STATE.MATCH) score += 35;
    // Current mood outranks historical preference for this session (Step 11), but only when the
    // user hasn't already given a more specific craving this cycle.
    if (!isSpecificCraving(profile.craving) && getMoodMatchState(merchant, profile.moodCuisine) === MATCH_STATE.MATCH) {
      score += 45;
    }
    if (lastFeedback && lastFeedback.reason === 'too-far') {
      // The hard constraint already removed farther merchants; this only orders what remains.
      score += Math.max(0, 40 - distancePenalty(merchant));
    }
    if (lastFeedback && lastFeedback.reason === 'too-expensive' && merchant.price !== null &&
        lastFeedback.price !== null) {
      score += Math.max(0, 20 - merchant.price);
    }
    if (lastFeedback && (lastFeedback.reason === 'not-in-mood' || lastFeedback.reason === 'ate-recently')) {
      // Foursquare's generic internal category ('foursquare.place') is not cuisine-specific, so a
      // category match there is meaningless - only a specific local-demo category (e.g.
      // 'chicken-rice') or an actual shared factual cuisine tag counts as "the same thing again".
      const sameSpecificCategory = merchant.category === lastFeedback.category &&
        knownSpecificCategories.indexOf(merchant.category) !== -1;
      const rejectedTags = Array.isArray(lastFeedback.cuisineTags) ? lastFeedback.cuisineTags : [];
      const overlapsCuisine = rejectedTags.length > 0 &&
        merchantCuisineTags(merchant).some(function(tag) { return rejectedTags.indexOf(tag) !== -1; });
      if (sameSpecificCategory || overlapsCuisine) score -= 30;
    }
    if (score > bestScore) { bestMerchant = merchant; bestScore = score; }
  }
  return bestMerchant;
}

function matchStateLabel(state) {
  return state === MATCH_STATE.MATCH ? 'true' : state === MATCH_STATE.NON_MATCH ? 'false' : 'unknown';
}

// Step 1: development-only visibility into what Smart Match actually ranked. Never runs in
// production and never prints API keys or payment data.
function logSmartMatchDebug(profile, feedbackItems, candidates, noCloserMatch, excludedCount, recycled) {
  if (process.env.NODE_ENV === 'production') return;
  const lastFeedback = getLastFeedback(feedbackItems);
  const lines = ['=== SMART MATCH DEBUG ==='];
  lines.push('Preferences: dietary=' + profile.dietaryPreference + ', mood=' + (profile.moodCuisine || 'any') +
    ', craving=' + (profile.craving || 'none'));
  lines.push('Previously shown/rejected excluded: ' + excludedCount + (recycled ? ' (pool exhausted - recycling oldest-shown)' : ''));
  const cravingMatches = isSpecificCraving(profile.craving) ?
    candidates.filter(function(m) { return getCravingMatchState(m, profile.craving) === MATCH_STATE.MATCH; }).length : null;
  if (cravingMatches !== null) lines.push('Craving matches: ' + cravingMatches);
  lines.push('Eligible candidates: ' + candidates.length);
  lines.push('Last rejection: ' + (lastFeedback ?
    lastFeedback.reason + ' (' + (lastFeedback.merchantId || 'unknown') + ')' : 'none'));
  if (noCloserMatch) lines.push('Too-far constraint: no eligible candidate is closer than the rejected merchant');
  candidates.slice(0, 10).forEach(function(m, index) {
    lines.push((index + 1) + '. ' + m.merchantName + ' [' + m.id + '] distanceMetres=' +
      merchantDistanceMetres(m) + ' category=' + m.category +
      ' cuisineTags=' + JSON.stringify(merchantCuisineTags(m)) +
      ' dietary=' + JSON.stringify(m.dietary) +
      ' parentVenue=' + (m.parentVenueName || 'none') +
      ' preferenceMatch=' + matchStateLabel(getDietaryMatchState(m, profile.dietaryPreference)) +
      ' moodMatch=' + matchStateLabel(getMoodMatchState(m, profile.moodCuisine)) +
      ' cravingMatch=' + matchStateLabel(getCravingMatchState(m, profile.craving)));
  });
  logDiscovery(lines.join('\n'));
}

// Bounds the AI prompt's candidate list only - never the deterministic eligible pool itself
// (Sprint 1.10: "only cap where necessary for AI prompt/token size AFTER deterministic
// filtering"). Craving matches are kept first, then nearest distance.
function capCandidatesForPrompt(candidates, profile, limit) {
  if (candidates.length <= limit) return candidates;
  const scored = candidates.map(function(m) {
    const cravingBonus = getCravingMatchState(m, profile.craving) === MATCH_STATE.MATCH ? 1000000 : 0;
    return { m: m, key: cravingBonus - merchantDistanceMetres(m) };
  });
  scored.sort(function(a, b) { return b.key - a.key; });
  return scored.slice(0, limit).map(function(s) { return s.m; });
}
const AI_PROMPT_CANDIDATE_LIMIT = 20;

async function getSmartRecommendation(profile, nearbyMerchants, rejectedMerchantIds, feedbackItems, demo, shownMerchantIds) {
  const shown = shownMerchantIds || [];
  // A merchant is excluded once it has been shown OR rejected - shown alone already prevents an
  // immediate repeat even outside an explicit rejection (Issue 3).
  const excludedIds = rejectedMerchantIds.concat(
    shown.filter(function(id) { return rejectedMerchantIds.indexOf(id) === -1; }));
  let eligible = getEligibleMerchants(profile, nearbyMerchants, excludedIds, demo);
  let recycled = false;
  // Pool exhaustion: only when there are truly no unseen eligible merchants left do we allow a
  // previously-shown (but never the just-rejected) merchant back in, preferring the one shown
  // longest ago so normal usage never bounces between the same 2-3 merchants.
  if (eligible.length === 0 && shown.length > 0) {
    // Every shown merchant may well have already been rejected too (that's the whole point of
    // "pool exhausted") - the only merchant that must stay excluded here is the one JUST
    // rejected, not the entire rejection history.
    const justRejectedId = rejectedMerchantIds.length ? rejectedMerchantIds[rejectedMerchantIds.length - 1] : null;
    const recyclable = nearbyMerchants.filter(function(m) {
      return m.available && m.id !== justRejectedId &&
        shown.indexOf(m.id) !== -1 && merchantMatchesProfile(m, profile) && Boolean(findCampaignForMerchant(m, demo));
    });
    recyclable.sort(function(a, b) { return shown.indexOf(a.id) - shown.indexOf(b.id); });
    if (recyclable.length > 0) { eligible = recyclable; recycled = true; }
  }
  if (eligible.length === 0) return { merchant: null, reason: null, noCloserMatch: false };

  const lastFeedback = getLastFeedback(feedbackItems);
  const constraint = applyDeterministicRejectionConstraint(eligible, lastFeedback);
  const candidates = constraint.candidates;
  logSmartMatchDebug(profile, feedbackItems, candidates, constraint.noCloserMatch, excludedIds.length, recycled);
  if (candidates.length === 0) return { merchant: null, reason: null, noCloserMatch: constraint.noCloserMatch };

  // Step 13/14: AI only ever sees the deterministically-constrained subset, and its choice is
  // validated against that same subset - it cannot resurrect a merchant the "too far" rule or
  // the seen/rejected history removed.
  if (process.env.OPENAI_API_KEY) {
    try {
      const promptCandidates = capCandidatesForPrompt(candidates, profile, AI_PROMPT_CANDIDATE_LIMIT);
      const ranking = await getAIRanking(profile, promptCandidates, feedbackItems, demo);
      const aiMerchant = findMerchantById(candidates, ranking.merchantId);
      if (aiMerchant) {
        logDiscovery('Selection source: OPENAI -> ' + aiMerchant.merchantName);
        return { merchant: aiMerchant, reason: ranking.reason, noCloserMatch: false };
      }
    } catch (error) {
      console.log('AI ranking unavailable, using rule-based fallback:', error.message);
    }
  }

  // Step 15: fallback ranks the identical constrained subset - never a superset AI would have seen.
  const fallbackMerchant = getFallbackRecommendation(candidates, feedbackItems, profile);
  logDiscovery('Selection source: FALLBACK -> ' + (fallbackMerchant ? fallbackMerchant.merchantName : 'none'));
  return { merchant: fallbackMerchant, reason: null, noCloserMatch: false };
}

function getMatchReasons(profile, merchant, feedbackItems) {
  const reasons = [];
  const lastFeedback = getLastFeedback(feedbackItems);
  if (merchant.price !== null && merchant.price <= profile.budget) {
    reasons.push('Within your budget');
  }
  if (profile.dietaryPreference !== 'none' && merchant.dietary.includes(profile.dietaryPreference)) {
    reasons.push('Matches your dietary preference');
  }
  if (merchantMatchesMood(merchant, profile.moodCuisine)) {
    reasons.push('Matches your mood today');
  }
  if (merchant.distanceMinutes <= profile.maxDistanceMinutes) {
    reasons.push('Nearby right now');
  }
  if (lastFeedback && lastFeedback.reason === 'too-far' &&
      merchantDistanceMetres(merchant) < merchantDistanceMetres(lastFeedback)) {
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
  if (journey.transactionId) return getOwnedTransaction(demo, journey.transactionId);
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
    id: 'tx-' + randomUUID(), ownerUserId: demo.user.id,
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
  demo.processedPaymentAttempts[journey.id] = transaction.id;
  merchantPaymentFeed.unshift({ merchantId: transaction.merchantId, displayAmount: transaction.displayAmount,
    source: acquisitionSource, date: date.date, time: date.time, itemName: transaction.itemName || null,
    illustrative: false });
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
    locationNotice: !demo.discoveryLocation,
    campaign: recommendation ? findCampaignForMerchant(recommendation, demo) : null,
    matchReasons: recommendation ? getMatchReasons(demo.profile, recommendation, demo.recommendationFeedback) : [],
    rejectionReasons: rejectionReasons, recommendationAccepted: demo.recommendationAccepted,
    dailyRewardEarned: recommendation ? hasEarnedNormalRewardToday(demo, recommendation.id) : false,
    vouchCount: recommendation ? countVouches(demo, recommendation.id) : 0,
    dietaryTagLabel: recommendation && recommendation.dietary.length ?
      getDietaryPreferenceLabel(recommendation.dietary[recommendation.dietary.length - 1]) : null,
    aiReason: demo.selectedMerchantReason || null,
    profile: demo.profile,
    dietaryLabel: getDietaryPreferenceLabel(demo.profile.dietaryPreference),
    dietaryPreferenceOptions: dietaryPreferenceOptions,
    moodCuisineLabel: getMoodCuisineLabel(demo.profile.moodCuisine || 'any'),
    moodCuisineOptions: moodCuisineOptions
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
    matchingAgain: req.query.matching === 'again', resetComplete: req.query.reset === 'done',
    homeGreeting: getHomeGreeting(),
    showOnboarding: !demo.hasSetPreferences, locationAttempted: demo.locationAttempted
  });
});

app.post('/setup-preferences', function(req, res) {
  const demo = req.session.demo;
  const mood = req.body.moodCuisine || 'any';
  const dietary = req.body.dietaryPreference || 'none';
  if (isValidMoodCuisine(mood)) demo.profile.moodCuisine = mood;
  if (isValidDietaryPreference(dietary)) demo.profile.dietaryPreference = dietary;
  demo.profile.craving = sanitizeCraving(req.body.craving);
  demo.hasSetPreferences = true;
  demo.selectedMerchantId = null;
  demo.recommendationAccepted = false;
  demo.nearbyMerchants = [];
  demo.nearbyRefreshAttempted = false;
  // A new Smart Match discovery re-acquires current GPS rather than depending on a stale
  // coordinate (Part C) - harmless here since this is normally the first-ever discovery anyway.
  demo.locationAttempted = false;
  res.redirect('/home');
});

// Browser location is kept only in this demo session for the current discovery journey.
app.post('/smart-match/location', function(req, res) {
  const demo = req.session.demo;
  if (req.body.status === 'fallback') {
    demo.discoveryLocation = null;
    logDiscovery('Smart Match location source: demo fallback');
  } else if (validCoordinates(req.body.latitude, req.body.longitude)) {
    demo.discoveryLocation = { latitude: req.body.latitude, longitude: req.body.longitude };
    logDiscovery('Smart Match location source: browser');
  } else {
    return res.sendStatus(400);
  }
  demo.locationAttempted = true;
  demo.nearbyMerchants = [];
  demo.nearbySource = null;
  demo.nearbyRefreshAttempted = false;
  if (!demo.recommendationAccepted) {
    demo.selectedMerchantId = null;
    demo.selectedMerchantReason = null;
  }
  res.sendStatus(204);
});

app.get('/smart-match/result', async function(req, res) {
  try {
    const demo = req.session.demo;
    let recommendation = findMerchantForDemo(demo, demo.selectedMerchantId);
    if (!recommendation) {
      if (!demo.nearbyMerchants.length) {
        const nearby = await getNearbyMerchants(demo.discoveryLocation, demo.user.id, demo.profile.craving);
        demo.nearbyMerchants = nearby.merchants;
        demo.nearbySource = nearby.source;
        logDiscovery('Smart Match merchant source: ' +
          (nearby.source === 'foursquare' ? 'FOURSQUARE' : 'LOCAL_FALLBACK'));
      }
      let result = await getSmartRecommendation(demo.profile, demo.nearbyMerchants,
        demo.rejectedMerchantIds, demo.recommendationFeedback, demo, demo.shownMerchantIds);
      recommendation = result.merchant;
      // A "too far" rejection with no closer candidate is a deterministic outcome, not a
      // genuine batch exhaustion - never silently re-query Foursquare to paper over it (Step 6).
      if (!recommendation && !result.noCloserMatch && !demo.nearbyRefreshAttempted) {
        demo.nearbyRefreshAttempted = true;
        const gotNewMerchants = await refreshNearbyBatch(demo);
        if (gotNewMerchants) {
          result = await getSmartRecommendation(demo.profile, demo.nearbyMerchants,
            demo.rejectedMerchantIds, demo.recommendationFeedback, demo, demo.shownMerchantIds);
          recommendation = result.merchant;
        }
      }
      if (recommendation) {
        demo.selectedMerchantId = recommendation.id;
        demo.selectedMerchantReason = result.reason;
        if (!demo.shownMerchantIds.includes(recommendation.id)) {
          demo.shownMerchantIds.push(recommendation.id);
          const c = findCampaign(demo, recommendation.id);
          if (c) c.metrics.smartMatchShown += 1;
        }
      }
      if (!recommendation && result.noCloserMatch) {
        return res.render('smart-match-empty', { profile: demo.profile,
          dietaryPreferenceOptions: dietaryPreferenceOptions, moodCuisineOptions: moodCuisineOptions,
          dietaryLabel: getDietaryPreferenceLabel(demo.profile.dietaryPreference),
          locationNotice: !demo.discoveryLocation, noCloserMatch: true });
      }
    }
    if (!recommendation) return res.render('smart-match-empty', { profile: demo.profile,
      dietaryPreferenceOptions: dietaryPreferenceOptions, moodCuisineOptions: moodCuisineOptions,
      dietaryLabel: getDietaryPreferenceLabel(demo.profile.dietaryPreference),
      locationNotice: !demo.discoveryLocation, noCloserMatch: false });
    res.render('smart-match-card', matchView(demo, recommendation));
  } catch (err) {
    console.error('smart-match/result error:', err);
    res.status(500).send('<p>Smart Match unavailable — <a href="/home">return home</a></p>');
  }
});

// Plain HTML fallback for visitors with JavaScript disabled.
app.get('/smart-match/static', async function(req, res) {
  const demo = req.session.demo;
  if (!demo.selectedMerchantId) {
    demo.nearbyMerchants = copyObjects(fallbackMerchants);
    demo.nearbySource = 'local-fallback';
    const result = await getSmartRecommendation(demo.profile, demo.nearbyMerchants,
      demo.rejectedMerchantIds, demo.recommendationFeedback, demo, demo.shownMerchantIds);
    const merchant = result.merchant;
    if (merchant) {
      demo.selectedMerchantId = merchant.id;
      demo.selectedMerchantReason = result.reason;
      if (!demo.shownMerchantIds.includes(merchant.id)) {
        demo.shownMerchantIds.push(merchant.id);
        const c = findCampaign(demo, merchant.id);
        if (c) c.metrics.smartMatchShown += 1;
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
    category: merchant.category, price: merchant.price, distanceMinutes: merchant.distanceMinutes,
    distanceMetres: Number.isFinite(merchant.distanceMetres) ? merchant.distanceMetres : null,
    distanceLabel: merchant.distanceLabel || null, cuisineTags: merchantCuisineTags(merchant) });
  demo.selectedMerchantId = null;
  demo.recommendationAccepted = false;
  logDiscovery('Rejected: ' + merchant.id + '\nReason: ' + req.body.reason +
    '\nShown history size: ' + demo.shownMerchantIds.length + '\nNew API request: no');
  if (req.get('X-Requested-With') === 'smart-match') return res.sendStatus(204);
  res.redirect('/home?matching=again');
});

function restartMatch(req, res) {
  const demo = req.session.demo;
  demo.selectedMerchantId = null;
  demo.recommendationAccepted = false;
  // Issue 3: session-level shown history survives a restart - a merchant already shown must not
  // immediately reappear just because the user pressed "Try again". Pool-exhaustion recycling
  // (in getSmartRecommendation) is what allows a controlled repeat, not clearing this array.
  if (req.path === '/recommendation/try-again') {
    demo.rejectedMerchantIds = [];
    demo.nearbyRefreshAttempted = false;
  }
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
  if (scan && scan.status === 'PAID') {
    const transaction = getOwnedTransaction(demo, scan.transactionId);
    if (!transaction) return transactionNotFound(res);
    return res.redirect(receiptUrl(transaction));
  }
  const activeClaim = getEffectiveVouchClaim(demo);
  const activeMerchantId = activeClaim && activeClaim.status === 'CLAIMED'
    ? activeClaim.merchantId
    : demo.recommendationAccepted && demo.selectedMerchantId ? demo.selectedMerchantId : null;
  const scanMerchants = demo.discoveryLocation && demo.nearbySource === 'foursquare'
    ? demo.nearbyMerchants.slice() : fallbackMerchants.slice();
  const activeMerchant = findMerchantForDemo(demo, activeMerchantId);
  if (activeMerchant && !findMerchantById(scanMerchants, activeMerchant.id)) scanMerchants.unshift(activeMerchant);
  res.render('scan', {
    error: req.query.error === 'invalid',
    merchants: scanMerchants,
    activeMerchantId: activeMerchantId
  });
});
app.post('/scan', function(req, res) {
  const demo = req.session.demo;
  const merchantId = req.body.merchantId;
  const merchant = findMerchantForDemo(demo, merchantId);
  if (!merchant || req.body.campaignId && req.body.campaignId !== merchant.id + '-campaign') {
    return res.redirect('/scan?error=invalid');
  }
  const existing = demo.currentScanPayment;
  if (existing && existing.status === 'PAID') return res.redirect('/vouch/' + existing.transactionId);
  if (existing && existing.status === 'MERCHANT_FOUND') return res.redirect('/scan/payment');
  demo.currentScanPayment = {
    id: 'scan-' + randomUUID(), source: 'scan',
    attributionSource: demo.recommendationAccepted && demo.selectedMerchantId === merchant.id ? 'smart-match' : 'scan',
    merchantId: merchant.id, merchantName: merchant.merchantName, outlet: merchant.address,
    enteredAmount: null, status: 'MERCHANT_FOUND', transactionId: null,
    cashbackUsed: 0, netsPaid: 0, cashbackAwarded: 0, vouchDecision: 'pending'
  };
  findCampaign(demo, merchant.id).metrics.scans += 1;
  res.redirect('/scan/payment?m=' + encodeURIComponent(merchant.id));
});
app.get('/scan/payment', function(req, res) {
  const demo = req.session.demo;
  let scan = demo.currentScanPayment;

  // If session is cold (Vercel cold start) but ?m= is present, rebuild scan state on the fly.
  if ((!scan || scan.status === 'COMPLETE') && req.query.m) {
    const merchant = findMerchantForDemo(demo, req.query.m);
    if (!merchant) return res.redirect('/scan?error=invalid');
    scan = {
      id: 'scan-' + randomUUID(), source: 'scan',
      attributionSource: demo.recommendationAccepted && demo.selectedMerchantId === merchant.id ? 'smart-match' : 'scan',
      merchantId: merchant.id, merchantName: merchant.merchantName, outlet: merchant.address,
      enteredAmount: null, status: 'MERCHANT_FOUND', transactionId: null,
      cashbackUsed: 0, netsPaid: 0, cashbackAwarded: 0, vouchDecision: 'pending'
    };
    demo.currentScanPayment = scan;
  }

  if (!scan || scan.status === 'COMPLETE') return res.redirect('/scan');
  if (scan.transactionId) {
    const existingTransaction = getOwnedTransaction(demo, scan.transactionId);
    if (existingTransaction) return res.redirect(receiptUrl(existingTransaction));
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
  // The unique scan journey ID is the payment-attempt token submitted by the form.
  const processedId = demo.processedPaymentAttempts[req.body.journeyId];
  if (processedId) {
    const processed = getOwnedTransaction(demo, processedId);
    if (processed) return res.redirect(receiptUrl(processed));
  }
  const scan = demo.currentScanPayment;
  if (!scan || req.body.journeyId !== scan.id) return res.redirect('/scan');
  if (scan.transactionId) {
    const existingTransaction = getOwnedTransaction(demo, scan.transactionId);
    if (!existingTransaction) return transactionNotFound(res);
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
  const transaction = getOwnedTransaction(demo, req.params.id);
  if (!transaction) return transactionNotFound(res);
  res.render('payment-success', { transaction: transaction, canVouch: canVouch(transaction), vouchTags: vouchTags });
});

app.get('/order', function(req, res) { res.redirect('/home'); });
app.get('/order/state', function(req, res) { res.json({ id: null, status: null }); });
app.get('/collection', function(req, res) { res.redirect('/home'); });
app.post('/collection', function(req, res) { res.redirect('/home'); });

// Payment-Verified Vouches: one decision per transaction.
app.get('/vouch', function(req, res) { res.redirect('/home'); });
app.get('/vouch/:id', function(req, res) {
  const transaction = getOwnedTransaction(req.session.demo, req.params.id);
  if (!transaction) return transactionNotFound(res);
  if (!canVouch(transaction) || transaction.vouchDecision === 'skipped') return res.redirect('/home');
  if (transaction.vouchDecision === 'created') return res.redirect('/vouch/' + transaction.id + '/success');
  res.render('vouch', { transaction: transaction, vouchTags: vouchTags,
    tagError: req.query.error === 'tag' });
});
app.post('/vouch/:id', function(req, res) {
  const demo = req.session.demo;
  const transaction = getOwnedTransaction(demo, req.params.id);
  if (!transaction) return transactionNotFound(res);
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
  const transaction = getOwnedTransaction(demo, req.params.id);
  if (!transaction) return transactionNotFound(res);
  if (transaction.vouchDecision !== 'created') return res.redirect('/home');
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
  if (activeClaim && activeClaim.vouchId === offer.vouchId && activeClaim.status === 'REDEEMED') {
    return res.redirect('/offers/' + offer.token);
  }
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
  const transaction = getOwnedTransaction(demo, req.params.id);
  if (!transaction) return transactionNotFound(res);
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
    rewardCredits: getRewardCredits(demo), dietaryLabel: getDietaryPreferenceLabel(demo.profile.dietaryPreference),
    moodCuisineLabel: getMoodCuisineLabel(demo.profile.moodCuisine || 'any') });
});
app.get('/profile/rewards', function(req, res) {
  res.render('profile-rewards', { rewardCredits: getRewardCredits(req.session.demo) });
});
app.get('/profile/preferences', function(req, res) {
  const demo = req.session.demo;
  res.render('profile-preferences', { profile: demo.profile,
    dietaryPreferenceOptions: dietaryPreferenceOptions, moodCuisineOptions: moodCuisineOptions,
    settingsError: req.query.error === 'invalid' });
});
app.get('/profile/vouches', function(req, res) {
  res.render('profile-vouches', { paymentVerifiedVouches: req.session.demo.paymentVerifiedVouches });
});
app.get('/profile/activity', function(req, res) {
  res.render('profile-activity', { transactions: getActivityTransactions(req.session.demo) });
});
app.post('/profile', function(req, res) {
  const demo = req.session.demo;
  const budget = parsePaymentAmount(req.body.budget);
  const distance = Number(req.body.maxDistanceMinutes);
  const mood = req.body.moodCuisine || 'any';
  if (!isValidDietaryPreference(req.body.dietaryPreference) || !isValidMoodCuisine(mood) ||
      budget === null || budget > 100 || !Number.isInteger(distance) || distance < 1 || distance > 60) {
    return res.redirect('/profile/preferences?error=invalid');
  }
  demo.profile = { dietaryPreference: req.body.dietaryPreference, moodCuisine: mood,
    craving: sanitizeCraving(req.body.craving),
    budget: budget, maxDistanceMinutes: distance, notifications: req.body.notifications === 'on' };
  demo.hasSetPreferences = true;
  demo.selectedMerchantId = null;
  demo.recommendationAccepted = false;
  // Issue 3 (Edit filters): session-level shown/rejected history survives a filter/craving edit.
  // A new Foursquare search may legitimately run below, but a merchant already shown must not
  // reappear immediately just because the craving/mood/dietary filters changed.
  demo.nearbyMerchants = [];
  demo.nearbyRefreshAttempted = false;
  // A new Smart Match discovery re-acquires current GPS rather than depending on a stale
  // coordinate (Part C).
  demo.locationAttempted = false;
  res.redirect('/home?matching=again');
});
app.get('/transactions/:id', function(req, res) {
  const transaction = getOwnedTransaction(req.session.demo, req.params.id);
  if (!isCompletedActivityTransaction(transaction)) return transactionNotFound(res);
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
  const merchantList = fallbackMerchants.concat(Array.from(discoveredMerchants.values()));
  const merchant = findMerchantById(merchantList, req.query.merchantId || defaultId);
  if (!merchant) return res.redirect('/merchant');
  const campaign = findCampaign(demo, merchant.id);
  res.render('merchant', {
    merchants: merchantList, merchant: merchant, campaign: campaign,
    illustrativeMetrics: campaignSeedMetrics[merchant.id] || null,
    tab: req.query.tab === 'results' ? 'results' : 'campaign',
    availability: getCampaignAvailability(campaign, false),
    maxDailyCost: getMaxDailyCostEstimate(campaign),
    error: req.query.error === 'invalid',
    recentPayments: merchantPaymentFeed.filter(function(p) {
      return p.merchantId === merchant.id && !p.illustrative;
    }).slice(0, 12)
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
  // This helper control has always reset shared campaign state, so reset all demo
  // sessions too. The generation also protects against an in-flight stale save.
  demoResetGeneration += 1;
  sharedOffers.clear();
  referralCooldowns.clear();
  merchantPaymentFeed.splice(0, merchantPaymentFeed.length,
    ...initialMerchantPaymentFeed.map(function(payment) { return { ...payment }; }));
  merchantCampaignStore.forEach(function(campaign) {
    const clean = createDemoCampaign(campaign.merchantId, campaign.participationMode);
    campaign.redemptionsToday = 0;
    campaign.rewardBudgetSpentToday = 0;
    campaign.platformFeeAccrued = 0;
    campaign.day = clean.day;
    campaign.metrics = clean.metrics;
  });
  req.session.demo = createInitialDemo('jia');
  req.session.demoUserStates = {};
  req.session.demoResetGeneration = demoResetGeneration;
  demoStore.all(function(error, sessions) {
    if (error) return res.status(500).send('Demo reset could not be completed');
    const ids = Object.keys(sessions || {}).filter(function(id) { return id !== req.sessionID; });
    let remaining = ids.length;
    if (!remaining) return res.redirect('/home?reset=done');
    let failed = false;
    ids.forEach(function(id) {
      const stored = sessions[id];
      stored.demo = createInitialDemo('jia');
      stored.demoUserStates = {};
      stored.demoResetGeneration = demoResetGeneration;
      demoStore.set(id, stored, function(saveError) {
        if (saveError) failed = true;
        remaining -= 1;
        if (!remaining) {
          if (failed) return res.status(500).send('Demo reset could not be completed');
          res.redirect('/home?reset=done');
        }
      });
    });
  });
});

// Start server. Export the app and demo factory for local automated tests.
if (require.main === module) {
  app.listen(PORT, function() {
    console.log('NETS Vouch AI running on http://localhost:' + PORT);
    console.log('FOURSQUARE_API_KEY configured: ' + (process.env.FOURSQUARE_API_KEY ? 'yes' : 'no'));
  });
}
module.exports = { app: app, createInitialDemo: createInitialDemo, demoStore: demoStore,
  getNearbyMerchants: getNearbyMerchants, getEligibleMerchants: getEligibleMerchants,
  getSmartRecommendation: getSmartRecommendation,
  getMoodMatchState: getMoodMatchState, getDietaryMatchState: getDietaryMatchState,
  getCravingMatchState: getCravingMatchState,
  MATCH_STATE: MATCH_STATE,
  getMerchantCampaigns: function() { return merchantCampaignStore; },
  resetMerchantCampaigns: function() { merchantCampaignStore = createCampaigns(); },
  resetReferralCooldowns: function() { referralCooldowns.clear(); },
  clearDiscoveryCache: clearDiscoveryCache };
