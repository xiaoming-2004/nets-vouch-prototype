// Import packages
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
  felicia: { id: 'felicia-chicken-rice', name: "Felicia's Chicken Rice", outlet: 'RP North Food Court · Stall 08' },
  cafeAbc: { id: 'cafe-abc', name: 'Café ABC', outlet: 'Café ABC — Orchard Demo Outlet' },
  toastAndCo: { id: 'toast-and-co', name: 'Toast & Co.', outlet: 'Toast & Co. — Tiong Bahru Demo Outlet' },
  hawker88: { id: 'hawker-88', name: 'Hawker 88', outlet: 'Hawker 88 — Central Demo Outlet' }
};

const recommendations = [
  {
    id: 'felicia-chicken-rice', merchantId: merchants.felicia.id,
    merchantName: merchants.felicia.name, itemName: 'Chicken Rice', price: 7.50,
    halal: true, distanceMinutes: 8, cashback: 0.50, vouchCount: 18,
    availability: 'Accepting pickup orders', available: true
  },
  {
    id: 'felicia-porridge', merchantId: merchants.felicia.id,
    merchantName: merchants.felicia.name, itemName: 'Chicken Porridge', price: 6.90,
    halal: true, distanceMinutes: 4, cashback: 0.50, vouchCount: 12,
    availability: 'Express counter available', available: true
  }
];

const rejectionReasons = [
  { id: 'too-far', label: 'Too far' },
  { id: 'too-expensive', label: 'Costs too much' },
  { id: 'not-in-mood', label: 'Not in the mood' },
  { id: 'ate-recently', label: 'Ate this recently' }
];

const initialTransactions = [
  {
    id: 'tx-toast-001', merchantId: merchants.toastAndCo.id,
    merchantName: merchants.toastAndCo.name, outlet: merchants.toastAndCo.outlet,
    date: '1 Sep 2026', time: '8:10 AM', amount: 4.20, displayAmount: '$4.20',
    status: 'Successful', paymentMethod: 'NETS', vouchCreated: true, cashbackAwarded: 0
  },
  {
    id: 'tx-hawker-001', merchantId: merchants.hawker88.id,
    merchantName: merchants.hawker88.name, outlet: merchants.hawker88.outlet,
    date: '30 Aug 2026', time: '12:42 PM', amount: 6.80, displayAmount: '$6.80',
    status: 'Successful', paymentMethod: 'NETS', vouchCreated: false, cashbackAwarded: 0
  }
];

const initialVouches = [
  {
    id: 'vouch-toast-001', user: 'Jia', merchantId: merchants.toastAndCo.id,
    merchantName: merchants.toastAndCo.name, transactionId: 'tx-toast-001',
    date: '1 Sep 2026', tag: 'Good Value', status: 'Completed',
    verifiedStatus: 'Payment-Verified (Simulated)'
  }
];

const initialCampaign = {
  cashback: 0.50,
  minimumSpend: 7.00,
  dailyCap: 20,
  startTime: '11:30',
  endTime: '13:30',
  redemptionsToday: 6,
  status: 'ACTIVE'
};

const initialMetrics = {
  recommendations: 19,
  accepted: 7,
  attributedPayments: 6,
  attributedTransactionValue: 0,
  cashbackCost: 3.00
};

// Helper functions
function copyTransactions() {
  const transactions = [];
  initialTransactions.forEach(function(transaction) {
    transactions.push({ ...transaction });
  });
  return transactions;
}

function copyVouches() {
  const vouches = [];
  initialVouches.forEach(function(vouch) {
    vouches.push({ ...vouch });
  });
  return vouches;
}

function createInitialDemo() {
  return {
    user: { id: 'jia', name: 'Jia' },
    personalisation: {
      completed: false, recommendations: true, transactionAnalysis: true,
      location: true, notifications: true
    },
    selectedRecommendationId: null,
    rejectedRecommendationId: null,
    rejectionReason: null,
    recommendationMetricRecorded: false,
    currentOrder: null,
    nextOrderNumber: 104,
    latestPayment: null,
    nextTransactionNumber: 3,
    transactions: copyTransactions(),
    vouches: copyVouches(),
    nextVouchNumber: 2,
    scanPayment: null,
    campaign: { ...initialCampaign },
    metrics: { ...initialMetrics }
  };
}

function initialiseDemoSession(req) {
  if (!req.session.demo) {
    req.session.demo = createInitialDemo();
  }
}

