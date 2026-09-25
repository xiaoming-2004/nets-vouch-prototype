// Per-request time budget for Smart Match matching (discovery + dietary research + ranking).
//
// One explicit overall deadline is created per /smart-match/result request and carried through all
// async work with AsyncLocalStorage, so provider calls deep in the call chain can size their own
// timeout from the time actually left and are cancelled (AbortSignal) when the deadline passes.
// Outside a budget (unit tests calling helpers directly) every helper keeps its standalone default.
// The trace collects SAFE diagnostics only: counts, timings and reasons - never keys or user data.

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function createBudget(totalMs, label) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(function() { controller.abort(); }, Math.max(0, totalMs));
  if (typeof timer.unref === 'function') timer.unref();
  return {
    label: label || 'smart-match',
    totalMs: totalMs,
    startedAt: startedAt,
    deadline: startedAt + totalMs,
    signal: controller.signal,
    trace: { providers: {}, cache: { hits: 0, sharedHits: 0, misses: 0, sharedErrors: 0 },
      research: { researched: 0, unchecked: 0, waves: 0, dedupedWaits: 0 }, deadlineHit: false, notes: [] },
    remaining: function() { return Math.max(0, this.deadline - Date.now()); },
    elapsed: function() { return Date.now() - this.startedAt; },
    finish: function() { clearTimeout(timer); }
  };
}

function runWithBudget(budget, fn) {
  return storage.run(budget, fn);
}

function currentBudget() {
  return storage.getStore() || null;
}

// Timeout for ONE provider call: its own cap, limited by the request's remaining time minus a
// reserve kept for later stages. Returns 0 when there is no longer enough time to start the call.
function callTimeout(capMs, reserveMs) {
  const budget = currentBudget();
  if (!budget) return capMs;
  const available = budget.remaining() - (reserveMs || 0);
  return available <= 0 ? 0 : Math.min(capMs, available);
}

// A call's own AbortSignal combined with the request deadline, so outstanding work is cancelled.
function withBudgetSignal(signal) {
  const budget = currentBudget();
  return budget ? AbortSignal.any([signal, budget.signal]) : signal;
}

function recordProviderCall(name, startedAt, ok) {
  const budget = currentBudget();
  if (!budget) return;
  const entry = budget.trace.providers[name] || (budget.trace.providers[name] = { calls: 0, failed: 0, ms: 0 });
  entry.calls += 1;
  if (!ok) entry.failed += 1;
  entry.ms += Date.now() - startedAt;
}

function traceNote(text) {
  const budget = currentBudget();
  if (budget && budget.trace.notes.length < 40) budget.trace.notes.push(text);
}

function markDeadlineHit(where) {
  const budget = currentBudget();
  if (!budget) return;
  budget.trace.deadlineHit = true;
  traceNote('deadline reached: ' + where);
}

module.exports = { createBudget: createBudget, runWithBudget: runWithBudget, currentBudget: currentBudget,
  callTimeout: callTimeout, withBudgetSignal: withBudgetSignal, recordProviderCall: recordProviderCall,
  traceNote: traceNote, markDeadlineHit: markDeadlineHit };
