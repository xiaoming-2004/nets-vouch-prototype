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
const CLAIM_VALIDITY_MINUTES = 10;
const PLACES_REQUEST_TIMEOUT_MS = 3500;

// Configure Express
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure session
app.use(session({
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
    id: 'green-leaf-kitchen',
    merchantId: 'green-leaf-kitchen',
    merchantName: 'Green Leaf Kitchen',
    name: 'Green Leaf Kitchen',
    itemName: 'Vegan Grain Bowl',
    price: 9.20,
    category: 'healthy-food',
    address: 'Woodlands Demo Outlet',
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

const initialTransactions = [];
const initialPaymentVerifiedVouches = [];

const participatingMerchantIds = [
  'felicia-chicken-rice',
  'green-leaf-kitchen',
  'woodlands-noodle-bar',
  'northside-wraps',
  'spice-lane'
];

const initialCampaign = {
  id: 'felicia-lunch-vouch',
  merchantId: merchants.felicia.id,
  rewardAmount: 0.50,
  dailyCap: 20,
  startTime: '00:00',
  endTime: '23:59',
  redemptionsToday: 6,
  status: 'ACTIVE'
};

const initialMetrics = {
  recommendationsShown: 19,
  recommendationsAccepted: 7,
  qrScans: 6,
  claims: 6,
  eligiblePayments: 6,
  attributedTransactionValue: 45.00,
  rewardCost: 3.00
};

// Helper functions
function copyObjects(items) {
  const copies = [];
  items.forEach(function(item) {
    copies.push({ ...item });
  });
  return copies;
}

function createInitialDemo() {
  return {
    user: { id: 'jia', name: 'Jia' },
    profile: {
      dietaryPreference: 'none',
      budget: 10,
      maxDistanceMinutes: 10,
      notifications: true
    },
    nearbyMerchants: [],
    selectedMerchantId: null,
    acceptedMerchantId: null,
    rejectedMerchantIds: [],
    usedMerchantIds: [],
    recommendationFeedback: [],
    lastRejectionReason: null,
    recommendationAccepted: false,
    shownMerchantIds: [],
    acceptanceMetricRecorded: false,
    qrScan: null,
    activeClaim: null,
    promotionalRedemptions: [],
    latestPayment: null,
    currentOrder: null,
    journeyComplete: false,
    cashbackBalance: 0,
    transactions: copyObjects(initialTransactions),
    paymentVerifiedVouches: copyObjects(initialPaymentVerifiedVouches),
    campaign: { ...initialCampaign },
    metrics: { ...initialMetrics },
    nextScanNumber: 1,
    nextClaimNumber: 1,
    nextTransactionNumber: 1,
    nextVouchNumber: 1,
    nextOrderNumber: 104
  };
}

function initialiseDemoSession(req) {
  if (!req.session.demo) req.session.demo = createInitialDemo();
  if (!req.session.demo.usedMerchantIds) req.session.demo.usedMerchantIds = [];
  if (typeof req.session.demo.cashbackBalance !== 'number') req.session.demo.cashbackBalance = 0;
  if (typeof req.session.demo.journeyComplete !== 'boolean') req.session.demo.journeyComplete = false;
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

function isParticipatingMerchant(merchant) {
  return merchant && participatingMerchantIds.indexOf(merchant.merchantId) !== -1;
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

function findCampaignForMerchant(merchant, demo) {
  if (!isParticipatingMerchant(merchant)) return null;
  const availability = getCampaignAvailability(
    demo.campaign,
    false
  );
  if (!availability.available) return null;
  return demo.campaign;
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
    if (wasMerchantRejected(merchant.id, rejectedMerchantIds) ||
      wasMerchantRejected(merchant.id, demo.usedMerchantIds || [])) continue;
    if (!merchantMatchesProfile(merchant, profile)) continue;

    let score = 100 - merchant.distanceMinutes;
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

function hasRedeemedCampaign(demo, campaignId) {
  for (let i = 0; i < demo.promotionalRedemptions.length; i++) {
    if (demo.promotionalRedemptions[i].campaignId === campaignId) return true;
  }
  return false;
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

function isClaimExpired(claim) {
  if (!claim) return true;
  return Date.now() > new Date(claim.expiresAt).getTime();
}

function createCampaignClaim(demo, recommendation) {
  const claimedAt = new Date();
  const expiresAt = new Date(claimedAt.getTime() + CLAIM_VALIDITY_MINUTES * 60 * 1000);
  demo.activeClaim = {
    id: 'claim-' + demo.nextClaimNumber,
    userId: demo.user.id,
    merchantId: recommendation.merchantId,
    campaignId: demo.campaign.id,
    recommendationId: recommendation.id,
    claimedAt: claimedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: 'CLAIMED',
    transactionId: null,
    rewardAwarded: 0
  };
  demo.nextClaimNumber += 1;
  demo.metrics.claims += 1;
  return demo.activeClaim;
}

function getScanErrorMessage(errorCode) {
  if (errorCode === 'invalid') return 'This QR does not match a valid NETS Vouch campaign.';
  if (errorCode === 'ended') return 'This campaign has ended.';
  if (errorCode === 'fully_redeemed') return 'Today\'s Vouches have all been redeemed.';
  if (errorCode === 'already_redeemed') return 'You have already redeemed this Vouch.';
  if (errorCode) return 'This campaign is not available right now.';
  return null;
}

function isPaymentEligible(demo, claim, recommendation) {
  if (!claim || !recommendation) return false;
  if (claim.status !== 'CLAIMED' || claim.transactionId) return false;
  if (isClaimExpired(claim)) return false;
  if (claim.userId !== demo.user.id) return false;
  if (claim.merchantId !== recommendation.merchantId) return false;
  if (claim.campaignId !== demo.campaign.id) return false;
  if (recommendation.price < MINIMUM_ELIGIBLE_PAYMENT) return false;
  return getCampaignAvailability(demo.campaign, false).available;
}

function createTransactionId(demo) {
  const transactionId = 'tx-' + String(demo.nextTransactionNumber).padStart(3, '0');
  demo.nextTransactionNumber += 1;
  return transactionId;
}

function createOrder(demo, recommendation) {
  const order = {
    orderNumber: demo.nextOrderNumber,
    merchantId: recommendation.merchantId,
    merchantName: recommendation.merchantName,
    itemName: recommendation.itemName,
    amount: recommendation.price,
    cashbackUsed: 0,
    amountToPay: recommendation.price,
    status: 'PENDING_PAYMENT',
    createdAt: new Date().toISOString(),
    paymentRecorded: false,
    cashbackRecorded: false,
    cashbackReleased: false,
    collected: false,
    transactionId: null
  };
  demo.nextOrderNumber += 1;
  demo.currentOrder = order;
  return order;
}

function resetForNewJourney(demo) {
  if (demo.currentOrder && demo.currentOrder.merchantId &&
      demo.usedMerchantIds.indexOf(demo.currentOrder.merchantId) === -1) {
    demo.usedMerchantIds.push(demo.currentOrder.merchantId);
  }
  demo.currentOrder = null;
  demo.latestPayment = null;
  demo.selectedMerchantId = null;
  demo.acceptedMerchantId = null;
  demo.recommendationAccepted = false;
  demo.journeyComplete = false;
  demo.acceptanceMetricRecorded = false;
}

function getPaymentBreakdown(demo, order, useCashback) {
  const cashbackUsed = useCashback
    ? Math.min(demo.cashbackBalance, order.amount)
    : 0;
  return {
    cashbackUsed: cashbackUsed,
    amountToPay: Math.max(0, order.amount - cashbackUsed)
  };
}

function releaseOrderCashback(demo, order) {
  if (!order || order.cashbackReleased || !order.paymentRecorded || order.amount < MINIMUM_ELIGIBLE_PAYMENT) {
    return false;
  }
  const rewardAmount = demo.campaign.rewardAmount;
  const transaction = findTransactionById(demo.transactions, order.transactionId);
  if (!transaction) return false;
  transaction.cashbackAwarded = rewardAmount;
  order.cashbackRecorded = true;
  order.cashbackReleased = true;
  demo.cashbackBalance += rewardAmount;
  demo.latestPayment.rewardAwarded = rewardAmount;
  demo.promotionalRedemptions.unshift({
    id: 'redemption-order-' + order.orderNumber,
    claimId: null,
    campaignId: demo.campaign.id,
    merchantId: order.merchantId,
    merchantName: order.merchantName,
    itemName: order.itemName,
    transactionId: order.transactionId,
    rewardAmount: rewardAmount,
    date: getCurrentDateAndTime().date,
    status: 'Redeemed'
  });
  demo.campaign.redemptionsToday += 1;
  demo.metrics.rewardCost += rewardAmount;
  return true;
}

function getCampaignCalculations(demo) {
  let conversion = 0;
  let costPerPayment = 0;
  if (demo.metrics.recommendationsShown > 0) {
    conversion = Math.round(demo.metrics.eligiblePayments / demo.metrics.recommendationsShown * 100);
  }
  if (demo.metrics.eligiblePayments > 0) {
    costPerPayment = demo.metrics.rewardCost / demo.metrics.eligiblePayments;
  }
  return {
    conversion: conversion,
    costPerPayment: costPerPayment,
    maximumDailyCost: demo.campaign.rewardAmount * demo.campaign.dailyCap,
    redemptionsRemaining: Math.max(0, demo.campaign.dailyCap - demo.campaign.redemptionsToday)
  };
}

function isValidCampaignInput(rewardAmount, dailyCap, startTime, endTime) {
  if (!Number.isFinite(rewardAmount) || rewardAmount < 0 || rewardAmount > 50) return false;
  if (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 1000) return false;
  if (timeToMinutes(startTime) === null || timeToMinutes(endTime) === null) return false;
  return true;
}

function getJourneyLink(demo) {
  if (demo.currentOrder) return demo.currentOrder.status === 'PENDING_PAYMENT' ? '/payment' : '/order';
  if (demo.latestPayment) return '/payment-success';
  if (demo.activeClaim && demo.activeClaim.status === 'CLAIMED') return '/payment';
  if (demo.qrScan && demo.qrScan.verified) return '/claim';
  if (demo.recommendationAccepted) return '/scan';
  return null;
}

// Start route
app.get('/', function(req, res) {
  initialiseDemoSession(req);
  res.redirect('/home');
});

// Home routes
app.get('/home', async function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (req.query.new === '1') resetForNewJourney(demo);

  let journey = 'match';
  if (demo.currentOrder && !demo.journeyComplete) {
    if (demo.currentOrder.status === 'PENDING_PAYMENT') {
      journey = 'payment';
    } else if (demo.currentOrder.status === 'COLLECTED') {
      journey = 'vouch';
    } else {
      journey = 'order';
    }
  } else if (demo.currentOrder && demo.journeyComplete) {
    journey = 'complete';
  }

  let recommendation = null;
  if (journey === 'match' && demo.selectedMerchantId) {
    recommendation = findMerchantForDemo(demo, demo.selectedMerchantId);
    if (!recommendation || !findCampaignForMerchant(recommendation, demo)) {
      demo.selectedMerchantId = null;
      recommendation = null;
    }
  }

  res.render('home', {
    user: demo.user,
    journey: journey,
    order: demo.currentOrder,
    payment: demo.latestPayment,
    cashbackBalance: demo.cashbackBalance,
    recommendation: recommendation,
    matchReasons: recommendation ? getMatchReasons(demo.profile, recommendation, demo.recommendationFeedback) : [],
    campaign: demo.campaign,
    matchingAgain: req.query.matching === 'again' || req.query.new === '1'
  });
});

// Recommendation routes
app.get('/smart-match/result', async function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  const nearbyResult = await getNearbyMerchants();
  demo.nearbyMerchants = nearbyResult.merchants;

  let recommendation = findMerchantForDemo(demo, demo.selectedMerchantId);
  if (!recommendation || !findCampaignForMerchant(recommendation, demo)) {
    recommendation = getSmartRecommendation(
      demo.profile,
      demo.nearbyMerchants,
      demo.rejectedMerchantIds,
      demo.recommendationFeedback,
      demo
    );
  }

  if (!recommendation) {
    demo.selectedMerchantId = null;
    return res.render('smart-match-empty', {
      profile: demo.profile
    });
  }

  demo.selectedMerchantId = recommendation.id;
  let alreadyShown = false;
  for (let i = 0; i < demo.shownMerchantIds.length; i++) {
    if (demo.shownMerchantIds[i] === recommendation.id) alreadyShown = true;
  }
  if (!alreadyShown) {
    demo.shownMerchantIds.push(recommendation.id);
    demo.metrics.recommendationsShown += 1;
  }

  res.render('smart-match-card', {
    recommendation: recommendation,
    campaign: findCampaignForMerchant(recommendation, demo),
    matchReasons: getMatchReasons(demo.profile, recommendation, demo.recommendationFeedback),
    source: nearbyResult.source
  });
});

app.get('/recommendation', function(req, res) {
  res.redirect('/home#smart-match');
});

app.get('/recommendation/reject', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (demo.recommendationAccepted) return res.redirect(getJourneyLink(demo) || '/scan');
  const currentRecommendation = findMerchantForDemo(demo, demo.selectedMerchantId);
  if (!currentRecommendation) return res.redirect('/home#smart-match');
  res.render('rejection', {
    user: demo.user,
    currentRecommendation: currentRecommendation,
    rejectionReasons: rejectionReasons
  });
});

app.post('/recommendation/reject', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (demo.recommendationAccepted) return res.redirect(getJourneyLink(demo) || '/scan');
  const currentRecommendation = findMerchantForDemo(demo, demo.selectedMerchantId);
  if (!currentRecommendation) return res.redirect('/home#smart-match');
  if (!isValidRejectionReason(req.body.reason)) return res.redirect('/recommendation/reject');

  if (!wasMerchantRejected(currentRecommendation.id, demo.rejectedMerchantIds)) {
    demo.rejectedMerchantIds.push(currentRecommendation.id);
  }
  demo.recommendationFeedback.push({
    merchantId: currentRecommendation.id,
    reason: req.body.reason,
    category: currentRecommendation.category,
    price: currentRecommendation.price,
    distanceMinutes: currentRecommendation.distanceMinutes
  });
  demo.lastRejectionReason = req.body.reason;
  demo.selectedMerchantId = null;
  demo.recommendationAccepted = false;
  demo.acceptedMerchantId = null;
  res.redirect('/home?matching=again#smart-match');
});

app.post('/recommendation/try-again', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  demo.selectedMerchantId = null;
  demo.rejectedMerchantIds = [];
  demo.recommendationFeedback = [];
  demo.lastRejectionReason = null;
  res.redirect('/home#smart-match');
});

app.post('/recommendation/widen-distance', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  demo.profile.maxDistanceMinutes = Math.min(60, demo.profile.maxDistanceMinutes + 5);
  demo.selectedMerchantId = null;
  demo.rejectedMerchantIds = [];
  demo.recommendationFeedback = [];
  demo.lastRejectionReason = null;
  res.redirect('/home#smart-match');
});

app.post('/recommendation/accept', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  const recommendation = findMerchantForDemo(demo, demo.selectedMerchantId);
  if (!recommendation) return res.redirect('/recommendation');
  if (!merchantMatchesProfile(recommendation, demo.profile)) {
    return res.redirect('/recommendation');
  }
  if (!findCampaignForMerchant(recommendation, demo)) {
    return res.redirect('/home#smart-match');
  }
  demo.recommendationAccepted = true;
  demo.acceptedMerchantId = recommendation.id;
  if (!demo.currentOrder) createOrder(demo, recommendation);
  if (!demo.acceptanceMetricRecorded) {
    demo.metrics.recommendationsAccepted += 1;
    demo.acceptanceMetricRecorded = true;
  }
  res.redirect('/payment');
});

