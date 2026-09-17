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
    price: 7.50,
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
  { id: 'vouch-pick', label: 'Vouch Pick' },
  { id: 'good-value', label: 'Good Value' },
  { id: 'worth-it', label: 'Worth It' },
  { id: 'good-hangout', label: 'Good Hangout' }
];

// Shared links live across demo sessions, but disappear when this prototype restarts.
const sharedOffers = new Map();

// Each fictional participating merchant owns its own campaign.
function createCampaigns() {
  const campaigns = [];
  fallbackMerchants.forEach(function(merchant) {
    campaigns.push({
      id: merchant.id + '-campaign', merchantId: merchant.id,
      rewardAmount: 0.50, dailyCap: 20, startTime: '00:00', endTime: '23:59',
      status: 'ACTIVE', redemptionsToday: 0, day: singaporeDay(),
      metrics: { recommendationsShown: 0, accepted: 0, scans: 0, payments: 0,
        attributedPayments: 0, attributedValue: 0, rewardCost: 0 }
    });
  });
  return campaigns;
}

function createInitialDemo() {
  return {
    version: 6,
    user: { id: 'jia', name: 'Jia' },
    profile: { dietaryPreference: 'none', budget: 10, maxDistanceMinutes: 10, notifications: true },
    cashbackBalance: 0,
    nearbyMerchants: [], selectedMerchantId: null, rejectedMerchantIds: [],
    recommendationFeedback: [], shownMerchantIds: [],
    currentOrder: null, currentScanPayment: null, activeVouchClaim: null,
    transactions: [], paymentVerifiedVouches: [], promotionalRedemptions: [],
    campaigns: createCampaigns(),
    nextOrderNumber: 104, nextScanNumber: 1, nextTransactionNumber: 1, nextVouchNumber: 1
  };
}

function initialiseDemoSession(req) {
  if (!req.session.demo || req.session.demo.version !== 6) {
    req.session.demo = createInitialDemo();
  }
}