function findRecommendationById(recommendationId) {
  for (let i = 0; i < recommendations.length; i++) {
    if (recommendations[i].id === recommendationId) return recommendations[i];
  }
  return null;
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

// Simulated Smart Match for Open House prototype.
// Replace the internal matching logic with the AI API later.
function getSmartRecommendation(personalisation, rejectedRecommendationId, rejectionReason) {
  if (!personalisation.recommendations) return null;

  if (rejectionReason && rejectedRecommendationId === 'felicia-chicken-rice') {
    for (let i = 0; i < recommendations.length; i++) {
      if (recommendations[i].id === 'felicia-porridge' && recommendations[i].available) {
        return recommendations[i];
      }
    }
  }

  for (let i = 0; i < recommendations.length; i++) {
    if (recommendations[i].available && recommendations[i].id !== rejectedRecommendationId) {
      return recommendations[i];
    }
  }
  return null;
}

function getMatchReason(personalisation, recommendation, rejectionReason) {
  if (rejectionReason) return 'Adjusted using the reason you selected.';
  let budgetText = 'your lunch preference';
  if (recommendation.price < 8) budgetText = 'your under-$8 lunch preference';

  if (personalisation.transactionAnalysis && personalisation.location) {
    return 'Matches ' + budgetText + ', permitted activity patterns and location.';
  }
  if (personalisation.transactionAnalysis) {
    return 'Matches ' + budgetText + ' and permitted activity patterns. Location was not used.';
  }
  if (personalisation.location) {
    return 'Matched using ' + budgetText + ' and location. Transaction analysis is off.';
  }
  return 'Matched using ' + budgetText + '. Transaction analysis and location are off.';
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

function isWithinCampaignWindow(campaign) {
  const startMinutes = timeToMinutes(campaign.startTime);
  const endMinutes = timeToMinutes(campaign.endTime);
  if (startMinutes === null || endMinutes === null) return false;
  const currentMinutes = getSingaporeMinutesNow();
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

function isCashbackEligible(order, campaign) {
  if (!order || order.status !== 'PAID') return false;
  if (order.amount < campaign.minimumSpend) return false;
  if (campaign.status !== 'ACTIVE') return false;
  if (campaign.redemptionsToday >= campaign.dailyCap) return false;
  if (!isWithinCampaignWindow(campaign)) return false;
  return true;
}

function createTransactionId(demo) {
  const transactionId = 'tx-' + String(demo.nextTransactionNumber).padStart(3, '0');
  demo.nextTransactionNumber += 1;
  return transactionId;
}

function getCampaignCalculations(demo) {
  let conversion = 0;
  let costPerPayment = 0;
  if (demo.metrics.recommendations > 0) {
    conversion = Math.round(demo.metrics.attributedPayments / demo.metrics.recommendations * 100);
  }
  if (demo.metrics.attributedPayments > 0) {
    costPerPayment = demo.metrics.cashbackCost / demo.metrics.attributedPayments;
  }
  return {
    conversion: conversion,
    costPerPayment: costPerPayment,
    maximumDailyCost: demo.campaign.cashback * demo.campaign.dailyCap
  };
}

function isValidCampaignInput(cashback, minimumSpend, dailyCap, startTime, endTime) {
  if (!Number.isFinite(cashback) || cashback < 0) return false;
  if (!Number.isFinite(minimumSpend) || minimumSpend < 0) return false;
  if (!Number.isInteger(dailyCap) || dailyCap < 1) return false;
  if (timeToMinutes(startTime) === null || timeToMinutes(endTime) === null) return false;
  return true;
}

// Personalisation routes
app.get('/', function(req, res) {
  initialiseDemoSession(req);
  if (req.session.demo.personalisation.completed) return res.redirect('/home');
  res.redirect('/personalisation');
});

app.get('/personalisation', function(req, res) {
  initialiseDemoSession(req);
  res.render('personalisation', {
    user: req.session.demo.user,
    personalisation: req.session.demo.personalisation
  });
});

app.post('/personalisation', function(req, res) {
  initialiseDemoSession(req);
  const personalisation = req.session.demo.personalisation;
  personalisation.recommendations = req.body.recommendations === 'on';
  personalisation.transactionAnalysis = req.body.transactionAnalysis === 'on';
  personalisation.location = req.body.location === 'on';
  personalisation.notifications = req.body.notifications === 'on';
  personalisation.completed = true;
  res.redirect('/home');
});

// Home routes
app.get('/home', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (!demo.personalisation.completed) return res.redirect('/personalisation');
  res.render('home', {
    user: demo.user,
    personalisation: demo.personalisation,
    transactions: demo.transactions.slice(0, 2),
    currentOrder: demo.currentOrder
  });
});

// Recommendation routes
app.get('/recommendation', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (!demo.personalisation.completed) return res.redirect('/personalisation');
  if (!demo.personalisation.recommendations) return res.redirect('/home');

  const recommendation = getSmartRecommendation(
    demo.personalisation, demo.rejectedRecommendationId, demo.rejectionReason
  );
  if (!recommendation) return res.redirect('/home');
  demo.selectedRecommendationId = recommendation.id;

  if (!demo.recommendationMetricRecorded) {
    demo.metrics.recommendations += 1;
    demo.recommendationMetricRecorded = true;
  }

  let rejectionNote = null;
  if (demo.rejectionReason) {
    rejectionNote = getRejectionReasonLabel(demo.rejectionReason) + '. Here is a better fit.';
  }

  res.render('recommendation', {
    user: demo.user,
    personalisation: demo.personalisation,
    recommendation: recommendation,
    matchReason: getMatchReason(demo.personalisation, recommendation, demo.rejectionReason),
    rejectionNote: rejectionNote,
    currentOrder: demo.currentOrder
  });
});

app.get('/recommendation/reject', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (!demo.personalisation.completed) return res.redirect('/personalisation');
  if (!demo.personalisation.recommendations) return res.redirect('/home');
  const currentRecommendation = findRecommendationById(demo.selectedRecommendationId);
  if (!currentRecommendation) return res.redirect('/recommendation');
  res.render('rejection', {
    user: demo.user,
    currentRecommendation: currentRecommendation,
    rejectionReasons: rejectionReasons
  });
});