// QR scan and campaign claim routes
app.get('/scan', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (demo.latestPayment) return res.redirect('/payment-success');
  if (demo.activeClaim && demo.activeClaim.status === 'CLAIMED' && !isClaimExpired(demo.activeClaim)) {
    return res.redirect('/payment');
  }
  const recommendation = findMerchantById(fallbackMerchants, merchants.felicia.id);
  res.render('scan', {
    merchant: merchants.felicia,
    recommendation: recommendation,
    campaign: demo.campaign,
    availability: getCampaignAvailability(demo.campaign, hasRedeemedCampaign(demo, demo.campaign.id)),
    errorMessage: getScanErrorMessage(req.query.error)
  });
});

app.post('/scan', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (demo.latestPayment) return res.redirect('/payment-success');
  if (req.body.merchantId !== merchants.felicia.id || req.body.campaignId !== demo.campaign.id) {
    return res.redirect('/scan?error=invalid');
  }
  if (demo.activeClaim && demo.activeClaim.status === 'CLAIMED' && !isClaimExpired(demo.activeClaim)) {
    return res.redirect('/payment');
  }
  const availability = getCampaignAvailability(
    demo.campaign, hasRedeemedCampaign(demo, demo.campaign.id)
  );
  if (!availability.available) return res.redirect('/scan?error=' + availability.code.toLowerCase());
  const recommendation = findMerchantById(fallbackMerchants, merchants.felicia.id);

  if (!demo.qrScan || !demo.qrScan.verified) {
    const dateAndTime = getCurrentDateAndTime();
    demo.qrScan = {
      id: 'scan-' + demo.nextScanNumber,
      merchantId: merchants.felicia.id,
      campaignId: demo.campaign.id,
      recommendationId: recommendation.id,
      scannedAt: dateAndTime.iso,
      verified: true
    };
    demo.nextScanNumber += 1;
    demo.metrics.qrScans += 1;
  }

  demo.acceptedMerchantId = recommendation.id;
  createCampaignClaim(demo, recommendation);
  res.redirect('/payment');
});