function copyObjects(items) {
  return items.map(function(item) { return { ...item }; });
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

function findOrderById(demo, orderId) {
  if (demo.currentOrder && demo.currentOrder.id === orderId) return demo.currentOrder;
  return null;
}

function findOrderByTransactionId(demo, transactionId) {
  if (demo.currentOrder && demo.currentOrder.transactionId === transactionId) return demo.currentOrder;
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
  for (let i = 0; i < demo.campaigns.length; i++) {
    const campaign = demo.campaigns[i];
    if (campaign.merchantId === merchantId) {
      if (campaign.day !== singaporeDay()) {
        campaign.day = singaporeDay();
        campaign.redemptionsToday = 0;
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

// Simulated Smart Match for Open House prototype.
// Replace the internal matching logic with the AI API later.
function getSmartRecommendation(profile, nearbyMerchants, rejectedMerchantIds, feedbackItems, demo) {
  let bestMerchant = null;
  let bestScore = -1000;
  const lastFeedback = getLastFeedback(feedbackItems);

  for (let i = 0; i < nearbyMerchants.length; i++) {
    const merchant = nearbyMerchants[i];
    if (!merchant.available) continue;
    if (!findCampaignForMerchant(merchant, demo)) continue;
    if (wasMerchantRejected(merchant.id, rejectedMerchantIds)) continue;
    if (!merchantMatchesProfile(merchant, profile)) continue;

    let score = 100 - merchant.distanceMinutes;
    if (!lastFeedback && merchant.id === 'felicia-chicken-rice') score += 15;
    if (merchant.price !== null) score += Math.max(0, profile.budget - merchant.price);
    if (findCampaignForMerchant(merchant, demo)) score += 50;

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

    if (score > bestScore) {
      bestMerchant = merchant;
      bestScore = score;
    }
  }
  return bestMerchant;
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
  if (campaign.redemptionsToday >= campaign.dailyCap) {
    return { code: 'FULLY_REDEEMED', title: 'Fully Redeemed Today', available: false };
  }
  if (alreadyRedeemed) {
    return { code: 'ALREADY_REDEEMED', title: 'Already Redeemed', available: false };
  }
  return { code: 'AVAILABLE', title: 'Vouch Available', available: true };
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

function paymentBreakdown(balance, amount, useCashback) {
  const purchaseCents = Math.round(amount * 100);
  const maximumCashbackCents = Math.max(0, purchaseCents - 100);
  const usedCents = useCashback ? Math.min(Math.round(balance * 100), maximumCashbackCents) : 0;
  return { cashbackUsed: usedCents / 100, netsPaid: (purchaseCents - usedCents) / 100 };
}

function redeemActiveVouchClaim(demo, transaction) {
  const claim = demo.activeVouchClaim;
  if (!claim || claim.status !== 'CLAIMED' || !transaction.eligible ||
      claim.merchantId !== transaction.merchantId) return;
  claim.status = 'REDEEMED';
  claim.transactionId = transaction.id;
  transaction.sharedVouchReward = claim.reward;
  demo.cashbackBalance = money(demo.cashbackBalance + claim.reward);
}

// Both journeys use this function; the routes choose the journey explicitly.
function recordPayment(demo, journey, amount, useCashback) {
  if (journey.transactionId) return findTransactionById(demo.transactions, journey.transactionId);
  const breakdown = paymentBreakdown(demo.cashbackBalance, amount, useCashback);
  const date = getCurrentDateAndTime();
  const campaign = findCampaign(demo, journey.merchantId);
  const eligible = breakdown.netsPaid >= MINIMUM_ELIGIBLE_PAYMENT;
  const rewardEligible = eligible && campaign && getCampaignAvailability(campaign, false).available;
  const transaction = {
    id: 'tx-' + demo.nextTransactionNumber++,
    journeyId: journey.id, source: journey.source,
    merchantId: journey.merchantId, merchantName: journey.merchantName, outlet: journey.outlet,
    itemName: journey.source === 'smart-match' ? journey.itemName : null,
    purchaseAmount: amount, cashbackUsed: breakdown.cashbackUsed, netsPaid: breakdown.netsPaid,
    cashbackAwarded: 0, promisedReward: rewardEligible ? campaign.rewardAmount : 0,
    rewardReleased: false, status: 'Successful', eligible: eligible,
    collected: false, vouchDecision: eligible ? 'pending' : 'not-eligible', vouchCreated: false,
    campaignId: campaign ? campaign.id : null,
    date: date.date, time: date.time, createdAt: date.iso,
    displayAmount: '$' + breakdown.netsPaid.toFixed(2), paymentMethod: 'NETS'
  };
  demo.transactions.unshift(transaction);
  demo.cashbackBalance = money(demo.cashbackBalance - breakdown.cashbackUsed);
  journey.transactionId = transaction.id;
  journey.paymentRecorded = true;
  journey.status = 'PAID';
  journey.cashbackUsed = breakdown.cashbackUsed;
  journey.netsPaid = breakdown.netsPaid;
  journey.vouchDecision = transaction.vouchDecision;
  if (campaign) {
    campaign.metrics.payments += 1;
    if (rewardEligible) {
      // Reserve the reward at payment; collection releases the promised amount.
      campaign.redemptionsToday += 1;
      if (journey.source === 'smart-match') {
        campaign.metrics.attributedPayments += 1;
        campaign.metrics.attributedValue = money(campaign.metrics.attributedValue + amount);
      }
    }
  }
  if (journey.source === 'scan') releaseCashback(demo, transaction, journey);
  redeemActiveVouchClaim(demo, transaction);
  return transaction;
}

function releaseCashback(demo, transaction, journey) {
  if (transaction.rewardReleased) return;
  if (transaction.source === 'smart-match' && !transaction.collected) return;
  transaction.rewardReleased = true;
  transaction.cashbackAwarded = transaction.promisedReward;
  journey.cashbackReleased = true;
  journey.cashbackAwarded = transaction.cashbackAwarded;
  demo.cashbackBalance = money(demo.cashbackBalance + transaction.cashbackAwarded);
  if (transaction.cashbackAwarded > 0) {
    const campaign = findCampaign(demo, transaction.merchantId);
    campaign.metrics.rewardCost = money(campaign.metrics.rewardCost + transaction.cashbackAwarded);
    demo.promotionalRedemptions.unshift({
      transactionId: transaction.id, merchantName: transaction.merchantName,
      itemName: transaction.itemName || 'In-store purchase',
      rewardAmount: transaction.cashbackAwarded, date: transaction.date, status: 'Redeemed'
    });
  }
}

function canVouch(transaction) {
  return transaction && transaction.status === 'Successful' && transaction.eligible &&
    (transaction.source === 'scan' || transaction.collected);
}

function setVouchDecision(demo, transaction, decision) {
  transaction.vouchDecision = decision;
  const journey = transaction.source === 'scan' ? demo.currentScanPayment :
    findOrderByTransactionId(demo, transaction.id);
  if (journey && journey.transactionId === transaction.id) {
    journey.vouchDecision = decision;
    if (transaction.source === 'scan') journey.status = 'COMPLETE';
  }
}

function matchView(demo, recommendation) {
  return {
    recommendation: recommendation,
    campaign: recommendation ? findCampaignForMerchant(recommendation, demo) : null,
    matchReasons: recommendation ? getMatchReasons(demo.profile, recommendation, demo.recommendationFeedback) : [],
    rejectionReasons: rejectionReasons,
    vouchCount: recommendation ? countVouches(demo, recommendation.id) : 0
  };
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
      res.set('Cache-Control', 'no-store');
      next();
    });
  }
});

// Home and persistent Smart Match
app.get('/', function(req, res) { res.redirect('/home'); });
app.get('/home', function(req, res) {
  const demo = req.session.demo;
  const recommendation = findMerchantForDemo(demo, demo.selectedMerchantId);
  res.render('home', {
    ...matchView(demo, recommendation), user: demo.user, order: demo.currentOrder,
    transaction: demo.currentOrder ? findTransactionById(demo.transactions, demo.currentOrder.transactionId) : null,
    cashbackBalance: demo.cashbackBalance, matchingAgain: req.query.matching === 'again'
  });
});

app.get('/smart-match/result', async function(req, res) {
  const demo = req.session.demo;
  if (demo.currentOrder) return res.status(409).send('Return Home to continue your order.');
  let recommendation = findMerchantForDemo(demo, demo.selectedMerchantId);
  if (!recommendation) {
    if (!demo.nearbyMerchants.length) demo.nearbyMerchants = (await getNearbyMerchants()).merchants;
    recommendation = getSmartRecommendation(demo.profile, demo.nearbyMerchants,
      demo.rejectedMerchantIds, demo.recommendationFeedback, demo);
    if (recommendation) {
      demo.selectedMerchantId = recommendation.id;
      if (!demo.shownMerchantIds.includes(recommendation.id)) {
        demo.shownMerchantIds.push(recommendation.id);
        findCampaign(demo, recommendation.id).metrics.recommendationsShown += 1;
      }
    }
  }
  if (!recommendation) return res.render('smart-match-empty', { profile: demo.profile });
  res.render('smart-match-card', matchView(demo, recommendation));
});

// Plain HTML fallback for visitors with JavaScript disabled.
app.get('/smart-match/static', function(req, res) {
  const demo = req.session.demo;
  if (!demo.currentOrder && !demo.selectedMerchantId) {
    demo.nearbyMerchants = copyObjects(fallbackMerchants);
    const merchant = getSmartRecommendation(demo.profile, demo.nearbyMerchants,
      demo.rejectedMerchantIds, demo.recommendationFeedback, demo);
    if (merchant) {
      demo.selectedMerchantId = merchant.id;
      if (!demo.shownMerchantIds.includes(merchant.id)) {
        demo.shownMerchantIds.push(merchant.id);
        findCampaign(demo, merchant.id).metrics.recommendationsShown += 1;
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
  if (demo.currentOrder || !merchant || req.body.merchantId !== merchant.id ||
      !isValidRejectionReason(req.body.reason)) {
    if (req.get('X-Requested-With') === 'smart-match') return res.status(409).send('Refresh Home and try again.');
    return res.redirect('/home');
  }
  demo.rejectedMerchantIds.push(merchant.id);
  demo.recommendationFeedback.push({ merchantId: merchant.id, reason: req.body.reason,
    category: merchant.category, price: merchant.price, distanceMinutes: merchant.distanceMinutes });
  demo.selectedMerchantId = null;
  if (req.get('X-Requested-With') === 'smart-match') return res.sendStatus(204);
  res.redirect('/home?matching=again');
});

function restartMatch(req, res) {
  const demo = req.session.demo;
  if (demo.currentOrder && !(demo.currentOrder.status === 'COLLECTED' &&
      demo.currentOrder.vouchDecision !== 'pending')) return res.redirect('/home');
  if (demo.currentOrder && !demo.rejectedMerchantIds.includes(demo.currentOrder.merchantId)) {
    demo.rejectedMerchantIds.push(demo.currentOrder.merchantId);
  }
  demo.currentOrder = null;
  demo.selectedMerchantId = null;
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
  if (demo.currentOrder) return res.redirect(demo.currentOrder.status === 'PENDING_PAYMENT' ? '/payment' : '/order');
  const merchant = findMerchantForDemo(demo, demo.selectedMerchantId);
  if (!merchant || merchant.id !== req.body.merchantId ||
      !merchantMatchesProfile(merchant, demo.profile) || !findCampaignForMerchant(merchant, demo)) {
    return res.redirect('/home?error=offer');
  }
  const number = demo.nextOrderNumber++;
  demo.currentOrder = {
    id: 'order-' + number, orderNumber: number, source: 'smart-match',
    merchantId: merchant.id, merchantName: merchant.merchantName, outlet: merchant.address,
    itemName: merchant.itemName, orderAmount: merchant.price, distanceMinutes: merchant.distanceMinutes,
    status: 'PENDING_PAYMENT', transactionId: null, paymentRecorded: false,
    cashbackUsed: 0, netsPaid: 0, cashbackReleased: false, cashbackAwarded: 0,
    collected: false, vouchDecision: 'pending'
  };
  findCampaign(demo, merchant.id).metrics.accepted += 1;
  res.redirect('/payment');
});

// Smart Match review and payment. Scan uses its own explicit routes.
app.get('/payment', function(req, res) {
  const demo = req.session.demo;
  const order = demo.currentOrder;
  if (!order) return res.redirect('/home');
  if (order.status !== 'PENDING_PAYMENT') return res.redirect('/order');
  res.render('payment', { journey: order, scan: false, cashbackBalance: demo.cashbackBalance,
    campaign: findCampaignForMerchant(findMerchantForDemo(demo, order.merchantId), demo),
    error: null });
});
app.post('/payment', function(req, res) {
  const demo = req.session.demo;
  const order = demo.currentOrder;
  if (!order || req.body.journeyId !== order.id) return res.redirect('/home');
  if (order.transactionId) return res.redirect(receiptUrl(findTransactionById(demo.transactions, order.transactionId)));
  const transaction = recordPayment(demo, order, order.orderAmount, req.body.useCashback === 'on');
  res.redirect(receiptUrl(transaction));
});

// Standalone scan: merchant identity -> amount and cashback -> Pay.
app.get('/scan', function(req, res) {
  const demo = req.session.demo;
  const scan = demo.currentScanPayment;
  if (scan && scan.status === 'MERCHANT_FOUND') return res.redirect('/scan/payment');
  if (scan && scan.status === 'PAID') return res.redirect('/vouch/' + scan.transactionId);
  res.render('scan', { error: req.query.error === 'invalid',
    merchantId: demo.activeVouchClaim && demo.activeVouchClaim.status === 'CLAIMED' ?
      demo.activeVouchClaim.merchantId : 'green-bowl' });
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
    return res.redirect(canVouch(existingTransaction) ? '/vouch/' + scan.transactionId : receiptUrl(existingTransaction));
  }
  res.render('payment', { journey: scan, scan: true, cashbackBalance: demo.cashbackBalance,
    campaign: findCampaignForMerchant(findMerchantForDemo(demo, scan.merchantId), demo),
    error: req.query.error === 'amount' ? 'Enter $0.01–$1,000 with no more than two decimal places.' : null });
});
app.post('/scan/payment', function(req, res) {
  const demo = req.session.demo;
  const scan = demo.currentScanPayment;
  if (!scan || req.body.journeyId !== scan.id) return res.redirect('/scan');
  if (scan.transactionId) {
    const existingTransaction = findTransactionById(demo.transactions, scan.transactionId);
    return res.redirect(canVouch(existingTransaction) ? '/vouch/' + scan.transactionId : receiptUrl(existingTransaction));
  }
  const amount = parsePaymentAmount(req.body.amount);
  if (amount === null) return res.redirect('/scan/payment?error=amount');
  scan.enteredAmount = amount;
  const transaction = recordPayment(demo, scan, amount, req.body.useCashback === 'on');
  if (canVouch(transaction)) return res.redirect('/vouch/' + transaction.id);
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
  res.render('payment-success', { transaction: transaction, canVouch: canVouch(transaction),
    currentOrderMatches: Boolean(findOrderByTransactionId(demo, transaction.id)) });
});

// Collection and merchant-controlled readiness
app.get('/order', function(req, res) {
  const demo = req.session.demo;
  const order = demo.currentOrder;
  if (!order) return res.redirect('/home');
  if (order.status === 'PENDING_PAYMENT') return res.redirect('/payment');
  res.render('order-status', { order: order,
    transaction: findTransactionById(demo.transactions, order.transactionId) });
});
app.get('/order/state', function(req, res) {
  const order = req.session.demo.currentOrder;
  res.json({ id: order ? order.id : null, status: order ? order.status : null });
});
app.post('/collection', function(req, res) {
  const demo = req.session.demo;
  const order = findOrderById(demo, req.body.journeyId);
  if (order && req.body.journeyId === order.id && order.status === 'READY') {
    const transaction = findTransactionById(demo.transactions, order.transactionId);
    if (transaction && order.paymentRecorded) {
      order.status = 'COLLECTED';
      order.collected = true;
      transaction.collected = true;
      releaseCashback(demo, transaction, order);
    }
  }
  res.redirect('/order');
});
app.get('/collection', function(req, res) { res.redirect('/order'); });

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
      token: shareToken, vouchId: vouch.id, ownerSessionId: req.sessionID, merchantId: transaction.merchantId,
      merchantName: transaction.merchantName, user: demo.user.name, tagLabel: vouch.tagLabel,
      rewardAmount: campaign ? campaign.rewardAmount : 0.50, claimedSessionIds: []
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
    sharePath: '/offers/' + vouch.shareToken });
});