app.post('/recommendation/reject', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (!demo.personalisation.completed) return res.redirect('/personalisation');
  if (!demo.personalisation.recommendations) return res.redirect('/home');
  if (!findRecommendationById(demo.selectedRecommendationId)) return res.redirect('/recommendation');
  if (!isValidRejectionReason(req.body.reason)) return res.redirect('/recommendation/reject');
  demo.rejectedRecommendationId = demo.selectedRecommendationId;
  demo.rejectionReason = req.body.reason;
  res.redirect('/recommendation');
});

app.post('/recommendation/accept', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (!demo.personalisation.completed) return res.redirect('/personalisation');
  if (!demo.personalisation.recommendations) return res.redirect('/home');

  if (demo.currentOrder) {
    if (demo.currentOrder.status === 'PENDING_PAYMENT') return res.redirect('/payment');
    return res.redirect('/order');
  }

  const recommendation = findRecommendationById(demo.selectedRecommendationId);
  if (!recommendation) return res.redirect('/recommendation');
  const dateAndTime = getCurrentDateAndTime();

  demo.currentOrder = {
    orderNumber: demo.nextOrderNumber,
    recommendationId: recommendation.id,
    merchantId: recommendation.merchantId,
    merchantName: recommendation.merchantName,
    outlet: merchants.felicia.outlet,
    itemName: recommendation.itemName,
    amount: recommendation.price,
    status: 'PENDING_PAYMENT',
    paymentRecorded: false,
    cashbackRecorded: false,
    cashbackAwarded: 0,
    metricsRecorded: false,
    transactionId: null,
    vouchRecorded: false,
    createdAt: dateAndTime.iso
  };
  demo.nextOrderNumber += 1;
  demo.metrics.accepted += 1;
  res.redirect('/payment');
});

// Payment routes
app.get('/payment', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (!demo.currentOrder) return res.redirect('/home');
  if (demo.currentOrder.paymentRecorded) return res.redirect('/payment-success');
  if (demo.currentOrder.status !== 'PENDING_PAYMENT') return res.redirect('/order');
  res.render('payment', { order: demo.currentOrder, campaign: demo.campaign });
});