app.get('/claim', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (!demo.qrScan || !demo.qrScan.verified) return res.redirect('/scan');
  if (demo.latestPayment || (demo.activeClaim && demo.activeClaim.transactionId)) {
    return res.redirect('/payment-success');
  }
  if (demo.activeClaim && demo.activeClaim.status === 'CLAIMED' && !isClaimExpired(demo.activeClaim)) {
    return res.redirect('/payment');
  }
  res.redirect('/scan');
});

app.post('/claim', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (!demo.qrScan || !demo.qrScan.verified) return res.redirect('/scan');
  if (demo.latestPayment || (demo.activeClaim && demo.activeClaim.transactionId)) {
    return res.redirect('/payment-success');
  }
  res.redirect(demo.activeClaim ? '/payment' : '/scan');
});

// Simulated payment routes
app.get('/payment', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  const order = demo.currentOrder;
  if (order) {
    if (order.status !== 'PENDING_PAYMENT') return res.redirect('/order');
    const breakdown = getPaymentBreakdown(demo, order, order.cashbackUsed > 0);
    return res.render('payment', {
      recommendation: { itemName: order.itemName, price: order.amount },
      merchant: { name: order.merchantName },
      campaign: demo.campaign,
      order: order,
      cashbackBalance: demo.cashbackBalance,
      breakdown: breakdown,
      minimumEligiblePayment: MINIMUM_ELIGIBLE_PAYMENT
    });
  }
  const claim = demo.activeClaim;
  if (!claim) return res.redirect('/scan');
  if (claim.transactionId) return res.redirect('/payment-success');
  if (claim.status !== 'CLAIMED' || isClaimExpired(claim)) return res.redirect('/claim');
  const recommendation = findMerchantForDemo(demo, claim.recommendationId);
  if (!recommendation) return res.redirect('/recommendation');
  res.render('payment', {
    recommendation: recommendation,
    merchant: merchants.felicia,
    campaign: demo.campaign,
    claim: claim,
      order: null,
    minimumEligiblePayment: MINIMUM_ELIGIBLE_PAYMENT
  });
});