// A copied Vouch link can be opened by another demo session and claimed once.
app.get('/offers/:token', function(req, res) {
  const offer = sharedOffers.get(req.params.token);
  if (!offer) return res.status(404).render('shared-offer', { offer: null, claimed: false, own: false });
  const claim = req.session.demo.activeVouchClaim;
  const claimed = Boolean(claim && claim.vouchId === offer.vouchId);
  res.render('shared-offer', { offer: offer, claimed: claimed, claim: claim,
    own: offer.ownerSessionId === req.sessionID });
});
app.post('/offers/:token/claim', function(req, res) {
  const demo = req.session.demo;
  const offer = sharedOffers.get(req.params.token);
  if (!offer || offer.ownerSessionId === req.sessionID) return res.redirect('/offers/' + req.params.token);
  if (!demo.activeVouchClaim || demo.activeVouchClaim.vouchId !== offer.vouchId) {
    demo.activeVouchClaim = {
      vouchId: offer.vouchId, token: offer.token, merchantId: offer.merchantId,
      merchantName: offer.merchantName, reward: offer.rewardAmount, status: 'CLAIMED', transactionId: null
    };
  }
  res.redirect('/offers/' + offer.token);
});
app.post('/transactions/:id/done', function(req, res) {
  const demo = req.session.demo;
  const transaction = findTransactionById(demo.transactions, req.params.id);
  if (transaction && transaction.source === 'scan' && transaction.vouchDecision !== 'pending' &&
      demo.currentScanPayment && demo.currentScanPayment.transactionId === transaction.id) {
    demo.currentScanPayment.status = 'COMPLETE';
  }
  res.redirect('/home');
});

