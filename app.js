// Import packages
const express = require('express');
const session = require('express-session');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { Redis } = require('@upstash/redis');
// Smart Match RESULT presentation only (photo, demo Vouch count, walking map) - no matching logic.
const smartMatchResult = require('./smart-match-result');

// Load local environment variables when a .env file exists (Node.js 22+).
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const app = express();
const PORT = process.env.PORT || 3000;
const MINIMUM_ELIGIBLE_PAYMENT = 1.00;
// Smart Match speed budget: a normal match (discovery + AI ranking + result card) should finish inside
// the ~2 s loading screen and never take much more than 3 s. Anything slower falls back to the
// existing fast path (next provider / rules / cached data) instead of making the user wait.
const PLACES_REQUEST_TIMEOUT_MS = 1500;
// One shared budget for final ranking: Groq first, OpenAI only with the time that is left, then rules.
const AI_RANKING_TIMEOUT_MS = 1500;
const AI_RANKING_MIN_ATTEMPT_MS = 300;
// Foursquare's practical maximum results-per-request for Place Search.
const FOURSQUARE_RESULT_LIMIT = 50;
// Foursquare's dated Places API version header, matched to the manually-verified request.
const FOURSQUARE_API_VERSION = '2025-06-17';
// Google Places API (New). Minimal field mask: identity, name, types, address and location only -
// no ratings, reviews, photos, hours or price, so billing stays predictable.
const GOOGLE_NEARBY_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const GOOGLE_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const GOOGLE_FIELD_MASK = 'places.id,places.displayName,places.primaryType,places.types,places.formattedAddress,places.location';
// Google's per-request maximum for both Nearby Search and Text Search.
const GOOGLE_RESULT_LIMIT = 20;
// Meal-focused discovery: cafés and bakeries are not requested (Smart Match is for a proper meal), and
// primary types already seen in live Places (New) responses as non-meal are excluded at the source.
// isMealMerchant still filters server-side - the request alone is never trusted.
const GOOGLE_NEARBY_FOOD_TYPES = ['restaurant', 'fast_food_restaurant', 'meal_takeaway'];
const GOOGLE_NEARBY_EXCLUDED_PRIMARY_TYPES = ['food_court', 'shopping_mall', 'cafe', 'coffee_shop', 'bakery',
  'dessert_shop', 'pastry_shop'];
const GOOGLE_TEXT_SEARCH_BIAS_METRES = 1000;
const WALKING_METRES_PER_MINUTE = 80;
const CLAIM_EXPIRY_MS = 20 * 60 * 1000;
const REFERRAL_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

// Configure Express
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure session
// Use Upstash Redis when env vars are present (Vercel multi-instance), fall back to MemoryStore locally.
function buildSessionStore() {
  // Strip UTF-8 BOM (﻿) that PowerShell echo can prepend when piping to vercel env add.
  const url   = (process.env.UPSTASH_REDIS_REST_URL   || '').replace(/^﻿/, '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').replace(/^﻿/, '').trim();
  if (!url || !token) return new session.MemoryStore();

  const redis = new Redis({ url, token });
  const TTL   = 60 * 60 * 24; // 24 h

  class UpstashStore extends session.Store {
    async get(sid, cb) {
      try {
        const data = await redis.get(`sess:${sid}`);
        cb(null, data ? (typeof data === 'string' ? JSON.parse(data) : data) : null);
      } catch(e) { cb(e); }
    }
    async set(sid, sess, cb) {
      try {
        const expire = sess.cookie?.maxAge ? Math.floor(sess.cookie.maxAge / 1000) : TTL;
        await redis.setex(`sess:${sid}`, expire, JSON.stringify(sess));
        cb(null);
      } catch(e) { cb(e); }
    }
    async destroy(sid, cb) {
      try { await redis.del(`sess:${sid}`); cb(null); } catch(e) { cb(e); }
    }
  }

  return new UpstashStore();
}