app.post('/payment', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  const order = demo.currentOrder;
  if (order) {
    if (order.status !== 'PENDING_PAYMENT') return res.redirect('/order');
    const breakdown = getPaymentBreakdown(demo, order, (req.body || {}).useCashback === 'on');
    order.cashbackUsed = breakdown.cashbackUsed;
    order.amountToPay = breakdown.amountToPay;
    const dateAndTime = getCurrentDateAndTime();
    const transactionId = createTransactionId(demo);
    const transaction = {
      id: transactionId, merchantId: order.merchantId,
      merchantName: order.merchantName, outlet: merchants.felicia.outlet,
      date: dateAndTime.date, time: dateAndTime.time, amount: order.amount,
      orderAmount: order.amount, cashbackUsed: order.cashbackUsed,
      netsPaid: order.amountToPay,
      displayAmount: '$' + order.amountToPay.toFixed(2), status: 'Successful',
      paymentMethod: 'NETS', vouchCreated: false, cashbackAwarded: 0,
      eligible: order.amount >= MINIMUM_ELIGIBLE_PAYMENT,
      orderNumber: order.orderNumber
    };
    demo.transactions.unshift(transaction);
    order.status = 'PAID';
    order.paymentRecorded = true;
    order.transactionId = transactionId;
    demo.cashbackBalance = Math.max(0, demo.cashbackBalance - order.cashbackUsed);
    demo.latestPayment = {
      transactionId: transactionId,
      merchantName: order.merchantName,
      itemName: order.itemName,
      amount: order.amount,
      orderAmount: order.amount,
      cashbackUsed: order.cashbackUsed,
      netsPaid: order.amountToPay,
      rewardAwarded: 0,
      eligible: transaction.eligible,
      successfulAt: dateAndTime.iso
    };
    if (transaction.eligible) {
      demo.metrics.eligiblePayments += 1;
      demo.metrics.attributedTransactionValue += order.amount;
    }
    return res.redirect('/payment-success');
  }
  const claim = demo.activeClaim;
  if (!claim) return res.redirect('/scan');
  if (claim.transactionId || demo.latestPayment) return res.redirect('/payment-success');
  const recommendation = findMerchantForDemo(demo, claim.recommendationId);
  if (!recommendation) return res.redirect('/recommendation');
  const eligible = isPaymentEligible(demo, claim, recommendation);
  const rewardAwarded = eligible ? demo.campaign.rewardAmount : 0;
  const dateAndTime = getCurrentDateAndTime();
  const transactionId = createTransactionId(demo);
  const transaction = {
    id: transactionId, merchantId: recommendation.merchantId,
    merchantName: recommendation.merchantName, outlet: merchants.felicia.outlet,
    date: dateAndTime.date, time: dateAndTime.time, amount: recommendation.price,
    displayAmount: '$' + recommendation.price.toFixed(2), status: 'Successful',
    paymentMethod: 'NETS', vouchCreated: false, cashbackAwarded: rewardAwarded,
    eligible: eligible, claimId: claim.id, campaignId: demo.campaign.id
  };
  demo.transactions.unshift(transaction);
  claim.transactionId = transactionId;
  claim.rewardAwarded = rewardAwarded;
  claim.status = eligible ? 'REDEEMED' : 'USED_INELIGIBLE';
  if (eligible) {
    demo.promotionalRedemptions.unshift({
      id: 'redemption-' + claim.id,
      claimId: claim.id,
      campaignId: demo.campaign.id,
      merchantId: recommendation.merchantId,
      merchantName: recommendation.merchantName,
      itemName: recommendation.itemName,
      transactionId: transactionId,
      rewardAmount: rewardAwarded,
      date: dateAndTime.date,
      status: 'Redeemed'
    });
    demo.campaign.redemptionsToday += 1;
    demo.metrics.eligiblePayments += 1;
    demo.metrics.attributedTransactionValue += recommendation.price;
    demo.metrics.rewardCost += rewardAwarded;
  }
  demo.latestPayment = {
    transactionId: transactionId,
    merchantName: recommendation.merchantName,
    itemName: recommendation.itemName,
    amount: recommendation.price,
    rewardAwarded: rewardAwarded,
    eligible: eligible,
    successfulAt: dateAndTime.iso
  };
  res.redirect('/payment-success');
});