// Profile and history
app.get('/profile', function(req, res) {
  const demo = req.session.demo;
  const tab = ['transactions', 'vouches'].includes(req.query.tab) ? req.query.tab : 'settings';
  res.render('profile', { user: demo.user, profile: demo.profile, dietaryPreferenceOptions: dietaryPreferenceOptions,
    tab: tab, transactions: demo.transactions, promotionalRedemptions: demo.promotionalRedemptions,
    paymentVerifiedVouches: demo.paymentVerifiedVouches, cashbackBalance: demo.cashbackBalance,
    settingsError: req.query.error === 'invalid' });
});
app.post('/profile', function(req, res) {
  const demo = req.session.demo;
  const budget = parsePaymentAmount(req.body.budget);
  const distance = Number(req.body.maxDistanceMinutes);
  if (!isValidDietaryPreference(req.body.dietaryPreference) || budget === null || budget > 100 ||
      !Number.isInteger(distance) || distance < 1 || distance > 60) {
    return res.redirect('/profile?error=invalid');
  }
  demo.profile = { dietaryPreference: req.body.dietaryPreference, budget: budget,
    maxDistanceMinutes: distance, notifications: req.body.notifications === 'on' };
  demo.selectedMerchantId = null;
  res.redirect('/profile?saved=1');
});
app.get('/transactions/:id', function(req, res) {
  const transaction = findTransactionById(req.session.demo.transactions, req.params.id);
  if (!transaction) return res.redirect('/profile?tab=transactions');
  res.render('transaction-detail', { transaction: transaction });
});