app.post('/payment', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  const order = demo.currentOrder;
  if (!order) return res.redirect('/home');
  if (order.paymentRecorded) return res.redirect('/payment-success');
  if (order.status !== 'PENDING_PAYMENT') return res.redirect('/order');

  order.status = 'PAID';
  let cashbackAwarded = 0;
  if (!order.cashbackRecorded && isCashbackEligible(order, demo.campaign)) {
    cashbackAwarded = demo.campaign.cashback;
    demo.campaign.redemptionsToday += 1;
  }
  order.cashbackRecorded = true;
  order.cashbackAwarded = cashbackAwarded;

  const dateAndTime = getCurrentDateAndTime();
  const transactionId = createTransactionId(demo);
  const transaction = {
    id: transactionId, merchantId: order.merchantId, merchantName: order.merchantName,
    outlet: order.outlet, date: dateAndTime.date, time: dateAndTime.time,
    amount: order.amount, displayAmount: '$' + order.amount.toFixed(2),
    status: 'Successful', paymentMethod: 'NETS', vouchCreated: false,
    cashbackAwarded: cashbackAwarded
  };
  demo.transactions.unshift(transaction);
  order.transactionId = transactionId;
  order.paymentRecorded = true;

  if (!order.metricsRecorded) {
    demo.metrics.attributedPayments += 1;
    demo.metrics.attributedTransactionValue += order.amount;
    demo.metrics.cashbackCost += cashbackAwarded;
    order.metricsRecorded = true;
  }

  demo.latestPayment = {
    source: 'ORDER', transactionId: transactionId, merchantName: order.merchantName,
    amount: order.amount, cashbackAwarded: cashbackAwarded, successfulAt: dateAndTime.iso
  };
  res.redirect('/payment-success');
});

app.get('/payment-success', function(req, res) {
  initialiseDemoSession(req);
  if (!req.session.demo.latestPayment) return res.redirect('/home');
  res.render('payment-success', { payment: req.session.demo.latestPayment });
});

// Order routes
app.get('/order', function(req, res) {
  initialiseDemoSession(req);
  const order = req.session.demo.currentOrder;
  if (!order) return res.redirect('/home');
  if (order.status === 'PENDING_PAYMENT') return res.redirect('/payment');
  res.render('order-status', { order: order });
});

// Merchant routes
app.get('/merchant', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  let tab = req.query.tab;
  if (tab === 'setup') tab = 'offer';
  if (tab !== 'offer' && tab !== 'orders' && tab !== 'results') {
    tab = demo.currentOrder ? 'orders' : 'offer';
  }
  res.render('merchant', {
    user: demo.user,
    merchant: merchants.felicia,
    tab: tab,
    order: demo.currentOrder,
    campaign: demo.campaign,
    metrics: demo.metrics,
    calculations: getCampaignCalculations(demo)
  });
});

app.post('/merchant/offer', function(req, res) {
  initialiseDemoSession(req);
  const campaign = req.session.demo.campaign;
  const cashback = Number(req.body.cashback);
  const minimumSpend = Number(req.body.minimumSpend);
  const dailyCap = Number(req.body.dailyCap);
  const startTime = req.body.startTime;
  const endTime = req.body.endTime;
  if (!isValidCampaignInput(cashback, minimumSpend, dailyCap, startTime, endTime)) {
    return res.redirect('/merchant?tab=offer');
  }
  campaign.cashback = cashback;
  campaign.minimumSpend = minimumSpend;
  campaign.dailyCap = dailyCap;
  campaign.startTime = startTime;
  campaign.endTime = endTime;
  campaign.status = req.body.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE';
  res.redirect('/merchant?tab=offer');
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

// Collection routes
app.get('/collection', function(req, res) {
  initialiseDemoSession(req);
  const order = req.session.demo.currentOrder;
  if (!order) return res.redirect('/home');
  if (order.status === 'COLLECTED') return res.redirect('/vouch');
  if (order.status !== 'READY') return res.redirect('/order');
  res.render('collection-ready', { order: order });
});

app.post('/collection', function(req, res) {
  initialiseDemoSession(req);
  const order = req.session.demo.currentOrder;
  if (!order) return res.redirect('/home');
  if (order.status === 'READY') {
    order.status = 'COLLECTED';
    return res.redirect('/vouch');
  }
  if (order.status === 'COLLECTED') return res.redirect('/vouch');
  res.redirect('/order');
});

// Vouch routes
app.get('/vouch', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  const order = demo.currentOrder;
  if (!order || !order.paymentRecorded || order.status !== 'COLLECTED') return res.redirect('/order');
  const transaction = findTransactionById(demo.transactions, order.transactionId);
  if (!transaction) return res.redirect('/order');
  res.render('post-meal-vouch', {
    order: order,
    transaction: transaction,
    alreadyCreated: order.vouchRecorded
  });
});

app.post('/vouch', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  const order = demo.currentOrder;
  if (!order || !order.paymentRecorded || order.status !== 'COLLECTED') return res.redirect('/order');
  if (req.body.action === 'skip') return res.redirect('/home');
  if (req.body.action !== 'create') return res.redirect('/vouch');
  const transaction = findTransactionById(demo.transactions, order.transactionId);
  if (!transaction) return res.redirect('/order');

  for (let i = 0; i < demo.vouches.length; i++) {
    if (demo.vouches[i].transactionId === transaction.id) {
      order.vouchRecorded = true;
      return res.redirect('/profile?tab=vouches');
    }
  }

  const dateAndTime = getCurrentDateAndTime();
  demo.vouches.unshift({
    id: 'vouch-' + demo.nextVouchNumber,
    user: demo.user.name,
    merchantId: order.merchantId,
    merchantName: order.merchantName,
    transactionId: transaction.id,
    date: dateAndTime.date,
    tag: 'Worth It',
    status: 'Completed',
    verifiedStatus: 'Payment-Verified (Simulated)'
  });
  demo.nextVouchNumber += 1;
  transaction.vouchCreated = true;
  order.vouchRecorded = true;
  res.redirect('/profile?tab=vouches');
});