app.get('/payment-success', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (!demo.latestPayment) return res.redirect('/home');
  const transaction = findTransactionById(demo.transactions, demo.latestPayment.transactionId);
  res.render('payment-success', {
    payment: demo.latestPayment,
    transaction: transaction,
    order: demo.currentOrder,
    cashbackBalance: demo.cashbackBalance,
    rewardAmount: demo.campaign.rewardAmount
  });
});

app.get('/order', function(req, res) {
  initialiseDemoSession(req);
  const order = req.session.demo.currentOrder;
  if (!order) return res.redirect('/home');
  res.render('order-status', {
    order: order,
    campaign: req.session.demo.campaign,
    canVouch: order.status === 'COLLECTED' && order.paymentRecorded && order.cashbackRecorded
  });
});

app.post('/merchant/start-preparing', function(req, res) {
  initialiseDemoSession(req);
  const order = req.session.demo.currentOrder;
  if (order && order.status === 'PAID') order.status = 'PREPARING';
  res.redirect('/merchant?tab=orders');
});

app.post('/merchant/mark-ready', function(req, res) {
  initialiseDemoSession(req);
  const order = req.session.demo.currentOrder;
  if (order && order.status === 'PREPARING') order.status = 'READY';
  res.redirect('/merchant?tab=orders');
});