// Merchant demo: switch merchant without changing Jia's selected recommendation.
app.get('/merchant', function(req, res) {
  const demo = req.session.demo;
  const defaultId = demo.currentOrder ? demo.currentOrder.merchantId : fallbackMerchants[0].id;
  const merchant = findMerchantById(fallbackMerchants, req.query.merchantId || defaultId);
  if (!merchant) return res.redirect('/merchant');
  const campaign = findCampaign(demo, merchant.id);
  res.render('merchant', {
    merchants: fallbackMerchants, merchant: merchant, campaign: campaign,
    tab: ['orders', 'results'].includes(req.query.tab) ? req.query.tab : 'campaign',
    availability: getCampaignAvailability(campaign, false),
    order: demo.currentOrder && demo.currentOrder.merchantId === merchant.id ? demo.currentOrder : null,
    error: req.query.error === 'invalid'
  });
});
function merchantTransition(req, res, from, to) {
  const order = findOrderById(req.session.demo, req.body.journeyId);
  if (order && req.body.journeyId === order.id && req.body.merchantId === order.merchantId &&
      order.status === from) order.status = to;
  res.redirect('/merchant?tab=orders&merchantId=' + encodeURIComponent(req.body.merchantId || ''));
}
app.post('/merchant/start-preparing', function(req, res) { merchantTransition(req, res, 'PAID', 'PREPARING'); });
app.post('/merchant/mark-ready', function(req, res) { merchantTransition(req, res, 'PREPARING', 'READY'); });
app.post('/merchant/offer', function(req, res) {
  const campaign = findCampaign(req.session.demo, req.body.merchantId);
  const reward = Number(req.body.rewardAmount);
  const cap = Number(req.body.dailyCap);
  const destination = '/merchant?merchantId=' + encodeURIComponent(req.body.merchantId || '');
  if (!campaign || !Number.isFinite(reward) || reward < 0 || reward > 50 ||
      !Number.isInteger(cap) || cap < 1 || cap > 1000 ||
      timeToMinutes(req.body.startTime) === null || timeToMinutes(req.body.endTime) === null) {
    return res.redirect(destination + '&error=invalid');
  }
  campaign.rewardAmount = money(reward);
  campaign.dailyCap = cap;
  campaign.startTime = req.body.startTime;
  campaign.endTime = req.body.endTime;
  campaign.status = req.body.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
  res.redirect(destination);
});
app.post('/reset-demo', function(req, res) {
  sharedOffers.forEach(function(offer, token) {
    if (offer.ownerSessionId === req.sessionID) sharedOffers.delete(token);
  });
  req.session.demo = createInitialDemo();
  res.redirect('/home');
});

// Start server. Export the app and demo factory for local automated tests.
if (require.main === module) {
  app.listen(PORT, function() { console.log('NETS Vouch AI running on http://localhost:' + PORT); });
}
module.exports = { app: app, createInitialDemo: createInitialDemo, demoStore: demoStore };