const demoStore = buildSessionStore();
let demoResetGeneration = 0;
app.use(session({
  store: demoStore,
  secret: process.env.SESSION_SECRET || 'nets-vouch-ai-demo-secret',
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

// Craving interpretation is semantic and belongs to the AI ranker (see getAIRanking) - there is
// deliberately NO craving vocabulary here. The only deterministic craving signal is whether the
// user's OWN words literally appear in a merchant's factual name/category data, used to order the
// AI prompt cap and as a small nudge in the non-AI fallback. It never gates eligibility.

// Lower-cases, strips accents and punctuation, and pads with spaces so a term can be matched as
// a whole word/phrase with indexOf(' ' + term + ' ').
function normaliseMatchText(text) {
  return ' ' + String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

// Whole word/phrase match, tolerating a simple plural ("noodle" -> "noodles").
function textHasTerm(text, term) {
  const t = normaliseMatchText(term).trim();
  if (!t) return false;
  return text.indexOf(' ' + t + ' ') !== -1 || text.indexOf(' ' + t + 's ') !== -1 ||
    text.indexOf(' ' + t + 'es ') !== -1;
}

function merchantCategoryNames(merchant) {
  if (Array.isArray(merchant.categoryNames) && merchant.categoryNames.length) return merchant.categoryNames;
  return merchant.categoryLabel ? [merchant.categoryLabel] : [];
}

function merchantMentionsCraving(merchant, craving) {
  if (!isSpecificCraving(craving)) return false;
  const text = normaliseMatchText([merchant.merchantName, merchant.itemName || '']
    .concat(merchantCategoryNames(merchant)).join(' '));
  return textHasTerm(text, normaliseCravingQuery(craving));
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

// Module-level location fallback for a cold-started instance, keyed by session ID.
// Transactions deliberately have NO module-level cache: the owning session is the only source of
// truth, so ownership, isolation and Reset Demo invalidation cannot be bypassed.
const locationCache = new Map();    // sessionId → {latitude, longitude}

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
  { merchantId: 'hawker-88', displayAmount: '$7.00', source: 'DIRECT_SCAN', date: '2026-09-15', time: '13:10', itemName: null },
  // Woodlands Noodle Bar — vegetarian-friendly, lunch-heavy
  { merchantId: 'woodlands-noodle-bar', displayAmount: '$6.80', source: 'SMART_MATCH', date: '2026-09-19', time: '12:22', itemName: 'Mushroom Noodles' },
  { merchantId: 'woodlands-noodle-bar', displayAmount: '$6.80', source: 'DIRECT_SCAN', date: '2026-09-19', time: '12:05', itemName: null },
  { merchantId: 'woodlands-noodle-bar', displayAmount: '$13.60', source: 'DIRECT_SCAN', date: '2026-09-18', time: '12:40', itemName: null },
  { merchantId: 'woodlands-noodle-bar', displayAmount: '$6.80', source: 'SHARED_VOUCH', date: '2026-09-18', time: '12:15', itemName: 'Mushroom Noodles' },
  { merchantId: 'woodlands-noodle-bar', displayAmount: '$6.80', source: 'SMART_MATCH', date: '2026-09-17', time: '13:00', itemName: 'Mushroom Noodles' },
  { merchantId: 'woodlands-noodle-bar', displayAmount: '$6.80', source: 'DIRECT_SCAN', date: '2026-09-16', time: '12:50', itemName: null },
  { merchantId: 'woodlands-noodle-bar', displayAmount: '$6.80', source: 'SMART_MATCH', date: '2026-09-15', time: '12:30', itemName: 'Mushroom Noodles' },
  // Northside Wraps — vegan-friendly, lunch and afternoon
  { merchantId: 'northside-wraps', displayAmount: '$8.80', source: 'SMART_MATCH', date: '2026-09-19', time: '13:05', itemName: 'Vegan Crunch Wrap' },
  { merchantId: 'northside-wraps', displayAmount: '$8.80', source: 'DIRECT_SCAN', date: '2026-09-19', time: '12:35', itemName: null },
  { merchantId: 'northside-wraps', displayAmount: '$17.60', source: 'DIRECT_SCAN', date: '2026-09-18', time: '12:45', itemName: null },
  { merchantId: 'northside-wraps', displayAmount: '$8.80', source: 'SHARED_VOUCH', date: '2026-09-18', time: '12:10', itemName: 'Vegan Crunch Wrap' },
  { merchantId: 'northside-wraps', displayAmount: '$8.80', source: 'SMART_MATCH', date: '2026-09-17', time: '13:20', itemName: 'Vegan Crunch Wrap' },
  { merchantId: 'northside-wraps', displayAmount: '$8.80', source: 'DIRECT_SCAN', date: '2026-09-16', time: '12:55', itemName: null },
  // Spice Lane — halal, lunch and dinner
  { merchantId: 'spice-lane', displayAmount: '$8.50', source: 'SMART_MATCH', date: '2026-09-19', time: '12:55', itemName: 'Chicken Biryani' },
  { merchantId: 'spice-lane', displayAmount: '$8.50', source: 'DIRECT_SCAN', date: '2026-09-19', time: '19:20', itemName: null },
  { merchantId: 'spice-lane', displayAmount: '$17.00', source: 'DIRECT_SCAN', date: '2026-09-18', time: '12:30', itemName: null },
  { merchantId: 'spice-lane', displayAmount: '$8.50', source: 'SHARED_VOUCH', date: '2026-09-18', time: '19:45', itemName: 'Chicken Biryani' },
  { merchantId: 'spice-lane', displayAmount: '$8.50', source: 'SMART_MATCH', date: '2026-09-17', time: '12:50', itemName: 'Chicken Biryani' },
  { merchantId: 'spice-lane', displayAmount: '$8.50', source: 'DIRECT_SCAN', date: '2026-09-16', time: '19:10', itemName: null },
  { merchantId: 'spice-lane', displayAmount: '$8.50', source: 'SMART_MATCH', date: '2026-09-15', time: '13:05', itemName: 'Chicken Biryani' }
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
    version: 18,
    user: { ...demoIdentities[identityId] },
    profile: { dietaryPreference: 'none', moodCuisine: 'any', craving: '', budget: 10, maxDistanceMinutes: 10, notifications: true },
    hasSetPreferences: false,
    vouchCredits: {}, dailyMerchantRewards: {},
    nearbyMerchants: [], selectedMerchantId: null, selectedMerchantReason: null, selectedMerchantRelevance: null,
    recommendationAccepted: false, rejectedMerchantIds: [],
    discoveryLocation: null, locationAttempted: false, nearbySource: null, nearbyDemoFallback: false,
    nearbyRefreshAttempted: false,
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
  if (!req.session.demo || req.session.demo.version !== 18) {
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

// Budget only uses a factual price. Provider price tiers (Foursquare Premium `price`, Google
// `priceLevel`) are not requested, so an unknown price never excludes a merchant.
function merchantMatchesProfile(merchant, profile) {
  if (merchant.price !== null && merchant.price > profile.budget) return false;
  // Places API merchants carry real distanceMetres; use it for precise filtering.
  // Local demo merchants only have distanceMinutes, so fall back to the coarser check.
  const maxMetres = profile.maxDistanceMinutes * WALKING_METRES_PER_MINUTE;
  if (Number.isFinite(merchant.distanceMetres)) {
    if (merchant.distanceMetres > maxMetres) return false;
  } else if (merchant.distanceMinutes > profile.maxDistanceMinutes) {
    return false;
  }
  // Only a known dietary NON_MATCH is excluded here. Everything else is resolved by
  // applyMerchantResearch, which keeps research-verified SUITABLE merchants only.
  return getDietaryMatchState(merchant, profile.dietaryPreference) !== MATCH_STATE.NON_MATCH;
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
// Includes major Singapore food court operators (Food Republic, Koufu, Foodfare) that would not
// be caught by the generic "food court" keyword since they use branded names.
// "food mall" / "foodcourt" are generic container phrases (e.g. a Google result typed only as
// `restaurant` whose name shows the place itself is a food mall).
const containerNamePattern = /\b(food court|foodcourt|food centre|food center|food mall|hawker centre|hawker center|kopitiam|coffeeshop|coffee shop|food republic|koufu|foodfare)\b/i;

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
      providerPlaceId: place.fsq_place_id,
      merchantName: name,
      name: name,
      itemName: null,
      price: null,
      category: 'foursquare.place',
      categoryLabel: categoryLabel,
      website: null,
      categoryNames: Array.isArray(place.categories) ? place.categories.map(function(c) {
        return c && typeof c.name === 'string' ? c.name.trim() : '';
      }).filter(Boolean) : [],
      address: address,
      // Dietary suitability is never read from Foursquare words - only from merchant research.
      dietary: [],
      cuisineTags: parseFoursquareCuisineTags(place.categories),
      // Premium `price` is not requested - budget uses researched factual prices only.
      priceLevel: null,
      // Used only for the existing distance filter; the UI displays metres, never walking time.
      distanceMinutes: Math.max(1, Math.round(distanceMetres / 80)),
      distanceMetres: distanceMetres,
      distanceLabel: distanceMetres < 1000 ? distanceMetres + ' m away' :
        (distanceMetres / 1000).toFixed(1) + ' km away',
      coordinates: { latitude: latitude, longitude: longitude },
      source: 'FOURSQUARE', participationMode: 'DEMO_SIMULATED',
      rating: null,
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

// Google types that mean the place itself IS a container venue. `coffee_shop` is deliberately
// absent: many coffee shops are real single merchants. Only the place's own type/name is used -
// an address that mentions a mall or food court never makes the merchant a container.
const googleContainerTypes = ['food_court', 'shopping_mall', 'market'];
const googleGenericTypes = ['food', 'point_of_interest', 'establishment'];

function isGoogleContainerPlace(place) {
  if (googleContainerTypes.indexOf(place.primaryType) !== -1) return true;
  // Without a primary type, fall back to the place's own type list.
  if (!place.primaryType && Array.isArray(place.types) &&
      place.types.some(function(type) { return googleContainerTypes.indexOf(type) !== -1; })) return true;
  return isContainerName(place.displayName && place.displayName.text);
}

// Text Search can surface non-food places for an unusual craving; Google's own `food` marker or a
// restaurant/café type is the factual signal, never the place name.
function isGoogleFoodPlace(place) {
  const types = Array.isArray(place.types) ? place.types.slice() : [];
  if (typeof place.primaryType === 'string') types.push(place.primaryType);
  return types.some(function(type) {
    return type === 'food' || type === 'restaurant' || type === 'cafe' || type === 'bakery' ||
      type === 'meal_takeaway' || /_restaurant$/.test(type);
  });
}

function humaniseGoogleType(type) {
  return type.split('_').map(function(word) { return word.charAt(0).toUpperCase() + word.slice(1); }).join(' ');
}

// Normalises Google Places (New) results into the same merchant shape as Foursquare. Distance is
// calculated locally from the visitor's coordinates. Google has no parent-venue relationship, so
// parentVenueName stays null rather than being guessed from the address. Types are discovery
// hints only - dietary suitability still comes exclusively from merchant research.
function parseGooglePlaces(places, origin) {
  const merchants = [];
  const suppressed = [];
  if (!Array.isArray(places)) return { merchants: merchants, containersRemoved: 0 };
  places.forEach(function(place) {
    const name = place && place.displayName && typeof place.displayName.text === 'string'
      ? place.displayName.text.trim() : '';
    if (!place || typeof place.id !== 'string' || !place.id.trim() || !name) return;
    if (!isGoogleFoodPlace(place)) return;
    if (isGoogleContainerPlace(place)) {
      suppressed.push({ name: name, reason: 'container type/name' });
      return;
    }
    const latitude = place.location && Number(place.location.latitude);
    const longitude = place.location && Number(place.location.longitude);
    if (!validCoordinates(latitude, longitude)) return;
    const distanceMetres = calculateDistanceMetres(latitude, longitude, origin);
    const types = Array.isArray(place.types) ? place.types.filter(function(type) {
      return typeof type === 'string' && googleGenericTypes.indexOf(type) === -1;
    }) : [];
    const primaryType = typeof place.primaryType === 'string' && place.primaryType ? place.primaryType : null;
    const categoryNames = types.map(humaniseGoogleType);
    const merchantId = 'google-' + place.id;
    merchants.push({
      id: merchantId,
      merchantId: merchantId,
      externalPlaceId: place.id,
      providerPlaceId: place.id,
      merchantName: name,
      name: name,
      itemName: null,
      price: null,
      category: 'google.place',
      categoryLabel: primaryType ? humaniseGoogleType(primaryType) : (categoryNames[0] || 'Food & drink'),
      website: null,
      categoryNames: categoryNames,
      primaryType: primaryType,
      // Raw Google type identifiers (generic markers removed) - used only for meal-merchant eligibility.
      placeTypes: types,
      address: typeof place.formattedAddress === 'string' && place.formattedAddress.trim()
        ? place.formattedAddress.trim() : 'Address unavailable',
      dietary: [],
      cuisineTags: parseFoursquareCuisineTags(categoryNames.map(function(n) { return { name: n }; })),
      priceLevel: null,
      distanceMinutes: Math.max(1, Math.round(distanceMetres / WALKING_METRES_PER_MINUTE)),
      distanceMetres: distanceMetres,
      distanceLabel: distanceMetres < 1000 ? distanceMetres + ' m away' :
        (distanceMetres / 1000).toFixed(1) + ' km away',
      coordinates: { latitude: latitude, longitude: longitude },
      source: 'GOOGLE', participationMode: 'DEMO_SIMULATED',
      rating: null,
      available: true,
      parentVenueName: null
    });
  });
  if (suppressed.length) {
    logDiscovery('Container venues suppressed: ' + suppressed.length + '\n' +
      suppressed.map(function(s) { return '- ' + s.name + ' (' + s.reason + ')'; }).join('\n'));
  }
  return { merchants: merchants, containersRemoved: suppressed.length };
}

// Both Places providers feed the same research, dietary and ranking pipeline.
function isPlacesMerchant(merchant) {
  return merchant.source === 'GOOGLE' || merchant.source === 'FOURSQUARE';
}

// ---------------------------------------------------------------------------
// Meal-merchant eligibility. Smart Match recommends somewhere to eat a proper meal, so a place whose
// PRIMARY business is coffee, tea, drinks, bakery/pastry, desserts, snacks or retail never reaches
// ranking. Decided only from provider type/category metadata - never from merchant names or food
// words - and applied to every provider. Discovery still returns such places (e.g. for Scan).
// ---------------------------------------------------------------------------
// Classification is TRI-STATE so an unfamiliar provider type is never silently lost:
//   MEAL      - known meal evidence (restaurant family, stable meal-service type, or strong secondary type)
//   NON_MEAL  - the place's own primary identity is explicitly outside proper-meal scope (wins over
//               any weaker secondary "restaurant"/"food" metadata)
//   UNCERTAIN - food-related but no strong evidence either way (see mealEligibilityAllows)
const MEAL_ELIGIBILITY = { MEAL: 'MEAL', NON_MEAL: 'NON_MEAL', UNCERTAIN: 'UNCERTAIN' };

// Google Places (New) type identifiers. Deny list: coffee/tea/drinks, bakery/pastry, desserts, snacks,
// bars and retail. Containers (food_court, shopping_mall, market) are removed earlier by parseGooglePlaces.
const GOOGLE_NON_MEAL_TYPES = ['cafe', 'coffee_shop', 'coffee_stand', 'coffee_roastery', 'cat_cafe', 'dog_cafe',
  'tea_house', 'juice_shop', 'acai_shop', 'bakery', 'bagel_shop', 'pastry_shop', 'donut_shop', 'dessert_shop',
  'dessert_restaurant', 'ice_cream_shop', 'confectionery', 'candy_store', 'chocolate_shop', 'snack_bar', 'bar',
  'pub', 'wine_bar', 'convenience_store', 'grocery_store', 'supermarket', 'liquor_store', 'store'];
// A small stable set of meal-service formats that do not follow the "_restaurant" naming.
const GOOGLE_MEAL_SERVICE_TYPES = ['restaurant', 'meal_takeaway', 'meal_delivery', 'bar_and_grill', 'cafeteria',
  'deli', 'diner', 'sandwich_shop', 'salad_shop', 'noodle_shop'];
// Secondary types strong enough to promote an unfamiliar or generic primary type to MEAL.
const GOOGLE_STRONG_SECONDARY_MEAL_TYPES = ['restaurant', 'meal_takeaway', 'meal_delivery'];

function isGoogleRestaurantFamily(type) {
  return typeof type === 'string' && /_restaurant$/.test(type) && GOOGLE_NON_MEAL_TYPES.indexOf(type) === -1;
}

// Meal-service types (stable set or the "_restaurant" family) - strong evidence of serving meals.
function isGoogleStrongMealType(type) {
  return GOOGLE_MEAL_SERVICE_TYPES.indexOf(type) !== -1 || isGoogleRestaurantFamily(type);
}

function classifyGoogleMealEligibility(merchant) {
  const primary = merchant.primaryType || null;
  const types = Array.isArray(merchant.placeTypes) ? merchant.placeTypes : [];
  // Singapore exception, coffee_shop ONLY: Google labels many kopitiam food stalls "coffee_shop", so
  // strong meal-service evidence in its own types makes it a meal merchant. Generic cafe/food/store
  // types are not evidence. Every other explicit non-meal primary type (cafe, bakery...) still wins.
  if (primary === 'coffee_shop' && types.some(isGoogleStrongMealType)) return MEAL_ELIGIBILITY.MEAL;
  if (primary && GOOGLE_NON_MEAL_TYPES.indexOf(primary) !== -1) return MEAL_ELIGIBILITY.NON_MEAL;
  if (primary && (GOOGLE_MEAL_SERVICE_TYPES.indexOf(primary) !== -1 || isGoogleRestaurantFamily(primary))) {
    return MEAL_ELIGIBILITY.MEAL;
  }
  // Unfamiliar primary (e.g. a type Google adds tomorrow), the generic food_store, or no primary at
  // all: strong secondary meal evidence decides.
  const strongSecondary = types.some(function(type) {
    return GOOGLE_STRONG_SECONDARY_MEAL_TYPES.indexOf(type) !== -1 || isGoogleRestaurantFamily(type);
  });
  if (strongSecondary) return MEAL_ELIGIBILITY.MEAL;
  if (primary === 'food_store') return MEAL_ELIGIBILITY.NON_MEAL;
  if (!primary && types.some(function(type) { return GOOGLE_NON_MEAL_TYPES.indexOf(type) !== -1; })) {
    return MEAL_ELIGIBILITY.NON_MEAL;
  }
  return MEAL_ELIGIBILITY.UNCERTAIN;
}

// Foursquare category names: the first category is the place's primary identity. Letter lookarounds
// (not \b) so accented names such as "Café" match as whole words. These describe provider CATEGORY
// names - never merchant names.
const foursquareMealCategoryPattern = /(?<![a-zà-ÿ])(restaurant|joint|diner|steakhouse|eatery|bistro|grill|noodles?|ramen|sushi|pizzeria|pizza|burger|sandwich|deli|buffet|cafeteria|canteen|hawker|food stall|food truck|soup|bbq|dim sum|breakfast spot|salad|poke|wings|dumplings?)(?![a-zà-ÿ])/i;
const foursquareNonMealCategoryPattern = /(?<![a-zà-ÿ])(caf[eé]|coffee|tea|bubble tea|bakery|bakeries|dessert|ice cream|gelato|frozen yogurt|juice|smoothie|donut|doughnut|cupcake|pastry|patisserie|chocolate|candy|confectionery|snack|bar|pub|brewery|lounge|convenience)(?![a-zà-ÿ])/i;

function classifyFoursquareMealEligibility(merchant) {
  const categories = merchant.categoryNames || [];
  const primary = categories[0];
  if (!primary) return MEAL_ELIGIBILITY.UNCERTAIN;
  if (foursquareMealCategoryPattern.test(primary)) return MEAL_ELIGIBILITY.MEAL;
  if (foursquareNonMealCategoryPattern.test(primary)) return MEAL_ELIGIBILITY.NON_MEAL;
  // Unfamiliar primary category: a clear meal category elsewhere promotes it; otherwise uncertain.
  if (categories.slice(1).some(function(name) { return foursquareMealCategoryPattern.test(name); })) {
    return MEAL_ELIGIBILITY.MEAL;
  }
  return MEAL_ELIGIBILITY.UNCERTAIN;
}

function classifyMealEligibility(merchant) {
  if (!merchant) return MEAL_ELIGIBILITY.NON_MEAL;
  if (merchant.source === 'GOOGLE') return classifyGoogleMealEligibility(merchant);
  if (merchant.source === 'FOURSQUARE') return classifyFoursquareMealEligibility(merchant);
  // Curated demo merchants are all meal merchants (chicken rice, bowls, noodles, wraps, curry).
  return MEAL_ELIGIBILITY.MEAL;
}

function isMealMerchant(merchant) {
  return classifyMealEligibility(merchant) === MEAL_ELIGIBILITY.MEAL;
}

// Which UNCERTAIN merchants may join a Smart Match pool. With a specific craving, only those the
// provider's craving search itself returned; with no craving, only when the MEAL pool would otherwise
// be smaller than MIN_CRAVING_POOL_SIZE. NON_MEAL never qualifies. List order is preserved.
function filterByMealEligibility(merchantList, profile) {
  const classified = merchantList.map(function(m) { return { m: m, state: classifyMealEligibility(m) }; });
  const mealCount = classified.filter(function(c) { return c.state === MEAL_ELIGIBILITY.MEAL; }).length;
  const specific = isSpecificCraving(profile && profile.craving);
  return classified.filter(function(c) {
    if (c.state === MEAL_ELIGIBILITY.MEAL) return true;
    if (c.state !== MEAL_ELIGIBILITY.UNCERTAIN) return false;
    return specific ? Boolean(c.m.fromCravingSearch) : mealCount < MIN_CRAVING_POOL_SIZE;
  }).map(function(c) { return c.m; });
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
    url.searchParams.set('fields', 'fsq_place_id,name,geocodes,location,categories,distance,related_places');
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

function googleDiscoveryCacheKey(mode, location, detail) {
  return 'google:' + mode + ':' + location.latitude.toFixed(3) + ',' + location.longitude.toFixed(3) + ':' + detail;
}

// One Google Places (New) request: mode 'nearby' (detail = radius in metres, distance-ranked food
// types) or 'text' (detail = the user's raw craving, relevance-ranked with a location bias).
// Raw places are cached ~15 min per location bucket + mode + radius/craving; distances are always
// recalculated locally for the current visitor, so cached entries never carry another user's data.
async function fetchGooglePlaces(mode, searchLocation, detail) {
  const now = Date.now();
  removeExpiredDiscoveryEntries(now);
  const cacheKey = googleDiscoveryCacheKey(mode, searchLocation,
    mode === 'text' ? normaliseCravingQuery(detail) : String(detail));
  const cached = discoveryCache.get(cacheKey);
  if (cached) {
    logDiscovery('GOOGLE CACHE HIT\nkey: ' + cacheKey + '\nage: ' + Math.floor((now - cached.createdAt) / 1000) + 's');
    const parsed = parseGooglePlaces(structuredClone(cached.results), searchLocation);
    return { ok: true, rawCount: cached.results.length, merchants: parsed.merchants,
      containersRemoved: parsed.containersRemoved };
  }
  logDiscovery('GOOGLE CACHE MISS\nkey: ' + cacheKey);
  const center = { latitude: searchLocation.latitude, longitude: searchLocation.longitude };
  const body = mode === 'text' ? {
    textQuery: detail, pageSize: GOOGLE_RESULT_LIMIT, rankPreference: 'RELEVANCE',
    locationBias: { circle: { center: center, radius: GOOGLE_TEXT_SEARCH_BIAS_METRES } }
  } : {
    includedTypes: GOOGLE_NEARBY_FOOD_TYPES, excludedPrimaryTypes: GOOGLE_NEARBY_EXCLUDED_PRIMARY_TYPES,
    maxResultCount: GOOGLE_RESULT_LIMIT, rankPreference: 'DISTANCE',
    locationRestriction: { circle: { center: center, radius: detail } }
  };
  const controller = new AbortController();
  const timeout = setTimeout(function() { controller.abort(); }, PLACES_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(mode === 'text' ? GOOGLE_TEXT_SEARCH_URL : GOOGLE_NEARBY_SEARCH_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': GOOGLE_FIELD_MASK
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) return { ok: false, merchants: [], note: 'HTTP ' + response.status };
    const data = await response.json();
    // Google omits `places` entirely when nothing matches - that is an empty result, not malformed.
    if (!data || typeof data !== 'object' || (data.places !== undefined && !Array.isArray(data.places))) {
      return { ok: false, merchants: [], note: 'malformed response' };
    }
    const places = data.places || [];
    removeExpiredDiscoveryEntries(Date.now());
    if (discoveryCache.size >= DISCOVERY_CACHE_MAX_ENTRIES) {
      discoveryCache.delete(discoveryCache.keys().next().value);
    }
    const createdAt = Date.now();
    discoveryCache.set(cacheKey, { createdAt: createdAt, expiresAt: createdAt + DISCOVERY_CACHE_TTL_MS,
      results: structuredClone(places) });
    const parsed = parseGooglePlaces(places, searchLocation);
    return { ok: true, rawCount: places.length, merchants: parsed.merchants, containersRemoved: parsed.containersRemoved };
  } catch (error) {
    return { ok: false, merchants: [], note: controller.signal.aborted ? 'timeout' : error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function mergeByProviderPlaceId(first, second) {
  const seen = new Set(first.map(function(m) { return m.providerPlaceId; }));
  return first.concat(second.filter(function(m) { return !seen.has(m.providerPlaceId); }));
}

// ---------------------------------------------------------------------------
// Craving search intent (discovery only). One small Groq call turns the user's raw craving into ONE
// compact Google Text Search query - understanding local/colloquial food words semantically, with no
// synonym dictionary in code. The raw craving stays authoritative: it must be preserved inside the
// query and is what the final ranker is told the user asked for. Any failure (no key, 429, timeout,
// invalid or unsafe output) simply uses the raw craving. Cached by normalised craving text only
// (no location or user data); failures are never cached.
// ---------------------------------------------------------------------------
const SEARCH_INTENT_SYSTEM_MARKER = 'You turn a free-text food craving into ONE Google Maps search query';
const SEARCH_INTENT_TIMEOUT_MS = 800;
const SEARCH_INTENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_INTENT_CACHE_MAX_ENTRIES = 500;
const SEARCH_INTENT_MAX_CHARS = 80;
const SEARCH_INTENT_MAX_WORDS = 10;
const searchIntentCache = new Map();
const SEARCH_INTENT_PROVIDER = { id: 'groq', label: 'GROQ', keyEnv: 'GROQ_API_KEY',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  model: function() {
    return process.env.GROQ_SEARCH_INTENT_MODEL || process.env.GROQ_RANKING_MODEL || 'openai/gpt-oss-20b';
  },
  extra: { reasoning_effort: 'low', max_tokens: 400 } };
// Added words that would turn a food search into a location, dietary or quality search.
const SEARCH_INTENT_BLOCKED_ADDITIONS = /^(near|nearby|around|in|at|singapore|sg|street|st|road|rd|avenue|ave|lane|drive|mall|plaza|centre|center|junction|mrt|station|halal|vegetarian|vegan|kosher|gluten|muslim|plant|best|top|cheap|cheapest|popular|rated|famous|open|now)$/;

function clearSearchIntentCache() {
  searchIntentCache.clear();
}

function searchIntentWords(text) {
  return String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// Throws on anything unsafe; the caller then uses the raw craving.
function validateSearchIntent(content, rawCraving) {
  const parsed = JSON.parse(String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
  if (!parsed || typeof parsed.searchQuery !== 'string') throw new Error('missing searchQuery');
  const query = parsed.searchQuery.replace(/\s+/g, ' ').trim();
  if (!query || query.length > SEARCH_INTENT_MAX_CHARS || /[<>\r\n@#&]/.test(query)) throw new Error('unsafe query text');
  const words = searchIntentWords(query);
  if (words.length > SEARCH_INTENT_MAX_WORDS) throw new Error('query too long');
  const rawWords = searchIntentWords(rawCraving);
  if (!rawWords.every(function(word) { return words.indexOf(word) !== -1; })) throw new Error('raw craving not preserved');
  // Every ADDED word must be a plain lowercase word (no proper nouns, brands or numbers) and must not
  // add a location, dietary or quality constraint the user did not write.
  const addedTokens = query.split(/[\s,/]+/).filter(function(token) {
    return token && rawWords.indexOf(searchIntentWords(token)[0]) === -1;
  });
  addedTokens.forEach(function(token) {
    if (!/^[\p{Ll}][\p{Ll}\p{M}'-]*$/u.test(token)) throw new Error('added proper noun, number or symbol');
    if (SEARCH_INTENT_BLOCKED_ADDITIONS.test(token.toLowerCase())) throw new Error('added location, dietary or quality term');
  });
  const concepts = Array.isArray(parsed.concepts) ? parsed.concepts.filter(function(c) {
    return typeof c === 'string' && c.trim() && c.length <= 40 && !/[<>\r\n]/.test(c);
  }).map(function(c) { return c.trim(); }).slice(0, 6) : [];
  return { searchQuery: query, concepts: concepts };
}

function getCachedSearchIntent(rawCraving) {
  const entry = searchIntentCache.get(normaliseCravingQuery(rawCraving));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    searchIntentCache.delete(normaliseCravingQuery(rawCraving));
    return null;
  }
  return entry.intent;
}

async function getCravingSearchIntent(rawCraving) {
  const raw = String(rawCraving || '').trim();
  const fallback = { rawCraving: raw, searchQuery: raw, concepts: [], source: 'RAW' };
  const cached = getCachedSearchIntent(raw);
  if (cached) {
    logDiscovery('Search intent cache hit: "' + raw + '" -> "' + cached.searchQuery + '"');
    return cached;
  }
  if (!process.env[SEARCH_INTENT_PROVIDER.keyEnv] || raw.length > SEARCH_INTENT_MAX_CHARS) return fallback;
  const messages = [
    { role: 'system', content: [
      SEARCH_INTENT_SYSTEM_MARKER + ' for finding places to eat a meal.',
      'Keep ALL of the user\'s original words. You may add a few common equivalent food terms (including local or colloquial names and the general dish type) that describe the SAME food, so a search finds more matching places.',
      'Use plain lowercase words for anything you add. Never add locations, place or merchant names, brands, dietary requirements (halal, vegetarian, vegan...) the user did not write, prices, ratings or words like "best" or "near".',
      'If the craving is vague, stay general (e.g. the kind of meal) - never invent a specific dish.',
      'At most ' + SEARCH_INTENT_MAX_WORDS + ' words. Reply with JSON only: {"searchQuery":"<query>","concepts":["<short concept>", ...]}'
    ].join('\n') },
    { role: 'user', content: 'Craving: ' + raw }
  ];
  try {
    const content = await callResearchProvider(SEARCH_INTENT_PROVIDER, messages, SEARCH_INTENT_TIMEOUT_MS);
    const validated = validateSearchIntent(content, raw);
    const intent = { rawCraving: raw, searchQuery: validated.searchQuery, concepts: validated.concepts, source: 'GROQ' };
    if (searchIntentCache.size >= SEARCH_INTENT_CACHE_MAX_ENTRIES) {
      searchIntentCache.delete(searchIntentCache.keys().next().value);
    }
    searchIntentCache.set(normaliseCravingQuery(raw), { intent: intent, expiresAt: Date.now() + SEARCH_INTENT_CACHE_TTL_MS });
    logDiscovery('Search intent (GROQ): "' + raw + '" -> "' + intent.searchQuery + '"');
    return intent;
  } catch (error) {
    logDiscovery('Search intent unavailable (' + error.message + '): using raw craving');
    return fallback;
  }
}

// Google discovery. No craving -> one distance-ranked Nearby Search sized to the user's walking
// limit. Craving -> one Text Search with the RAW craving (no dictionary); only if that leaves fewer
// than MIN_CRAVING_POOL_SIZE usable (container-free, within walking limit) merchants, ONE broad
// Nearby Search is merged in by place ID. Max 2 Google requests. Returns null when Google cannot
// supply any usable merchant, so the caller falls back to the next provider.
async function discoverWithGoogle(searchLocation, craving, maxMetres) {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    logDiscovery('Google Places unavailable: key missing');
    return null;
  }
  const nearbyRadius = Math.min(demoLocation.searchRadiusMetres, maxMetres || demoLocation.searchRadiusMetres);
  // Usable = a MEAL merchant within the walking limit, or an UNCERTAIN one that eligibility could still
  // use (returned by the craving search itself, or any in no-craving mode where it is the small-pool
  // backstop). A Text Search full of cafés therefore still triggers the one broad Nearby fallback, and
  // zero usable still falls back to Foursquare rather than to the curated demo merchants.
  const specificCraving = isSpecificCraving(craving);
  const countUsable = function(pool) {
    return pool.filter(function(m) {
      const state = classifyMealEligibility(m);
      const typeOk = state === MEAL_ELIGIBILITY.MEAL ||
        (state === MEAL_ELIGIBILITY.UNCERTAIN && (m.fromCravingSearch || !specificCraving));
      return typeOk && (maxMetres === null || m.distanceMetres <= maxMetres);
    }).length;
  };
  let pool;
  let nearbyFallbackUsed = false;
  let expandedSearchUsed = false;
  if (!isSpecificCraving(craving)) {
    const nearby = await fetchGooglePlaces('nearby', searchLocation, nearbyRadius);
    if (!nearby.ok) {
      logDiscovery('Google Places unavailable: ' + nearby.note);
      return null;
    }
    pool = nearby.merchants;
  } else {
    // RAW FIRST: the user's own craving is always searched, and its results are always kept.
    const raw = await fetchGooglePlaces('text', searchLocation, craving.trim());
    if (!raw.ok) {
      logDiscovery('Google Places unavailable: ' + raw.note);
      return null;
    }
    // Returned by the craving search itself: retrieval relevance only, never menu proof.
    raw.merchants.forEach(function(m) { m.fromCravingSearch = true; });
    pool = raw.merchants;
    const rawUsable = countUsable(pool);
    logDiscovery('Raw craving search usable merchants: ' + rawUsable);
    if (rawUsable < MIN_CRAVING_POOL_SIZE) {
      // Too few: ONE semantic expansion (Groq) and ONE more Text Search, MERGED after the raw results
      // (deduplicated by place ID) - expanded results can add merchants but never replace raw ones.
      const intent = await getCravingSearchIntent(craving);
      const expandedQuery = intent.source === 'GROQ' &&
        normaliseCravingQuery(intent.searchQuery) !== normaliseCravingQuery(craving) ? intent.searchQuery : null;
      if (expandedQuery) {
        expandedSearchUsed = true;
        const expanded = await fetchGooglePlaces('text', searchLocation, expandedQuery);
        if (expanded.ok) {
          expanded.merchants.forEach(function(m) { m.fromCravingSearch = true; m.fromExpandedSearch = true; });
          pool = mergeByProviderPlaceId(pool, expanded.merchants);
        } else {
          logDiscovery('Expanded craving search failed: ' + expanded.note + ' - keeping raw results');
        }
      } else {
        // No usable expansion (no Groq key, failure or unsafe output): the one broad Nearby fallback.
        nearbyFallbackUsed = true;
        const nearby = await fetchGooglePlaces('nearby', searchLocation, nearbyRadius);
        if (nearby.ok) pool = mergeByProviderPlaceId(pool, nearby.merchants);
        else logDiscovery('Google Nearby fallback failed: ' + nearby.note);
      }
    }
  }
  pool = dedupeMerchantPool(pool);
  const states = pool.map(classifyMealEligibility);
  const count = function(state) { return states.filter(function(s) { return s === state; }).length; };
  const nonMeal = pool.filter(function(m, i) { return states[i] === MEAL_ELIGIBILITY.NON_MEAL; });
  logDiscovery('GOOGLE DISCOVERY\nMode: ' + (isSpecificCraving(craving) ? 'text' : 'nearby') +
    '\nExpanded craving search used: ' + (expandedSearchUsed ? 'yes' : 'no') +
    '\nNearby fallback used: ' + (nearbyFallbackUsed ? 'yes' : 'no') +
    '\nGoogle raw merchants: ' + pool.length + '\nMeal: ' + count(MEAL_ELIGIBILITY.MEAL) +
    ' | Uncertain: ' + count(MEAL_ELIGIBILITY.UNCERTAIN) + ' | Non-meal excluded: ' + nonMeal.length +
    (nonMeal.length ? ' (' + Array.from(new Set(nonMeal.map(function(m) { return m.primaryType || 'unknown'; }))).join(', ') + ')' : '') +
    '\nUsable within walking limit: ' + countUsable(pool));
  if (countUsable(pool) === 0) {
    logDiscovery('Google Places unavailable: zero usable food merchants');
    return null;
  }
  return pool;
}

// Foursquare discovery (fallback provider, or primary when PLACES_PROVIDER=foursquare). A specific
// craving drives the query itself, with at most one broader query=food fallback if that produces
// too few candidates. Returns null when Foursquare cannot supply any usable merchant.
async function discoverWithFoursquare(searchLocation, craving) {
  if (!process.env.FOURSQUARE_API_KEY) {
    logDiscovery('Foursquare unavailable: key missing');
    return null;
  }
  const specificCraving = isSpecificCraving(craving);
  const primaryQuery = specificCraving ? normaliseCravingQuery(craving) : 'food';
  const primary = await fetchFoursquarePlaces(searchLocation, primaryQuery);
  if (!primary.ok) {
    logDiscovery('Foursquare unavailable: ' + primary.note);
    return null;
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

  logDiscovery('FOURSQUARE DISCOVERY\nQuery: ' + primaryQuery + '\nPrimary raw results: ' + primary.rawCount +
    '\nFallback food query used: ' + (fallbackUsed ? 'yes (' + fallbackRawCount + ' raw)' : 'no') +
    '\ncontainer venues removed: ' + containersRemoved +
    '\nMerchant pool: ' + apiMerchants.length);
  if (apiMerchants.length === 0) {
    logDiscovery('Foursquare unavailable: zero usable food merchants');
    return null;
  }
  if (specificCraving) {
    // Places the craving query itself returned (retrieval relevance only, never menu proof).
    const cravingIds = new Set(primary.results.map(function(place) { return place && place.fsq_place_id; }));
    apiMerchants.forEach(function(m) { if (cravingIds.has(m.providerPlaceId)) m.fromCravingSearch = true; });
  }
  return apiMerchants;
}

// PLACES_PROVIDER picks the primary provider (default google); the other provider is the
// automatic fallback. A provider without a key is skipped, so neither key is required.
function discoveryProviderOrder() {
  const configured = String(process.env.PLACES_PROVIDER || '').trim().toLowerCase();
  return configured === 'foursquare' ? ['foursquare', 'google'] : ['google', 'foursquare'];
}

// Smart Match merchant discovery: primary Places provider -> other Places provider -> curated demo
// merchants. `source` is 'google', 'foursquare' or 'local-fallback'; `demoFallback` makes it
// explicit when a real browser location only produced the fixed Woodlands demo merchants.
// maxDistanceMinutes (the user's walking limit) sizes Google's search; the hard distance rule is
// still applied later by getEligibleMerchants, never by the provider or the AI.
async function getNearbyMerchants(location, sessionLabel, craving, maxDistanceMinutes) {
  const searchLocation = location && validCoordinates(location.latitude, location.longitude)
    ? location : demoLocation;
  const usingDemoLocation = searchLocation === demoLocation;
  const maxMetres = Number.isFinite(maxDistanceMinutes) && maxDistanceMinutes > 0
    ? maxDistanceMinutes * WALKING_METRES_PER_MINUTE : null;
  const providers = discoveryProviderOrder();
  logDiscovery('SMART MATCH LOCATION\nsession: ' + (sessionLabel || 'unknown') +
    '\nlatitude: ' + searchLocation.latitude + '\nlongitude: ' + searchLocation.longitude +
    '\nsource: ' + (usingDemoLocation ? 'demo fallback (no real browser coordinates)' : 'browser') +
    '\nCraving: ' + (isSpecificCraving(craving) ? normaliseCravingQuery(craving) : 'none') +
    '\nProvider order: ' + providers.join(' -> ') + ' -> demo');
  for (let i = 0; i < providers.length; i++) {
    const apiMerchants = providers[i] === 'google'
      ? await discoverWithGoogle(searchLocation, craving, maxMetres)
      : await discoverWithFoursquare(searchLocation, craving);
    if (!apiMerchants) continue;
    apiMerchants.forEach(registerDemoMerchant);
    logDiscovery('Smart Match merchant source: ' + providers[i].toUpperCase());
    return {
      merchants: usingDemoLocation ? combineMerchantLists(fallbackMerchants, apiMerchants) : apiMerchants,
      source: providers[i], demoFallback: false
    };
  }
  logDiscovery('Smart Match merchant source: DEMO' +
    (usingDemoLocation ? '' : ' (live discovery failed at the real browser location)'));
  return { merchants: copyObjects(fallbackMerchants), source: 'local-fallback', demoFallback: true };
}

// Called at most once per recommendation cycle when the current nearby batch is exhausted.
// Returns true only if the fresh discovery produced merchants not already in the current batch.
async function refreshNearbyBatch(demo) {
  const nearby = await getNearbyMerchants(demo.discoveryLocation, demo.user.id, demo.profile.craving,
    demo.profile.maxDistanceMinutes);
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

const AI_RELEVANCE_LEVELS = ['high', 'medium', 'low'];
const LOW_RELEVANCE_REASON = 'This is the closest available fit from the nearby options.';

// Conservative guard on the AI's free-text reason - not an NLP validator. A reason that asserts
// dietary, price, menu or rating facts the merchant record does not carry is discarded, so the
// card falls back to its deterministic "Why this match" copy instead of an invented claim.
// Dietary claim word -> the existing preference value that must be a verified MATCH to say it.
const dietaryClaimTerms = [['halal', 'halal'], ['muslim friendly', 'halal'], ['vegetarian', 'vegetarian'],
  ['veggie', 'vegetarian'], ['meat free', 'vegetarian'], ['meatless', 'vegetarian'], ['vegan', 'vegan'],
  ['plant based', 'vegan'], ['kosher', null], ['gluten free', null]];

// Travel-time wording ("10-minute walk", "5 mins away", "a few minutes' walk"). Places merchants only
// carry straight-line metres, so any duration is unsupported; a curated demo merchant supplies its own
// minutes estimate, so only that exact figure may be quoted. The user's maxWalkingMinutes is a limit,
// never a travel time.
const TRAVEL_TIME_PATTERN = /(?:\b[\w']+[\s\-\u2010-\u2015]+)?\b(?:minutes?|mins?)\b/gi;
const SMALL_NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

function aiReasonClaimsUnsupportedTravelTime(reason, merchant) {
  const mentions = reason.match(TRAVEL_TIME_PATTERN);
  if (!mentions) return false;
  if (Number.isFinite(merchant.distanceMetres)) return true;
  return mentions.some(function(mention) {
    const token = mention.toLowerCase().split(/[\s\-\u2010-\u2015]+/)[0];
    const value = /^\d+$/.test(token) ? Number(token) : SMALL_NUMBER_WORDS.indexOf(token);
    return value !== merchant.distanceMinutes;
  });
}

function aiReasonClaimsUnsupportedFacts(reason, merchant, profile) {
  if (aiReasonClaimsUnsupportedTravelTime(reason, merchant)) return true;
  const text = normaliseMatchText(reason);
  if (dietaryClaimTerms.some(function(entry) {
    return textHasTerm(text, entry[0]) &&
      (!entry[1] || getDietaryMatchState(merchant, entry[1]) !== MATCH_STATE.MATCH);
  })) return true;
  if ((textHasTerm(text, 'dietary') || textHasTerm(text, 'diet')) &&
      (!profile || profile.dietaryPreference === 'none' || isDietaryUnverified(merchant, profile))) return true;
  if (merchant.price === null && !hasResearchedPrices(merchant) &&
      /\$\s?\d|\b(cheap|cheapest|affordable|inexpensive|budget|pric(e|ed|es|ey)|value for money)\b/i.test(reason)) return true;
  if (!merchant.itemName && !hasResearchedMenu(merchant) &&
      /\b(menu|serves?|serving|signature|famous for|known for|speciali[sz]es in|dish(es)?)\b/i.test(reason)) return true;
  return /\b(rated|ratings?|reviews?|popular|best[- ]?sell(er|ers|ing)|must[- ]try|award(s|-winning)?|famous|favou?rites?|well[- ]known)\b/i.test(reason);
}

// Server-side acceptance of an AI ranking that already passed the eligible-ID check: a "low"
// relevance pick keeps honest fixed wording; an unsupported factual claim drops the AI reason.
// An unverified dietary pick keeps an explicit note so it is never read as verified.
function safeAIReason(ranking, merchant, profile) {
  let reason = ranking.relevance === 'low' ? LOW_RELEVANCE_REASON :
    aiReasonClaimsUnsupportedFacts(ranking.reason, merchant, profile) ? null : ranking.reason;
  if (reason && isDietaryUnverified(merchant, profile)) reason += ' ' + DIETARY_UNVERIFIED_NOTE;
  return reason;
}

// ---------------------------------------------------------------------------
// Merchant research (dietary verification): for an active restriction, Tavily Search looks for the
// exact outlet's pages about THAT requirement, the strongest 1-2 pages are fetched with Tavily
// Extract (batched), and one common analysis request - Groq primary, OpenAI fallback - reads that
// real page content and answers one question per merchant: does this exact merchant offer at least
// one option suitable for the requested diet? ONE validator checks the answer whichever provider
// produced it. No Tavily evidence means no analysis at all, so nothing is answered from model
// memory. Verdicts are cached per place + restriction and reused by every visitor.
// ---------------------------------------------------------------------------
const RESEARCH_STATUS = { SUITABLE: 'SUITABLE', UNKNOWN: 'UNKNOWN', UNSUITABLE: 'UNSUITABLE' };
const RESEARCH_DIETS = ['vegan', 'vegetarian', 'halal'];
const RESEARCH_SOURCE_TYPES = ['certification', 'official', 'social', 'delivery', 'listing', 'community', 'other'];
// Batches of 3 keep each analysis request well inside Groq's free-tier token limit; research stops
// as soon as RESEARCH_TARGET_VERIFIED merchants are verified and never exceeds RESEARCH_MAX_CALLS
// batches (at most RESEARCH_BATCH_SIZE * RESEARCH_MAX_CALLS merchants per Smart Match).
const RESEARCH_BATCH_SIZE = 3;
const RESEARCH_MAX_CALLS = 3;
const RESEARCH_TARGET_VERIFIED = 2;
// v6: verdicts are per restriction (targeted search + extracted pages), not a shared profile.
const RESEARCH_CACHE_VERSION = 'research-v6';
const RESEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RESEARCH_CACHE_MAX_ENTRIES = 1000;
const RESEARCH_MATCHING_ITEM_LIMIT = 5;
const RESEARCH_EVIDENCE_CHARS = 240;
const TAVILY_TIMEOUT_MS = 15000;
const TAVILY_EXTRACT_TIMEOUT_MS = 25000;
const TAVILY_SEARCH_RESULTS = 5;
// Per merchant: the strongest pages are extracted; their cleaned content is size-limited before
// analysis. If every extraction fails, the strongest search snippets are sent instead (marked weak).
const RESEARCH_EXTRACT_URLS_PER_MERCHANT = 2;
const RESEARCH_EXTRACT_CHARS = 1500;
const RESEARCH_EXTRACT_MIN_USEFUL_CHARS = 200;
const RESEARCH_SNIPPET_SOURCES = 3;
const RESEARCH_SNIPPET_CHARS = 300;
// Retrieval intent only (what pages to look for) - never used to judge suitability.
const RESEARCH_QUERY_TERMS = { vegetarian: 'vegetarian menu', vegan: 'vegan menu', halal: 'halal MUIS' };
// Both reasoning providers speak the OpenAI-compatible chat completions API, so one caller serves
// both. Order is priority: the next provider is only tried when the previous one is unavailable,
// errors, or returns output that fails validation. Models are overridable without a code change.
const RESEARCH_PROVIDERS = [
  { id: 'groq', label: 'Groq', keyEnv: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/chat/completions',
    model: function() { return process.env.GROQ_RESEARCH_MODEL || 'openai/gpt-oss-20b'; },
    extra: { reasoning_effort: 'low', max_tokens: 1500 } },
  { id: 'openai', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1/chat/completions',
    model: function() { return process.env.OPENAI_RESEARCH_MODEL || 'gpt-4o-mini'; },
    extra: { max_tokens: 1500 } }
];
const RESEARCH_ANALYSIS_TIMEOUT_MS = 30000;
const merchantResearchCache = new Map();

function clearMerchantResearchCache() {
  merchantResearchCache.clear();
}

// One verdict per real place AND restriction (e.g. "research-v6:<fsq_place_id>:vegetarian") -
// vegetarian-targeted research is never reused as vegan or halal verification.
function merchantResearchKey(merchant, restriction) {
  return RESEARCH_CACHE_VERSION + ':' + (merchant.externalPlaceId || merchant.id) + ':' + restriction;
}

function getCachedMerchantResearch(merchant, restriction) {
  const key = merchantResearchKey(merchant, restriction);
  const entry = merchantResearchCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) { merchantResearchCache.delete(key); return null; }
  return entry.research;
}

function cacheMerchantResearch(merchant, research) {
  if (merchantResearchCache.size >= RESEARCH_CACHE_MAX_ENTRIES) {
    merchantResearchCache.delete(merchantResearchCache.keys().next().value);
  }
  merchantResearchCache.set(merchantResearchKey(merchant, research.restriction),
    { expiresAt: research.researchedAt + RESEARCH_CACHE_TTL_MS, research: research });
}

// Every cached verdict for this merchant (any restriction), keyed by restriction.
function attachCachedResearch(merchant) {
  const research = {};
  RESEARCH_DIETS.forEach(function(diet) {
    const cached = getCachedMerchantResearch(merchant, diet);
    if (cached) research[diet] = cached;
  });
  merchant.research = research;
}

// Menu items that research actually evidenced for this merchant (from any restriction's verdict).
function merchantResearchedItems(merchant) {
  const items = [];
  if (!merchant.research) return items;
  RESEARCH_DIETS.forEach(function(diet) {
    const verdict = merchant.research[diet];
    if (verdict && verdict.identified) {
      verdict.matchingItems.forEach(function(item) {
        if (!items.some(function(existing) { return existing.name === item.name; })) items.push(item);
      });
    }
  });
  return items;
}

function hasResearchedMenu(merchant) {
  return merchantResearchedItems(merchant).length > 0;
}

function hasResearchedPrices(merchant) {
  return merchantResearchedItems(merchant).some(function(item) { return item.price !== null; });
}

function formatResearchedMenuItem(item) {
  return item.name + (item.price !== null ? ' $' + item.price.toFixed(2) : '');
}

// Researched facts shown to the craving ranker: evidenced items plus the active diet's evidence.
function researchSummaryForRanking(merchant, dietaryPreference) {
  const items = merchantResearchedItems(merchant);
  const verdict = dietaryPreference !== 'none' && merchant.research ? merchant.research[dietaryPreference] : null;
  if (!items.length && !(verdict && verdict.identified)) return null;
  return { menu: items.map(formatResearchedMenuItem), dietaryEvidence: verdict && verdict.identified ? verdict.evidence : null };
}

function emptyMerchantResearch(restriction, provider, evidenceStrength) {
  return { restriction: restriction, identified: false, status: RESEARCH_STATUS.UNKNOWN, evidence: '',
    matchingItems: [], sources: [], evidenceStrength: evidenceStrength || 'none',
    researchedAt: Date.now(), researchProvider: provider, method: 'tavily' };
}

function parseHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch (error) { return null; }
}

function urlKey(url) {
  return url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/+$/, '');
}

// Exact identity plus the active requirement's retrieval intent.
function researchSearchQuery(merchant, restriction) {
  const identity = [merchant.merchantName, merchant.parentVenueName, merchant.address, 'Singapore']
    .filter(Boolean).join(' ');
  return (identity.slice(0, 340) + ' ' + RESEARCH_QUERY_TERMS[restriction]).trim();
}

async function tavilyRequest(pathname, body, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    const response = await fetch('https://api.tavily.com/' + pathname, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.TAVILY_API_KEY },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error('Tavily ' + pathname + ' returned ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// One Tavily search. Returns cleaned {title, url, content} results; throws on any failure.
async function tavilySearch(query) {
  const data = await tavilyRequest('search', { query: query, search_depth: 'basic', max_results: TAVILY_SEARCH_RESULTS },
    TAVILY_TIMEOUT_MS);
  if (!data || !Array.isArray(data.results)) throw new Error('malformed Tavily response');
  return data.results.map(function(r) {
    const url = r && typeof r.url === 'string' ? parseHttpUrl(r.url) : null;
    if (!url) return null;
    return { title: typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim().slice(0, 160) : url.hostname,
      url: url.href, content: typeof r.content === 'string' ? r.content.replace(/\s+/g, ' ').trim() : '' };
  }).filter(Boolean);
}

// One batched Tavily Extract call. Returns Map(urlKey -> raw page content) for pages it returned;
// an HTTP/transport failure yields an empty Map (callers fall back to other evidence).
async function tavilyExtract(urls, depth) {
  const pages = new Map();
  if (!urls.length) return pages;
  try {
    const data = await tavilyRequest('extract', { urls: urls, extract_depth: depth }, TAVILY_EXTRACT_TIMEOUT_MS);
    (data && Array.isArray(data.results) ? data.results : []).forEach(function(r) {
      const url = r && typeof r.url === 'string' ? parseHttpUrl(r.url) : null;
      if (url && typeof r.raw_content === 'string') pages.set(urlKey(url), r.raw_content);
    });
  } catch (error) {
    logDiscovery('Merchant research: Tavily extract (' + depth + ') failed (' + error.message + ')');
  }
  return pages;
}

// Generic page-text clean-up and size limiting. Markdown images/links and bare URLs are removed and
// whitespace collapsed. A long page keeps its head; when the requested requirement's own name
// first appears beyond the head, a window around it is kept too. This only chooses WHICH part of a
// long page is sent - suitability is always judged by the reasoning provider, never here.
function cleanExtractedContent(raw, restriction) {
  const text = String(raw || '').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= RESEARCH_EXTRACT_CHARS) return text;
  const head = Math.floor(RESEARCH_EXTRACT_CHARS / 2);
  const index = text.toLowerCase().indexOf(restriction, head);
  if (index === -1) return text.slice(0, RESEARCH_EXTRACT_CHARS);
  const windowStart = Math.max(head, index - Math.floor(head / 3));
  return text.slice(0, head) + ' … ' + text.slice(windowStart, windowStart + RESEARCH_EXTRACT_CHARS - head);
}

// Generic source-quality tiers (lower is stronger) - never merchant-specific domains:
// government/certification, the merchant's own site, its social page, delivery menus, food
// listings, other, then community forums last.
const DELIVERY_HOST_PATTERN = /(^|\.)(grab\.com|foodpanda\.[a-z.]+|deliveroo\.[a-z.]+)$/;
const LISTING_HOST_PATTERN = /(^|\.)(tripadvisor\.[a-z.]+|burpple\.com|yelp\.[a-z.]+|sethlui\.com|eatbook\.sg|hungrygowhere\.com|chope\.co|quandoo\.[a-z.]+|google\.[a-z.]+)$/;
const SOCIAL_HOST_PATTERN = /(^|\.)(facebook\.com|instagram\.com|tiktok\.com)$/;
const COMMUNITY_HOST_PATTERN = /(^|\.)(reddit\.com|quora\.com|hardwarezone\.com\.sg|forums?\.[a-z.]+)$/;
const SOURCE_TIER_TYPES = ['certification', 'official', 'social', 'delivery', 'listing', 'other', 'community'];

function compactName(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
}

function tavilySourceTier(result, merchant) {
  const url = new URL(result.url);
  const host = url.hostname.replace(/^www\./, '');
  const name = compactName(merchant.merchantName).slice(0, 12);
  const website = merchant.website ? parseHttpUrl(merchant.website) : null;
  const ownsHost = (website && website.hostname.replace(/^www\./, '') === host) ||
    (name.length >= 5 && compactName(host.split('.')[0]).indexOf(name) !== -1);
  if (/\.gov(\.[a-z]{2})?$/.test(host)) return 0;
  if (ownsHost) return 1;
  if (SOCIAL_HOST_PATTERN.test(host) && name.length >= 5 && compactName(url.pathname).indexOf(name) !== -1) return 2;
  if (DELIVERY_HOST_PATTERN.test(host)) return 3;
  if (LISTING_HOST_PATTERN.test(host)) return 4;
  if (COMMUNITY_HOST_PATTERN.test(host)) return 6;
  return 5;
}

// Likely about this merchant: its name appears in the source's title, URL or text.
function resultMentionsMerchant(result, merchant) {
  const name = compactName(merchant.merchantName).slice(0, 12);
  return name.length > 0 && compactName(result.title + ' ' + result.url + ' ' + result.content).indexOf(name) !== -1;
}

// Results ordered by exact-merchant relevance, then source quality, then Tavily's own order.
function rankSearchResults(results, merchant) {
  return results.map(function(result, index) {
    return { result: result, relevant: resultMentionsMerchant(result, merchant) ? 0 : 1,
      tier: tavilySourceTier(result, merchant), index: index };
  }).sort(function(a, b) { return (a.relevant - b.relevant) || (a.tier - b.tier) || (a.index - b.index); });
}

function researchAnalysisMessages(evidence, restriction) {
  const label = getDietaryPreferenceLabel(restriction).toLowerCase();
  const definitions = {
    vegetarian: 'SUITABLE when the sources establish at least one real menu item that is vegetarian - explicitly marked vegetarian, or an official menu description/ingredients that clearly make it vegetarian.',
    vegan: 'SUITABLE when the sources establish at least one genuinely vegan item - explicitly marked vegan, or official ingredients that clearly make it vegan (no meat, fish, egg, dairy or honey). A vegetarian item is NOT vegan unless the sources establish that. If sauces/dairy/egg cannot be established, UNKNOWN. Never invent ingredients.',
    halal: 'SUITABLE only with explicit outlet-level evidence: MUIS/official halal certification, an official merchant/outlet halal statement, or a reliable current source explicitly confirming this outlet is halal. A pork-free menu, cuisine or owner name is NOT enough.'
  };
  const system = [
    'You verify ONE dietary requirement (' + label + ') for real Singapore food merchants for the NETS Vouch app.',
    'Use ONLY the supplied sources (extracted web page content, or search snippets when evidenceStrength is "snippets"). Never use your own memory or knowledge of any merchant.',
    'For each merchant answer: based only on these sources, does THIS exact merchant currently offer at least one menu option suitable for ' + label + '?',
    'A mixed menu is fine: other items containing meat or other ingredients do not matter. Do not require the whole restaurant to be ' + label + '.',
    definitions[restriction],
    'identified=true only when the sources clearly concern this exact merchant/outlet (a chain\'s official menu counts for its outlets). With snippets-only evidence be conservative.',
    'UNSUITABLE only when reliable evidence explicitly shows no suitable option (e.g. explicitly non-halal). Otherwise, when evidence is insufficient, UNKNOWN.',
    'Source priority: certification authority, official merchant site/menu, official social/menu page, delivery menu, reputable listing, community sources last. Conflicting strong evidence means UNKNOWN.',
    'matchingItems: up to ' + RESEARCH_MATCHING_ITEM_LIMIT + ' suitable items exactly as a source names them; price as a number (e.g. 8.9) only when shown, else null; sourceUrl = the source URL it came from.',
    'Every URL you output MUST be copied exactly from that merchant\'s sources. evidence: one short sentence (max 25 words), "" when UNKNOWN with nothing to say.',
    'Return one entry per merchant, as valid JSON only:',
    '{"results":[{"merchantId":"<exact id>","identified":true,"status":"SUITABLE|UNKNOWN|UNSUITABLE","evidence":"...","matchingItems":[{"name":"...","price":8.9,"sourceUrl":"https://..."}],"sources":[{"title":"...","url":"https://...","sourceType":"certification|official|social|delivery|listing|community|other"}]}]}'
  ].join('\n');
  const merchants = evidence.map(function(e) {
    const m = e.merchant;
    return { merchantId: m.id, name: m.merchantName, categories: merchantCategoryNames(m),
      parentVenue: m.parentVenueName || null, address: m.address || null, website: m.website || null,
      evidenceStrength: e.strength, sources: e.sources };
  });
  return [{ role: 'system', content: system },
    { role: 'user', content: 'Dietary requirement: ' + label + '\nMerchants:\n' + JSON.stringify(merchants) }];
}

// One OpenAI-compatible chat completions call returning the raw JSON text; throws on any failure.
// Shared by merchant research (default 30 s) and final Smart Match ranking (shorter timeout).
async function callResearchProvider(provider, messages, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(function() { controller.abort(); }, timeoutMs || RESEARCH_ANALYSIS_TIMEOUT_MS);
  try {
    const response = await fetch(provider.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env[provider.keyEnv] },
      body: JSON.stringify(Object.assign({ model: provider.model(), messages: messages,
        response_format: { type: 'json_object' } }, provider.extra))
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('empty response');
    return content;
  } catch (error) {
    throw new Error(controller.signal.aborted ? 'timeout' : error.message);
  } finally {
    clearTimeout(timeout);
  }
}

// Safe text normalisation: collapse whitespace/newlines, drop angle brackets and quote-only
// filler, cap the length.
function normaliseResearchText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().replace(/^["'\s]+$/, '');
  return text.length > max ? text.slice(0, max - 1).trim() + '…' : text;
}

// The ONE validator for every provider, applied at three levels:
//  - whole response (throws, so the next provider is tried): non-JSON, no results array, a
//    merchantId outside the batch or duplicated, or any URL that was not one of the sources
//    supplied for that merchant (source injection);
//  - per merchant: an unusable entry (not an object / no boolean identified) is dropped on its
//    own - not cached, retried later - without affecting the rest of the batch;
//  - per field: a bad status becomes UNKNOWN, a bad item is dropped, a bad price becomes null.
//    SUITABLE/UNSUITABLE need evidence and a cited source that names this merchant (exact
//    outlet); a vegetarian/vegan SUITABLE also needs at least one evidenced matching item.
// Returns { profiles: Map(merchantId -> verdict), stats: { valid, partial, failed } }.
function validateResearchAnalysis(content, evidence, restriction, providerId) {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.results)) throw new Error('missing results');
  const allowedUrls = new Map();
  const identityUrls = new Map();
  const strengths = new Map();
  evidence.forEach(function(e) {
    allowedUrls.set(e.merchant.id, new Set(e.sources.map(function(s) { return urlKey(parseHttpUrl(s.url)); })));
    identityUrls.set(e.merchant.id, new Set(e.sources.filter(function(s) { return resultMentionsMerchant(s, e.merchant); })
      .map(function(s) { return urlKey(parseHttpUrl(s.url)); })));
    strengths.set(e.merchant.id, e.strength);
  });
  const seenIds = new Set();
  parsed.results.forEach(function(item) {
    const id = item && typeof item === 'object' ? item.merchantId : null;
    if (typeof id === 'string' && (!allowedUrls.has(id) || seenIds.has(id))) throw new Error('unexpected merchantId');
    if (typeof id === 'string') seenIds.add(id);
  });
  const suppliedUrl = function(merchantId, value) {
    if (value === null || value === undefined || value === '') return null;
    const url = typeof value === 'string' ? parseHttpUrl(value) : null;
    if (!url || !allowedUrls.get(merchantId).has(urlKey(url))) throw new Error('URL not from supplied sources');
    return url.href;
  };
  const statuses = Object.keys(RESEARCH_STATUS).map(function(k) { return RESEARCH_STATUS[k]; });
  const profiles = new Map();
  const stats = { valid: 0, partial: 0, failed: 0 };
  parsed.results.forEach(function(item) {
    if (!item || typeof item !== 'object' || typeof item.merchantId !== 'string' || typeof item.identified !== 'boolean') {
      stats.failed += 1;
      return;
    }
    const id = item.merchantId;
    let partial = false;
    const verdict = emptyMerchantResearch(restriction, providerId, strengths.get(id));
    const sources = (Array.isArray(item.sources) ? item.sources : []).slice(0, 5).map(function(src) {
      if (!src || typeof src !== 'object') { partial = true; return null; }
      const url = suppliedUrl(id, src.url);
      if (!url) { partial = true; return null; }
      return { title: normaliseResearchText(src.title, 120) || new URL(url).hostname, url: url,
        sourceType: RESEARCH_SOURCE_TYPES.indexOf(src.sourceType) !== -1 ? src.sourceType : 'other' };
    }).filter(Boolean);
    const matchingItems = (Array.isArray(item.matchingItems) ? item.matchingItems : []).slice(0, RESEARCH_MATCHING_ITEM_LIMIT)
      .map(function(m) {
        const name = m && typeof m === 'object' ? normaliseResearchText(m.name, 80) : '';
        if (!name) { partial = true; return null; }
        const priceValid = typeof m.price === 'number' && Number.isFinite(m.price) && m.price >= 0 && m.price < 1000;
        if (m.price !== null && m.price !== undefined && !priceValid) partial = true;
        return { name: name, price: priceValid ? m.price : null, sourceUrl: suppliedUrl(id, m.sourceUrl) };
      }).filter(Boolean);
    let status = statuses.indexOf(item.status) !== -1 ? item.status : null;
    const evidenceText = normaliseResearchText(item.evidence, RESEARCH_EVIDENCE_CHARS);
    if (!status) { partial = true; status = RESEARCH_STATUS.UNKNOWN; }
    const needsItems = restriction !== 'halal' && status === RESEARCH_STATUS.SUITABLE;
    // Exact-outlet identity: a verdict must cite at least one source that actually names this
    // merchant, so a page about a different outlet nearby can never verify it.
    const namesMerchant = sources.some(function(src) { return identityUrls.get(id).has(urlKey(parseHttpUrl(src.url))); });
    if (status !== RESEARCH_STATUS.UNKNOWN &&
        (!evidenceText || !sources.length || !namesMerchant || (needsItems && !matchingItems.length))) {
      partial = true;
      status = RESEARCH_STATUS.UNKNOWN;
    }
    if (item.identified && sources.length) {
      verdict.identified = true;
      verdict.status = status;
      verdict.evidence = status === RESEARCH_STATUS.UNKNOWN && !evidenceText ? '' : evidenceText;
      verdict.matchingItems = matchingItems;
      verdict.sources = sources;
    }
    stats[partial ? 'partial' : 'valid'] += 1;
    profiles.set(id, verdict);
  });
  return { profiles: profiles, stats: stats };
}

// Providers still usable in this Smart Match request (configured, and not rate-limited earlier in it).
function usableResearchProviders(state) {
  return RESEARCH_PROVIDERS.filter(function(p) { return Boolean(process.env[p.keyEnv]) && !state.blocked[p.id]; });
}

// Common analysis: providers in priority order; the first VALID response wins, so OpenAI is never
// called when Groq succeeded. A 429 blocks that provider for the rest of this Smart Match request
// (no hammering) and the SAME evidence goes straight to the next provider. Returns an empty Map
// when no provider is usable or all fail.
async function analyseMerchantResearch(evidence, restriction, state) {
  const messages = researchAnalysisMessages(evidence, restriction);
  const available = usableResearchProviders(state);
  if (!available.length) {
    logDiscovery('Merchant research: AI analysis unavailable (no usable Groq/OpenAI provider)');
    return new Map();
  }
  for (let i = 0; i < available.length; i++) {
    const provider = available[i];
    const next = available[i + 1];
    try {
      const outcome = validateResearchAnalysis(await callResearchProvider(provider, messages), evidence, restriction, provider.id);
      logDiscovery(provider.label + ' research: ' + outcome.stats.valid + ' valid, ' + outcome.stats.partial +
        ' partial, ' + outcome.stats.failed + ' failed');
      return outcome.profiles;
    } catch (error) {
      if (error.message === 'HTTP 429') {
        state.blocked[provider.id] = true;
        logDiscovery(provider.label + ' 429 — stopping ' + provider.label + ' for this request');
      } else {
        logDiscovery('Merchant research: ' + provider.label + ' failed (' + error.message + ')');
      }
      logDiscovery(next ? 'Using ' + next.label + ' fallback for the same evidence' : 'Research fallback: unavailable');
    }
  }
  return new Map();
}

// Researches one batch for one restriction:
//  1. a targeted Tavily search per merchant (in parallel);
//  2. the strongest RESEARCH_EXTRACT_URLS_PER_MERCHANT pages per merchant are fetched in ONE
//     batched basic Tavily Extract call; strong (certification/official/social) pages that came
//     back unusable get one batched advanced retry;
//  3. merchants with no usable extracted page fall back to their strongest snippets (weak);
//  4. one common analysis request over the whole batch.
// Returns Map(merchantId -> verdict). A merchant whose search failed is absent (not cached,
// retried later); one whose search found nothing gets a cached UNKNOWN without any LLM call.
async function researchMerchants(batch, restriction, state) {
  const profiles = new Map();
  if (!batch.length) return profiles;
  if (!process.env.TAVILY_API_KEY) {
    logDiscovery('Merchant research unavailable: Tavily not configured (no web evidence, no AI guessing)');
    return profiles;
  }
  logDiscovery('Merchant research batch (' + restriction + '): ' + batch.length + ' merchants');
  const searched = await Promise.all(batch.map(async function(merchant) {
    try {
      return { merchant: merchant, ranked: rankSearchResults(await tavilySearch(researchSearchQuery(merchant, restriction)), merchant) };
    } catch (error) {
      logDiscovery('Merchant research: Tavily search failed for ' + merchant.id + ' (' + error.message + ')');
      return null;
    }
  }));
  const withResults = [];
  searched.forEach(function(entry) {
    if (!entry) return;
    if (entry.ranked.length) withResults.push(entry);
    else profiles.set(entry.merchant.id, emptyMerchantResearch(restriction, 'none'));
  });
  if (!withResults.length) return profiles;

  const picks = withResults.map(function(entry) { return entry.ranked.slice(0, RESEARCH_EXTRACT_URLS_PER_MERCHANT); });
  const uniqueUrls = function(list) {
    return list.map(function(p) { return p.result.url; }).filter(function(url, i, all) { return all.indexOf(url) === i; });
  };
  const pages = await tavilyExtract(uniqueUrls([].concat.apply([], picks)), 'basic');
  const usable = function(pick) {
    const raw = pages.get(urlKey(parseHttpUrl(pick.result.url)));
    return typeof raw === 'string' && cleanExtractedContent(raw, restriction).length >= RESEARCH_EXTRACT_MIN_USEFUL_CHARS;
  };
  const retry = [].concat.apply([], picks).filter(function(pick) { return pick.tier <= 2 && !usable(pick); });
  if (retry.length) {
    (await tavilyExtract(uniqueUrls(retry), 'advanced')).forEach(function(raw, key) { pages.set(key, raw); });
  }

  const evidence = withResults.map(function(entry, i) {
    const extracted = picks[i].filter(usable).map(function(pick) {
      return { title: pick.result.title, url: pick.result.url, sourceType: SOURCE_TIER_TYPES[pick.tier],
        content: cleanExtractedContent(pages.get(urlKey(parseHttpUrl(pick.result.url))), restriction) };
    });
    const strength = extracted.length ? 'extracted' : 'snippets';
    const sources = extracted.length ? extracted : entry.ranked.slice(0, RESEARCH_SNIPPET_SOURCES).map(function(pick) {
      return { title: pick.result.title, url: pick.result.url, sourceType: SOURCE_TIER_TYPES[pick.tier],
        content: pick.result.content.slice(0, RESEARCH_SNIPPET_CHARS) };
    });
    logDiscovery('Research ' + entry.merchant.merchantName + ': ' + entry.ranked.length + ' search results, ' +
      extracted.length + '/' + picks[i].length + ' pages extracted (' + strength + ')');
    return { merchant: entry.merchant, strength: strength, sources: sources };
  });
  (await analyseMerchantResearch(evidence, restriction, state)).forEach(function(profile, id) { profiles.set(id, profile); });
  return profiles;
}

// Runs after every deterministic rule. Cached verdicts are attached to every Foursquare candidate
// for free. New research is only MANDATORY for an active dietary restriction: the nearest
// candidates without a verdict for that restriction are researched RESEARCH_BATCH_SIZE at a time,
// stopping as soon as RESEARCH_TARGET_VERIFIED merchants are verified, after RESEARCH_MAX_CALLS
// batches, or once no reasoning provider is usable (e.g. Groq rate-limited with no OpenAI) - so
// no Tavily credits are spent on evidence nobody can analyse. With a restriction only
// research-verified SUITABLE merchants are returned (original order); researchUnavailable flags
// that research was needed but produced nothing at all, as opposed to "nothing verified".
async function applyMerchantResearch(candidates, restriction) {
  candidates.forEach(function(m) { if (isPlacesMerchant(m)) attachCachedResearch(m); });
  if (!restriction || restriction === 'none') return { candidates: candidates, researchUnavailable: false };
  const isVerified = function(m) { return getDietaryMatchState(m, restriction) === MATCH_STATE.MATCH; };
  const pending = candidates.filter(function(m) { return isPlacesMerchant(m) && !m.research[restriction]; })
    .sort(function(a, b) { return merchantDistanceMetres(a) - merchantDistanceMetres(b); });
  const state = { blocked: {} };
  let researchCalls = 0;
  let attempted = 0;
  let obtained = 0;
  while (pending.length && researchCalls < RESEARCH_MAX_CALLS &&
      candidates.filter(isVerified).length < RESEARCH_TARGET_VERIFIED) {
    if (researchCalls > 0 && (!process.env.TAVILY_API_KEY || !usableResearchProviders(state).length)) break;
    const batch = pending.splice(0, RESEARCH_BATCH_SIZE);
    researchCalls += 1;
    attempted += batch.length;
    const researched = await researchMerchants(batch, restriction, state);
    batch.forEach(function(merchant) {
      const research = researched.get(merchant.id);
      if (!research) return; // failed: UNKNOWN now, not cached, retried later
      obtained += 1;
      cacheMerchantResearch(merchant, research);
      merchant.research[restriction] = research;
    });
  }
  const verified = candidates.filter(isVerified);
  logDiscovery(getDietaryPreferenceLabel(restriction) + ' verified: ' + verified.length + ' of ' + candidates.length +
    ' (' + researchCalls + ' research batch(es))');
  return { candidates: verified, researchUnavailable: verified.length === 0 && attempted > 0 && obtained === 0 };
}

function buildRankingMessages(profile, eligible, feedbackItems, demo) {
  const merchantSummaries = eligible.map(function(m) {
    return {
      id: m.id,
      name: m.merchantName,
      categories: merchantCategoryNames(m),
      parentVenue: m.parentVenueName || null,
      dish: m.itemName || null,
      price: m.price !== null ? '$' + m.price.toFixed(2) : 'unknown',
      distance: m.distanceLabel || m.distanceMinutes + ' min walk (demo estimate)',
      distanceMetres: Number.isFinite(m.distanceMetres) ? m.distanceMetres : null,
      cuisine: merchantCuisineTags(m).length ? merchantCuisineTags(m).join(', ') : 'unknown',
      dietary: m.dietary.length ? m.dietary.join(', ') : 'unknown',
      dietaryStatus: profile.dietaryPreference === 'none' ? 'no restriction' :
        getDietaryMatchState(m, profile.dietaryPreference) === MATCH_STATE.MATCH ? 'verified' : 'unknown',
      // Menu items evidenced by validated web research (cached per merchant + diet), when available.
      research: researchSummaryForRanking(m, profile.dietaryPreference),
      matchesCurrentMood: merchantMatchesMood(m, profile.moodCuisine),
      // "MEAL" = provider types confirm a meal place; "UNCERTAIN" = types do not confirm it.
      mealEligibility: classifyMealEligibility(m),
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
    'Pick the single best merchant for this user from the supplied "Eligible merchants" list only. Every listed merchant is already allowed; never mention or invent any other place.',
    '',
    'CRAVING: the user may type any free-text craving - specific ("crispy chicken"), a mood ("warm comfort food"), or vague ("surprise me"). Interpret it semantically and judge each merchant ONLY from its supplied name, categories, cuisine tags, dish (when given), research (current menu evidence from web research, when present) and parentVenue. A researched menu that clearly fits the craving is strong evidence.',
    'For a specific craving, judge the user\'s OWN words ("Specific craving"), understanding local and colloquial food terms semantically. Evidence priority: (1) a research.menu item or dish that matches; (2) categories/cuisine that strongly match; (3) a merchant name that semantically matches; (4) a broadly related cuisine; (5) a generic "Restaurant" with no evidence - which ranks BELOW any candidate with evidence, even if nearer. Never assume a generic restaurant serves the craved food.',
    'Being returned by the discovery search is weak retrieval evidence only - it does not prove the merchant sells the craved food; never claim it serves something unless dish or research.menu shows it.',
    'mealEligibility "UNCERTAIN" means the provider type data does not confirm a meal place: prefer a "MEAL" candidate with comparable evidence, and never pick an UNCERTAIN one merely because it is nearer.',
    'relevance: "high" when those facts clearly fit the craving; "medium" when they plausibly relate; "low" when nothing clearly fits. Always still pick the best available merchant - never refuse.',
    'For a vague craving or none, pick a good nearby option using mood and distance.',
    'Every listed merchant is already within the user\'s walking limit. Distance matters, but a clearly better craving fit that is a little farther beats a nearer weak fit; when relevance is similar, prefer the nearer merchant (distanceMetres). A generic category such as "Restaurant" is uncertain, not a fit.',
    'matchesCurrentMood being false is neutral, not a confirmed mismatch.',
    'BUDGET: budgetFit "within" only when prices in price or research.menu show relevant items at or under the user\'s budget, "over" only when they are all above it, otherwise "unknown". Never invent prices; an unknown price is not a reason to reject.',
    'DIETARY: the server has already applied the user\'s dietary restriction - never judge dietary suitability yourself. dietaryStatus "verified" means factual evidence exists; "unknown" means suitability is NOT verified, so never call that merchant halal, vegetarian, vegan or suitable for the user\'s diet.',
    'When parentVenue is set, the candidate is a specific stall inside that venue - recommend the stall, not the venue.',
    '',
    'REASON: exactly one short sentence, at most 160 characters, explaining why THIS candidate fits better than the other listed ones. Use ONLY supplied facts: the user\'s craving or mood, the candidate\'s categories, its supplied distance, a dish or research.menu item and its price, or dietaryStatus "verified".',
    'Use relative, conservative wording about fit and distance, e.g. "A stronger match for your spicy chicken craving while still within your walking range." or "Its Chicken Restaurant category fits your craving better than the nearer options."',
    'Never convert maxWalkingMinutes into a claimed travel time: it is only an eligibility preference. If no actual travel duration is supplied, say "within your walking range" or quote the supplied distance in metres (e.g. "685 m away") - never "a 10-minute walk", "5 minutes away" or "a few minutes\' walk".',
    'Mention a menu item, dish or price ONLY if it appears in dish, price or research.menu. Call a merchant halal, vegetarian, vegan or suitable for a diet ONLY if dietaryStatus is "verified".',
    'Never mention popularity, ratings, reviews, awards, reputation, best-sellers, food quality or taste, and never use words such as "famous", "known for", "serves", "signature", "menu", "cheap", "affordable" or "the best" unless that exact fact was supplied.',
    'If relevance is "low", say it is the closest available fit - never claim it satisfies the craving. Avoid vague reasons like "Good option for you."',
    '',
    'Reply with valid JSON only — no markdown, no extra text.'
  ].join('\n');

  const userParts = [
    'User profile:',
    '- Dietary: ' + profile.dietaryPreference,
    '- Budget: $' + profile.budget,
    '- maxWalkingMinutes: ' + profile.maxDistanceMinutes + ' (an eligibility limit only - NOT a travel time)',
    '- Food mood today: ' + (profile.moodCuisine && profile.moodCuisine !== 'any' ? getMoodCuisineLabel(profile.moodCuisine) : 'no preference'),
    ''
  ];
  if (profile.craving) userParts.splice(userParts.length - 1, 0, '- Specific craving: ' + profile.craving);
  const searchIntent = isSpecificCraving(profile.craving) &&
    eligible.some(function(m) { return m.fromExpandedSearch; }) ? getCachedSearchIntent(profile.craving) : null;
  if (searchIntent && normaliseCravingQuery(searchIntent.searchQuery) !== normaliseCravingQuery(profile.craving)) {
    userParts.splice(userParts.length - 1, 0, '- Discovery search used (retrieval only, NOT the user\'s words): ' +
      searchIntent.searchQuery);
  }
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
    'Output: {"merchantId":"<exact id>","relevance":"high|medium|low","budgetFit":"within|over|unknown","reason":"<one sentence, max 160 characters>"}'
  );
  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') }
  ];
}


// Final Smart Match ranking providers, in priority order. Both speak the OpenAI-compatible chat
// completions API (see callResearchProvider). The next provider is tried only when the previous one
// has no key, errors (HTTP failure, 429, timeout) or returns output that fails validation - never
// with a retry of the same provider. Models are overridable without a code change.
const RANKING_PROVIDERS = [
  { id: 'groq', label: 'GROQ', keyEnv: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/chat/completions',
    model: function() { return process.env.GROQ_RANKING_MODEL || 'openai/gpt-oss-20b'; },
    extra: { reasoning_effort: 'low', max_tokens: 800 } },
  { id: 'openai', label: 'OPENAI', keyEnv: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1/chat/completions',
    model: function() { return process.env.OPENAI_RANKING_MODEL || 'gpt-4o-mini'; },
    extra: { max_tokens: 150 } }
];

function availableRankingProviders() {
  return RANKING_PROVIDERS.filter(function(provider) { return Boolean(process.env[provider.keyEnv]); });
}

// The ONE ranking validator for every provider. Any failure throws so the next provider is tried:
// non-JSON, a merchantId outside the candidates actually sent, a bad relevance (the existing
// high|medium|low field; "confidence" is accepted as an alias), or an unsafe/overlong reason.
// Unsupported factual claims in an otherwise valid reason are handled by safeAIReason.
function validateRankingResponse(content, candidates) {
  const text = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('ranking is not a JSON object');
  if (typeof parsed.merchantId !== 'string' || !findMerchantById(candidates, parsed.merchantId)) {
    throw new Error('merchantId outside the candidate list');
  }
  const relevance = parsed.relevance !== undefined ? parsed.relevance : parsed.confidence;
  if (AI_RELEVANCE_LEVELS.indexOf(relevance) === -1) throw new Error('invalid relevance');
  if (typeof parsed.reason !== 'string' || !parsed.reason.trim() || parsed.reason.trim().length > 160 ||
      /[\r\n<>]/.test(parsed.reason)) {
    throw new Error('missing or unsafe reason');
  }
  const budgetFit = ['within', 'over', 'unknown'].indexOf(parsed.budgetFit) !== -1 ? parsed.budgetFit : 'unknown';
  return { merchantId: parsed.merchantId, relevance: relevance, budgetFit: budgetFit, reason: parsed.reason.trim() };
}

// Groq primary -> OpenAI fallback over the SAME prompt and candidates. Ranking only reads the
// already-prepared candidate data - no web search, discovery or research calls. Throws when no
// provider yields a valid ranking so the caller uses the deterministic fallback.
async function getAIRanking(profile, eligible, feedbackItems, demo) {
  const messages = buildRankingMessages(profile, eligible, feedbackItems, demo);
  const providers = availableRankingProviders();
  const deadline = Date.now() + AI_RANKING_TIMEOUT_MS;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const remaining = deadline - Date.now();
    if (remaining < AI_RANKING_MIN_ATTEMPT_MS) {
      logDiscovery('Ranking time budget spent - skipping ' + provider.label);
      break;
    }
    try {
      const content = await callResearchProvider(provider, messages, remaining);
      const ranking = validateRankingResponse(content, eligible);
      logDiscovery('Smart Match ranker: ' + provider.label);
      ranking.provider = provider.label;
      return ranking;
    } catch (error) {
      logDiscovery((provider.id === 'groq' ? 'Groq' : 'OpenAI') + ' ranking failed: ' + error.message);
    }
  }
  throw new Error(providers.length ? 'no ranking provider returned a valid ranking' : 'no ranking provider key');
}

function getEligibleMerchants(profile, nearbyMerchants, rejectedMerchantIds, demo) {
  return filterByMealEligibility(nearbyMerchants.filter(function(merchant) {
    return merchant.available &&
      !wasMerchantRejected(merchant.id, rejectedMerchantIds) &&
      merchantMatchesProfile(merchant, profile) &&
      Boolean(findCampaignForMerchant(merchant, demo));
  }), profile);
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

// Dietary state for filtering/ranking/reasons. For a real (Foursquare) merchant it comes ONLY from
// validated web research of that merchant - never from its name, category or cuisine words.
// Curated local demo merchants (the offline/no-key Open House fallback) carry complete records.
function getDietaryMatchState(merchant, dietaryPreference) {
  if (!dietaryPreference || dietaryPreference === 'none') return MATCH_STATE.UNKNOWN;
  if (isPlacesMerchant(merchant)) {
    const verdict = merchant.research && merchant.research[dietaryPreference];
    if (verdict && verdict.status === RESEARCH_STATUS.SUITABLE) return MATCH_STATE.MATCH;
    if (verdict && verdict.status === RESEARCH_STATUS.UNSUITABLE) return MATCH_STATE.NON_MATCH;
    return MATCH_STATE.UNKNOWN;
  }
  const dietary = merchant.dietary || [];
  if (dietary.indexOf(dietaryPreference) !== -1 ||
      (dietaryPreference === 'vegetarian' && dietary.indexOf('vegan') !== -1)) return MATCH_STATE.MATCH;
  return dietary.length > 0 ? MATCH_STATE.NON_MATCH : MATCH_STATE.UNKNOWN;
}

function isDietaryUnverified(merchant, profile) {
  return profile.dietaryPreference !== 'none' &&
    getDietaryMatchState(merchant, profile.dietaryPreference) !== MATCH_STATE.MATCH;
}
const DIETARY_UNVERIFIED_NOTE = 'Dietary suitability has not been verified.';

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
    // An UNCERTAIN merchant type never beats a confirmed meal merchant merely by being nearer.
    if (classifyMealEligibility(merchant) === MEAL_ELIGIBILITY.UNCERTAIN) score -= 60;
    if (merchant.price !== null) score += Math.max(0, profile.budget - merchant.price);
    // No semantic craving understanding here (that is the AI's job) - only the user's own words
    // literally appearing in the merchant's factual name/category data earn a nudge.
    if (merchantMentionsCraving(merchant, profile.craving)) score += 100;
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
  const cravingMentions = isSpecificCraving(profile.craving) ?
    candidates.filter(function(m) { return merchantMentionsCraving(m, profile.craving); }).length : null;
  if (cravingMentions !== null) lines.push('Literal craving mentions: ' + cravingMentions);
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
      ' cravingMention=' + merchantMentionsCraving(m, profile.craving));
  });
  logDiscovery(lines.join('\n'));
}

// Bounds the AI prompt's candidate list only - never the deterministic eligible pool itself.
// Literal craving mentions are kept first. For a specific craving the remaining order is the
// discovery order (craving-query results before any broad "food" fallback results), so nearby
// generic places cannot crowd out what Foursquare returned for the craving; otherwise nearest.
function capCandidatesForPrompt(candidates, profile, limit) {
  if (candidates.length <= limit) return candidates;
  const specific = isSpecificCraving(profile.craving);
  const scored = candidates.map(function(m, index) {
    return { m: m, mention: merchantMentionsCraving(m, profile.craving) ? 1 : 0,
      order: specific ? index : merchantDistanceMetres(m) };
  });
  scored.sort(function(a, b) { return (b.mention - a.mention) || (a.order - b.order); });
  return scored.slice(0, limit).map(function(s) { return s.m; });
}
// Keeps the ranking request small and fast; Google returns at most 20 per request anyway.
const AI_PROMPT_CANDIDATE_LIMIT = 12;

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
    const recyclable = filterByMealEligibility(nearbyMerchants.filter(function(m) {
      return m.available && m.id !== justRejectedId &&
        shown.indexOf(m.id) !== -1 && merchantMatchesProfile(m, profile) && Boolean(findCampaignForMerchant(m, demo));
    }), profile);
    recyclable.sort(function(a, b) { return shown.indexOf(a.id) - shown.indexOf(b.id); });
    if (recyclable.length > 0) { eligible = recyclable; recycled = true; }
  }
  if (eligible.length === 0) return { merchant: null, reason: null, noCloserMatch: false };

  const lastFeedback = getLastFeedback(feedbackItems);
  const constraint = applyDeterministicRejectionConstraint(eligible, lastFeedback);
  if (constraint.candidates.length === 0) return { merchant: null, reason: null, noCloserMatch: constraint.noCloserMatch };
  // Merchant research runs before craving ranking: with a dietary restriction only
  // research-verified SUITABLE merchants reach the AI.
  const research = await applyMerchantResearch(constraint.candidates, profile.dietaryPreference);
  const candidates = research.candidates;
  logSmartMatchDebug(profile, feedbackItems, candidates, constraint.noCloserMatch, excludedIds.length, recycled);
  if (candidates.length === 0) {
    return { merchant: null, reason: null, noCloserMatch: false,
      noVerifiedDietary: !research.researchUnavailable, researchUnavailable: research.researchUnavailable };
  }

  // Step 13/14: AI only ever sees the deterministically-constrained subset, and its choice is
  // validated against that same subset - it cannot resurrect a merchant the "too far" rule or
  // the seen/rejected history removed.
  if (availableRankingProviders().length) {
    try {
      const promptCandidates = capCandidatesForPrompt(candidates, profile, AI_PROMPT_CANDIDATE_LIMIT);
      const ranking = await getAIRanking(profile, promptCandidates, feedbackItems, demo);
      const aiMerchant = findMerchantById(promptCandidates, ranking.merchantId);
      if (aiMerchant) {
        logDiscovery('Selection source: ' + ranking.provider + ' -> ' + aiMerchant.merchantName +
          ' (relevance: ' + ranking.relevance + ')');
        // A budget verdict needs a real price behind it.
        const budgetFit = aiMerchant.price === null && !hasResearchedPrices(aiMerchant) ? 'unknown' : ranking.budgetFit;
        return { merchant: aiMerchant, reason: safeAIReason(ranking, aiMerchant, profile), budgetFit: budgetFit,
          relevance: ranking.relevance, noCloserMatch: false };
      }
    } catch (error) {
      console.log('AI ranking unavailable, using rule-based fallback:', error.message);
    }
  }

  // Step 15: fallback ranks the identical constrained subset - never a superset AI would have seen.
  const fallbackMerchant = getFallbackRecommendation(candidates, feedbackItems, profile);
  logDiscovery('Smart Match ranker: RULES');
  logDiscovery('Selection source: FALLBACK -> ' + (fallbackMerchant ? fallbackMerchant.merchantName : 'none'));
  return { merchant: fallbackMerchant, reason: null, noCloserMatch: false };
}

// Server-generated "Why this match" reasons, shown whenever there is no (safe) AI reason. Every line
// is a checkable fact: craving fit only from the user's own words in the merchant's name/categories
// or the AI ranker's own high/medium relevance judgement for this pick; dietary only when verified;
// budget only from a real price; distance from the hard walking-range rule already applied.
function getMatchReasons(profile, merchant, feedbackItems, aiRelevance) {
  const reasons = [];
  const lastFeedback = getLastFeedback(feedbackItems);
  if (isSpecificCraving(profile.craving)) {
    if (aiRelevance === 'high' || merchantMentionsCraving(merchant, profile.craving)) {
      reasons.push('Matches your current craving');
    } else if (aiRelevance === 'medium') {
      reasons.push('A likely fit for your craving');
    }
  }
  if (profile.dietaryPreference !== 'none') {
    reasons.push(isDietaryUnverified(merchant, profile) ? DIETARY_UNVERIFIED_NOTE : 'Verified for your dietary preference');
  }
  if (merchant.price !== null && merchant.price <= profile.budget) {
    reasons.push('Within your budget');
  } else if (merchant.price === null && merchantResearchedItems(merchant).some(function(item) {
    return item.price !== null && item.price <= profile.budget;
  })) {
    reasons.push('A researched menu option fits your budget');
  }
  if (merchantMatchesMood(merchant, profile.moodCuisine)) {
    reasons.push('Matches your mood today');
  }
  if (lastFeedback && lastFeedback.reason === 'too-far' &&
      merchantDistanceMetres(merchant) < merchantDistanceMetres(lastFeedback)) {
    reasons.push('Closer than your last match');
  } else if (merchant.distanceMinutes <= profile.maxDistanceMinutes) {
    reasons.push('Within your walking range');
  }
  if (lastFeedback && lastFeedback.reason === 'too-expensive' &&
      merchant.price !== null && lastFeedback.price !== null &&
      merchant.price < lastFeedback.price) {
    reasons.push('Costs less than your last match');
  }
  if (reasons.length === 0) reasons.push('Best available match from the eligible nearby options');
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

function getResearchDietaryTagLabel(merchant, profile) {
  if (!merchant || profile.dietaryPreference === 'none') return null;
  if (merchant.dietary && merchant.dietary.length) {
    return getDietaryPreferenceLabel(merchant.dietary[merchant.dietary.length - 1]);
  }
  if (merchant.research) {
    const verdict = merchant.research[profile.dietaryPreference];
    if (verdict && verdict.status === RESEARCH_STATUS.SUITABLE) {
      return getDietaryPreferenceLabel(profile.dietaryPreference);
    }
  }
  return null;
}

function matchView(demo, recommendation) {
  return {
    recommendation: recommendation,
    // The existing "Using demo location" notice also covers a real location whose live discovery
    // failed, so curated Woodlands merchants never pass as live results elsewhere.
    locationNotice: !demo.discoveryLocation || Boolean(demo.nearbyDemoFallback),
    campaign: recommendation ? findCampaignForMerchant(recommendation, demo) : null,
    matchReasons: recommendation ? getMatchReasons(demo.profile, recommendation, demo.recommendationFeedback,
      demo.selectedMerchantRelevance) : [],
    rejectionReasons: rejectionReasons, recommendationAccepted: demo.recommendationAccepted,
    dailyRewardEarned: recommendation ? hasEarnedNormalRewardToday(demo, recommendation.id) : false,
    vouchCount: recommendation ? countVouches(demo, recommendation.id) : 0,
    dietaryTagLabel: recommendation ? getResearchDietaryTagLabel(recommendation, demo.profile) : null,
    aiReason: demo.selectedMerchantReason || null,
    profile: demo.profile,
    dietaryLabel: getDietaryPreferenceLabel(demo.profile.dietaryPreference),
    dietaryPreferenceOptions: dietaryPreferenceOptions,
    moodCuisineLabel: getMoodCuisineLabel(demo.profile.moodCuisine || 'any'),
    moodCuisineOptions: moodCuisineOptions,
    resultDisplay: recommendation ? smartMatchResultDisplay(demo, recommendation) : null
  };
}

// Display-only extras for the Smart Match result card; computed after the merchant is chosen and
// never fed back into matching. demoVouches is SIMULATED sample social proof (stable per merchant)
// plus the real Payment-Verified Vouches made in this demo.
function smartMatchResultDisplay(demo, recommendation) {
  const photo = smartMatchResult.getCachedMerchantPhoto(recommendation);
  return {
    halal: resultHalalTag(recommendation) || { tone: 'unknown', label: 'Halal not verified' },
    demoVouches: smartMatchResult.demoVouchCount(recommendation.id) + countVouches(demo, recommendation.id),
    photo: photo ? { src: '/smart-match/photo/' + encodeURIComponent(recommendation.id), attributions: photo.attributions } : null,
    // Tapping the result map opens Google Maps walking directions. Origin is the visitor's real
    // session location; with demo location/data Google Maps routes from the device instead.
    walking: smartMatchResult.buildWalkingDirections(
      !demo.discoveryLocation || demo.nearbyDemoFallback ? null : demo.discoveryLocation, recommendation)
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
// Health check endpoint — called by Vercel Cron (vercel.json) every 15 minutes.
// Returns 200 with status JSON so ops can verify the app is alive and key services respond.
app.get('/health', async function(req, res) {
  const checks = {
    app: 'ok',
    foursquare: 'unknown',
    openai: process.env.OPENAI_API_KEY ? 'configured' : 'missing',
    tavily: process.env.TAVILY_API_KEY ? 'configured' : 'missing',
    foursquareKey: process.env.FOURSQUARE_API_KEY ? 'configured' : 'missing'
  };
  // Lightweight Foursquare ping — uses a known-good Singapore location.
  if (process.env.FOURSQUARE_API_KEY) {
    try {
      const pingUrl = new URL('https://places-api.foursquare.com/places/search');
      pingUrl.searchParams.set('ll', '1.3521,103.8198');
      pingUrl.searchParams.set('radius', '100');
      pingUrl.searchParams.set('limit', '1');
      pingUrl.searchParams.set('fields', 'fsq_place_id');
      const ctrl = new AbortController();
      const t = setTimeout(function() { ctrl.abort(); }, 4000);
      const r = await fetch(pingUrl, {
        signal: ctrl.signal,
        headers: { 'Authorization': 'Bearer ' + process.env.FOURSQUARE_API_KEY,
          'X-Places-Api-Version': FOURSQUARE_API_VERSION }
      });
      clearTimeout(t);
      checks.foursquare = r.ok ? 'ok' : 'error_' + r.status;
    } catch (e) { checks.foursquare = 'timeout_or_error'; }
  }
  const allOk = checks.app === 'ok' && checks.foursquare !== 'timeout_or_error' &&
    !String(checks.foursquare).startsWith('error_4');
  res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', checks: checks, ts: new Date().toISOString() });
});

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
    locationCache.delete(req.session.id);
    logDiscovery('Smart Match location source: demo fallback');
  } else if (validCoordinates(req.body.latitude, req.body.longitude)) {
    demo.discoveryLocation = { latitude: req.body.latitude, longitude: req.body.longitude };
    locationCache.set(req.session.id, demo.discoveryLocation);
    logDiscovery('Smart Match location source: browser');
  } else {
    return res.sendStatus(400);
  }
  demo.locationAttempted = true;
  demo.nearbyMerchants = [];
  demo.nearbySource = null;
  demo.nearbyDemoFallback = false;
  demo.nearbyRefreshAttempted = false;
  if (!demo.recommendationAccepted) {
    demo.selectedMerchantId = null;
    demo.selectedMerchantReason = null;
    demo.selectedMerchantRelevance = null;
  }
  res.sendStatus(204);
});

app.get('/smart-match/result', async function(req, res) {
  try {
    const demo = req.session.demo;
    // Coordinates in the URL take priority — this is how GPS works across cold-started
    // Vercel instances where locationCache and session are empty.
    const qLat = parseFloat(req.query.lat);
    const qLng = parseFloat(req.query.lng);
    if (validCoordinates(qLat, qLng)) {
      demo.discoveryLocation = { latitude: qLat, longitude: qLng };
      demo.locationAttempted = true;
      locationCache.set(req.session.id, demo.discoveryLocation);
    } else if (!demo.locationAttempted && locationCache.has(req.session.id)) {
      demo.discoveryLocation = locationCache.get(req.session.id);
      demo.locationAttempted = true;
    }
    let recommendation = findMerchantForDemo(demo, demo.selectedMerchantId);
    let noVerifiedDietary = false;
    let researchUnavailable = false;
    if (!recommendation) {
      if (!demo.nearbyMerchants.length) {
        const nearby = await getNearbyMerchants(demo.discoveryLocation, demo.user.id, demo.profile.craving,
          demo.profile.maxDistanceMinutes);
        demo.nearbyMerchants = nearby.merchants;
        demo.nearbySource = nearby.source;
        // Explicit server state: a real browser location that only produced curated demo merchants.
        demo.nearbyDemoFallback = Boolean(nearby.demoFallback && demo.discoveryLocation);
      }
      let result = await getSmartRecommendation(demo.profile, demo.nearbyMerchants,
        demo.rejectedMerchantIds, demo.recommendationFeedback, demo, demo.shownMerchantIds);
      recommendation = result.merchant;
      // A "too far" rejection with no closer candidate is a deterministic outcome, not a
      // genuine batch exhaustion - never silently re-query Foursquare to paper over it (Step 6).
      // No verified dietary match is also deterministic - re-querying would only add web research.
      if (!recommendation && !result.noCloserMatch && !result.noVerifiedDietary && !result.researchUnavailable &&
          !demo.nearbyRefreshAttempted) {
        demo.nearbyRefreshAttempted = true;
        const gotNewMerchants = await refreshNearbyBatch(demo);
        if (gotNewMerchants) {
          result = await getSmartRecommendation(demo.profile, demo.nearbyMerchants,
            demo.rejectedMerchantIds, demo.recommendationFeedback, demo, demo.shownMerchantIds);
          recommendation = result.merchant;
        }
      }
      noVerifiedDietary = Boolean(!recommendation && result.noVerifiedDietary);
      researchUnavailable = Boolean(!recommendation && result.researchUnavailable);
      if (recommendation) {
        demo.selectedMerchantId = recommendation.id;
        demo.selectedMerchantReason = result.reason;
        demo.selectedMerchantRelevance = result.relevance || null;
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
      locationNotice: !demo.discoveryLocation, noCloserMatch: false, noVerifiedDietary: noVerifiedDietary,
      researchUnavailable: researchUnavailable });
    // Photo + halal verdict for the ONE selected merchant, settled within the speed budget (cached;
    // anything not ready shows no photo / "Halal not verified" this time, and is instant next time).
    await settleResultExtras(recommendation);
    res.render('smart-match-card', matchView(demo, recommendation));
  } catch (err) {
    console.error('smart-match/result error:', err);
    res.status(500).send('<p>Smart Match unavailable — <a href="/home">return home</a></p>');
  }
});

// Halal tag for the result card - display only, never used by ranking. It reads the EXISTING
// evidence-based merchant research (Tavily + Groq/OpenAI, cached 24 h per place): green "Halal" only
// with verified halal evidence, orange "Non-halal" only with evidence it is not, otherwise a neutral
// "Halal not verified" - never guessed from the name, cuisine or a Google type. Curated demo
// merchants use their own dietary records. Returns null while a Places merchant has no verdict yet.
function resultHalalTag(merchant) {
  if (isPlacesMerchant(merchant)) {
    attachCachedResearch(merchant);
    if (!merchant.research || !merchant.research.halal) return null;
  }
  const state = getDietaryMatchState(merchant, 'halal');
  if (state === MATCH_STATE.MATCH) return { tone: 'halal', label: 'Halal' };
  if (state === MATCH_STATE.NON_MATCH) return { tone: 'non-halal', label: 'Non-halal' };
  return { tone: 'unknown', label: 'Halal not verified' };
}

// Runs the existing halal research for the ONE selected merchant while the loading screen is still
// showing, so the card arrives with its final tag. Research that is still running when the result is
// ready keeps going in the background and fills the 24 h cache, so the next showing is instant.
async function ensureResultHalalVerdict(merchant) {
  if (resultHalalTag(merchant)) return;
  await applyMerchantResearch([merchant], 'halal').catch(function() { /* shown as not verified */ });
}

// The photo + halal extras may hold the result for at most this long (speed budget); anything slower
// finishes in the background and is cached for the next showing.
const RESULT_EXTRAS_WAIT_MS = 500;
async function settleResultExtras(merchant) {
  const extras = Promise.all([
    smartMatchResult.ensureMerchantPhoto(merchant, process.env.GOOGLE_PLACES_API_KEY),
    ensureResultHalalVerdict(merchant)
  ]).catch(function() { /* display-only extras never break the result */ });
  let timer;
  await Promise.race([extras, new Promise(function(resolve) { timer = setTimeout(resolve, RESULT_EXTRAS_WAIT_MS); })]);
  clearTimeout(timer);
}

// Serves the chosen photo of the visitor's CURRENTLY selected merchant only, fetched server-side
// so GOOGLE_PLACES_API_KEY never reaches the browser. Any other merchant ID -> 404.
app.get('/smart-match/photo/:merchantId', async function(req, res) {
  const demo = req.session.demo;
  const merchant = findMerchantForDemo(demo, demo.selectedMerchantId);
  if (!merchant || merchant.id !== req.params.merchantId) return res.sendStatus(404);
  const image = await smartMatchResult.fetchMerchantPhotoBytes(merchant, process.env.GOOGLE_PLACES_API_KEY);
  if (!image) return res.sendStatus(404);
  res.set({ 'Content-Type': image.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.send(image.body);
});

// Plain HTML fallback for visitors with JavaScript disabled.
app.get('/smart-match/static', async function(req, res) {
  const demo = req.session.demo;
  if (!demo.selectedMerchantId) {
    demo.nearbyMerchants = copyObjects(fallbackMerchants);
    demo.nearbySource = 'local-fallback';
    demo.nearbyDemoFallback = Boolean(demo.discoveryLocation);
    const result = await getSmartRecommendation(demo.profile, demo.nearbyMerchants,
      demo.rejectedMerchantIds, demo.recommendationFeedback, demo, demo.shownMerchantIds);
    const merchant = result.merchant;
    if (merchant) {
      demo.selectedMerchantId = merchant.id;
      demo.selectedMerchantReason = result.reason;
      demo.selectedMerchantRelevance = result.relevance || null;
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
  const scanMerchants = demo.discoveryLocation && (demo.nearbySource === 'google' || demo.nearbySource === 'foursquare')
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
  merchantMentionsCraving: merchantMentionsCraving,
  MATCH_STATE: MATCH_STATE,
  getMerchantCampaigns: function() { return merchantCampaignStore; },
  resetMerchantCampaigns: function() { merchantCampaignStore = createCampaigns(); },
  resetReferralCooldowns: function() { referralCooldowns.clear(); },
  clearDiscoveryCache: clearDiscoveryCache, clearMerchantResearchCache: clearMerchantResearchCache,
  clearSearchIntentCache: clearSearchIntentCache, classifyMealEligibility: classifyMealEligibility,
  safeAIReason: safeAIReason, getMatchReasons: getMatchReasons, isMealMerchant: isMealMerchant,
  RESEARCH_STATUS: RESEARCH_STATUS };