// Profile routes
app.get('/profile', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  if (!demo.personalisation.completed) return res.redirect('/personalisation');
  const tab = req.query.tab === 'vouches' ? 'vouches' : 'transactions';
  res.render('profile', {
    user: demo.user, tab: tab, transactions: demo.transactions, vouches: demo.vouches
  });
});

app.get('/transactions/:id', function(req, res) {
  initialiseDemoSession(req);
  const transaction = findTransactionById(req.session.demo.transactions, req.params.id);
  if (!transaction) return res.redirect('/profile?tab=transactions');
  res.render('transaction-detail', { transaction: transaction });
});

// Scan-to-Pay routes
app.get('/scan', function(req, res) {
  initialiseDemoSession(req);
  if (!req.session.demo.personalisation.completed) return res.redirect('/personalisation');
  res.render('scan', { merchant: merchants.cafeAbc });
});

app.post('/scan', function(req, res) {
  initialiseDemoSession(req);
  req.session.demo.scanPayment = {
    merchantId: merchants.cafeAbc.id,
    merchantName: merchants.cafeAbc.name,
    outlet: merchants.cafeAbc.outlet,
    amount: 8.50,
    paymentRecorded: false,
    transactionId: null
  };
  res.redirect('/scan/payment');
});

app.get('/scan/payment', function(req, res) {
  initialiseDemoSession(req);
  const scanPayment = req.session.demo.scanPayment;
  if (!scanPayment) return res.redirect('/scan');
  if (scanPayment.paymentRecorded) return res.redirect('/payment-success');
  res.render('payment-review', { scanPayment: scanPayment });
});

app.post('/scan/payment', function(req, res) {
  initialiseDemoSession(req);
  const demo = req.session.demo;
  const scanPayment = demo.scanPayment;
  if (!scanPayment) return res.redirect('/scan');
  if (scanPayment.paymentRecorded) return res.redirect('/payment-success');

  const dateAndTime = getCurrentDateAndTime();
  const transactionId = createTransactionId(demo);
  const transaction = {
    id: transactionId, merchantId: scanPayment.merchantId,
    merchantName: scanPayment.merchantName, outlet: scanPayment.outlet,
    date: dateAndTime.date, time: dateAndTime.time, amount: scanPayment.amount,
    displayAmount: '$' + scanPayment.amount.toFixed(2), status: 'Successful',
    paymentMethod: 'NETS', vouchCreated: false, cashbackAwarded: 0
  };
  demo.transactions.unshift(transaction);
  scanPayment.paymentRecorded = true;
  scanPayment.transactionId = transactionId;
  demo.latestPayment = {
    source: 'SCAN', transactionId: transactionId, merchantName: scanPayment.merchantName,
    amount: scanPayment.amount, cashbackAwarded: 0, successfulAt: dateAndTime.iso
  };
  res.redirect('/payment-success');
});

// Demo reset
app.post('/reset-demo', function(req, res) {
  req.session.destroy(function(error) {
    if (error) return res.redirect('/home');
    res.clearCookie('connect.sid');
    res.redirect('/personalisation');
  });
});

// Start server
app.listen(PORT, function() {
  console.log(`NETS Vouch AI running on http://localhost:${PORT}`);
});