app.post('/collection', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  const order = demo.currentOrder;
  if (order && order.status === 'READY') {
    order.status = 'COLLECTED';
    order.collected = true;
    releaseOrderCashback(demo, order);
  }
  res.redirect('/order');
});

// Payment-Verified Vouch routes
app.get('/vouch', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (!demo.latestPayment || !demo.latestPayment.eligible ||
      (demo.currentOrder && (!demo.currentOrder.collected || !demo.currentOrder.cashbackRecorded))) return res.redirect('/home');
  const transaction = findTransactionById(demo.transactions, demo.latestPayment.transactionId);
  if (!transaction) return res.redirect('/home');
  let alreadyCreated = false;
  for (let i = 0; i < demo.paymentVerifiedVouches.length; i++) {
    if (demo.paymentVerifiedVouches[i].transactionId === transaction.id) alreadyCreated = true;
  }
  res.render('vouch', {
    merchant: merchants.felicia,
    transaction: transaction,
    alreadyCreated: alreadyCreated
  });
});

app.post('/vouch', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (!demo.latestPayment || !demo.latestPayment.eligible ||
      (demo.currentOrder && (!demo.currentOrder.collected || !demo.currentOrder.cashbackRecorded))) return res.redirect('/home');
  if (req.body.action === 'skip') {
    demo.journeyComplete = true;
    return res.redirect('/home');
  }
  if (req.body.action !== 'create') return res.redirect('/vouch');
  const transaction = findTransactionById(demo.transactions, demo.latestPayment.transactionId);
  if (!transaction) return res.redirect('/home');
  for (let i = 0; i < demo.paymentVerifiedVouches.length; i++) {
    if (demo.paymentVerifiedVouches[i].transactionId === transaction.id) {
      return res.redirect('/profile?tab=vouches');
    }
  }
  const dateAndTime = getCurrentDateAndTime();
  demo.paymentVerifiedVouches.unshift({
    id: 'vouch-' + demo.nextVouchNumber,
    user: demo.user.name,
    merchantId: transaction.merchantId,
    merchantName: transaction.merchantName,
    transactionId: transaction.id,
    date: dateAndTime.date,
    status: 'Completed',
    verifiedStatus: 'Payment-Verified (Simulated)'
  });
  demo.nextVouchNumber += 1;
  transaction.vouchCreated = true;
  demo.journeyComplete = true;
  res.redirect('/profile?tab=vouches');
});

