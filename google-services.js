'use strict';

// Task 9: guaranteed-zero-cost mode. ONE central capability gate for every Google (and Foursquare)
// location/discovery request in the application.
//
// Nothing Google-related is active unless the opt-in master switch is EXACTLY the string "true"
// (missing, blank, "TRUE", "1", " true" and every other value mean disabled) AND the specific key a
// capability needs exists. These helpers only answer yes/no: they never return, log or throw a key value.
// Each helper reads the environment at call time, so turning the switch off takes effect immediately.

const SWITCH = 'GOOGLE_SERVICES_ENABLED';
// Names only: used to warn that a key is present while the switch is off. Values are never read out.
const GATED_KEY_NAMES = ['GOOGLE_MAPS_BROWSER_API_KEY', 'GOOGLE_ROUTES_API_KEY', 'GOOGLE_PLACES_API_KEY', 'FOURSQUARE_API_KEY'];

function switchOn(env) {
  return (env || process.env)[SWITCH] === 'true';
}

function hasKey(name, env) {
  const value = (env || process.env)[name];
  return typeof value === 'string' && value.trim() !== '';
}

// Browser Maps JavaScript / Places autocomplete ("Search for a place").
function browserMapsEnabled(env) { return switchOn(env) && hasKey('GOOGLE_MAPS_BROWSER_API_KEY', env); }
// Server-side Routes (walking times for a live starting point).
function routesEnabled(env) { return switchOn(env) && hasKey('GOOGLE_ROUTES_API_KEY', env); }
// Legacy Google Places discovery, continuation/widening and the photo proxy.
function legacyPlacesEnabled(env) { return switchOn(env) && hasKey('GOOGLE_PLACES_API_KEY', env); }
// Legacy Foursquare location discovery (and its health ping). Gated by the same master switch.
function foursquareDiscoveryEnabled(env) { return switchOn(env) && hasKey('FOURSQUARE_API_KEY', env); }

// The variable NAMES of any gated key that is present while the master switch is off.
function ignoredKeyNames(env) {
  if (switchOn(env)) return [];
  return GATED_KEY_NAMES.filter(function(name) { return hasKey(name, env); });
}

// Startup log lines. Names only, never a value, prefix, suffix or length.
function startupMessages(env) {
  if (switchOn(env)) return ['Google services enabled (' + SWITCH + '=true): each capability still needs its own key'];
  const lines = ['Google services disabled (S$0 mode)'];
  ignoredKeyNames(env).forEach(function(name) {
    lines.push('WARNING: ' + name + ' is set but ignored because ' + SWITCH + ' is not exactly "true"');
  });
  return lines;
}

module.exports = {
  SWITCH, switchOn, browserMapsEnabled, routesEnabled, legacyPlacesEnabled, foursquareDiscoveryEnabled,
  ignoredKeyNames, startupMessages
};