// Profile routes
app.get('/profile', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  let tab = req.query.tab;
  if (tab !== 'transactions' && tab !== 'vouches') tab = 'settings';
  res.render('profile', {
    user: demo.user,
    profile: demo.profile,
    dietaryPreferenceOptions: dietaryPreferenceOptions,
    tab: tab,
    transactions: demo.transactions,
    promotionalRedemptions: demo.promotionalRedemptions,
    paymentVerifiedVouches: demo.paymentVerifiedVouches,
    cashbackBalance: demo.cashbackBalance,
    settingsError: req.query.error === 'invalid'
  });
});

app.post('/profile', function(req, res) {
  initialiseDemoSession(req);
  const dietaryPreference = req.body.dietaryPreference;
  const budget = Number(req.body.budget);
  const maxDistanceMinutes = Number(req.body.maxDistanceMinutes);

  if (!isValidDietaryPreference(dietaryPreference)) {
    return res.redirect('/profile?tab=settings&error=invalid');
  }
  if (!Number.isFinite(budget) || budget < 1 || budget > 100) {
    return res.redirect('/profile?tab=settings&error=invalid');
  }
  if (!Number.isInteger(maxDistanceMinutes) || maxDistanceMinutes < 1 || maxDistanceMinutes > 60) {
    return res.redirect('/profile?tab=settings&error=invalid');
  }

  req.session.demo.profile.dietaryPreference = dietaryPreference;
  req.session.demo.profile.budget = budget;
  req.session.demo.profile.maxDistanceMinutes = maxDistanceMinutes;
  req.session.demo.profile.notifications = req.body.notifications === 'on';
  if (!req.session.demo.recommendationAccepted) {
    req.session.demo.selectedMerchantId = null;
    req.session.demo.rejectedMerchantIds = [];
    req.session.demo.recommendationFeedback = [];
    req.session.demo.lastRejectionReason = null;
  }
  res.redirect('/profile?tab=settings');
});

app.get('/transactions/:id', function(req, res) {
  initialiseDemoSession(req);
  const transaction = findTransactionById(req.session.demo.transactions, req.params.id);
  if (!transaction) return res.redirect('/profile?tab=transactions');
  res.render('transaction-detail', { transaction: transaction });
});

// Merchant campaign and results routes
app.get('/merchant', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  const tab = req.query.tab === 'results' || req.query.tab === 'orders' ? req.query.tab : 'campaign';
  res.render('merchant', {
    merchant: merchants.felicia,
    tab: tab,
    campaign: demo.campaign,
    availability: getCampaignAvailability(demo.campaign, false),
    metrics: demo.metrics,
    calculations: getCampaignCalculations(demo),
    minimumEligiblePayment: MINIMUM_ELIGIBLE_PAYMENT,
    order: demo.currentOrder
  });
});

app.post('/merchant/offer', function(req, res) {
  initialiseDemoSession(req);
  const campaign = req.session.demo.campaign;
  const rewardAmount = Number(req.body.rewardAmount);
  const dailyCap = Number(req.body.dailyCap);
  const startTime = req.body.startTime;
  const endTime = req.body.endTime;
  if (!isValidCampaignInput(rewardAmount, dailyCap, startTime, endTime)) {
    return res.redirect('/merchant?tab=campaign&error=invalid');
  }
  campaign.rewardAmount = rewardAmount;
  campaign.dailyCap = dailyCap;
  campaign.startTime = startTime;
  campaign.endTime = endTime;
  campaign.status = req.body.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
  res.redirect('/merchant?tab=campaign');
});

// Demo reset
app.post('/reset-demo', function(req, res) {
  req.session.destroy(function(error) {
    if (error) return res.redirect('/home');
    res.clearCookie('connect.sid');
    res.redirect('/home');
  });
});

// Start server
app.listen(PORT, function() {
  console.log(`NETS Vouch AI running on http://localhost:${PORT}`);
});
