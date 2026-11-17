'use strict';

// Task 7: the server-owned food vocabulary. Everything the matcher may ever treat as a food fact is
// listed here or stored in MySQL: approved categories, approved tags, a small reviewed alias list,
// the legacy cuisine mapping and one shared normaliser. Nothing here is fuzzy, semantic or learned,
// and nothing the language model returns can add to it.

// The six quick choices, in display order. `any` means "no food requirement".
const FOOD_CHOICES = [
  { value: 'any', label: 'Anything' },
  { value: 'rice', label: 'Rice dishes' },
  { value: 'noodles', label: 'Noodles' },
  { value: 'healthy-bowls', label: 'Healthy bowls' },
  { value: 'indian', label: 'Indian food' },
  { value: 'wraps', label: 'Wraps' }
];
const FOOD_CATEGORIES = FOOD_CHOICES.map(choice => choice.value);

// Categories a stored menu item may carry (the five specific chips plus soup and bread, which are
// reachable through typed words).
const MENU_CATEGORIES = ['rice', 'noodles', 'healthy-bowls', 'indian', 'wraps', 'soup', 'bread'];

// Approved stored tags. A tag outside this list is rejected by the seed validator and by the loader.
const MENU_TAGS = [
  'ayam-goreng', 'bee-hoon', 'beef', 'briyani', 'chicken', 'chicken-rice', 'clear-soup', 'coconut', 'curry',
  'dhal', 'donburi', 'egg', 'fish', 'fried', 'grilled', 'hummus', 'kaya', 'kebab', 'light', 'mee-pok',
  'mushroom', 'naan', 'pork', 'prata', 'pumpkin', 'quinoa', 'rendang', 'salmon', 'shawarma', 'soba',
  'soto', 'spicy', 'teriyaki', 'toast', 'tofu', 'vegetables', 'wanton'
];

// Reviewed Singapore wording and spelling. Keys are normalised phrases; values are normalised phrases that
// must resolve to a stored approved category, tag or item-name phrase. Plural and hyphen/space variants
// are handled by the normaliser and need no entry.
const ALIASES = {
  ayam: 'chicken',
  biryani: 'briyani',
  biriyani: 'briyani',
  briani: 'briyani',
  'roti canai': 'prata',
  canai: 'prata',
  paratha: 'prata',
  beehoon: 'bee hoon',
  kabab: 'kebab'
};

// Legacy `cuisine` (a soft ranking preference) to the new categories. Used only to detect a request that
// supplies both fields with different concrete choices, and for documentation. `null` = no chip category.
const LEGACY_CUISINE_TO_FOOD = { any: 'any', rice: 'rice', noodles: 'noodles', pasta: null, soup: 'soup', bread: 'bread' };

const DIETARY_WORDS = ['halal', 'vegetarian', 'vegan'];
const NEGATION_BEFORE = ['no', 'not', 'non', 'without', 'except', 'avoid', 'never'];
const NEGATION_AFTER = ['free'];

// A term the model may return: lowercase words, digits, spaces and hyphens only, 1 to 30 characters.
const DISH_TERM_PATTERN = /^[a-z0-9][a-z0-9 -]{0,29}$/;
const MAX_DISH_TERMS = 3;

function singularToken(token) {
  if (token.length > 3 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 3 && /(ch|sh|x|z|ss)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 2 && token.endsWith('s') && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

// One normaliser for stored text and requested text: lower case, accents stripped, punctuation and
// hyphens to spaces, spaces collapsed, tokens singularised by a fixed rule. Returns the token list.
function tokens(text) {
  return String(text === null || text === undefined ? '' : text).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(singularToken);
}

function normalisePhrase(text) {
  return tokens(text).join(' ');
}

const NORMALISED_ALIASES = {};
Object.keys(ALIASES).forEach(key => { NORMALISED_ALIASES[normalisePhrase(key)] = normalisePhrase(ALIASES[key]); });

// The canonical phrase a requested term is matched as: alias applied once, deterministically.
function canonicalPhrase(rawTerm) {
  const phrase = normalisePhrase(rawTerm);
  return Object.prototype.hasOwnProperty.call(NORMALISED_ALIASES, phrase) ? NORMALISED_ALIASES[phrase] : phrase;
}

// Tokens of the user's own text that follow a negation word (or precede "free"), so a negated food or
// diet word is never turned into a positive requirement.
function negatedTokens(text) {
  const words = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const negated = new Set();
  words.forEach((word, index) => {
    if (NEGATION_BEFORE.indexOf(word) !== -1) {
      for (let i = index + 1; i <= index + 3 && i < words.length; i++) negated.add(singularToken(words[i]));
    }
    if (NEGATION_AFTER.indexOf(word) !== -1) {
      for (let i = index - 1; i >= index - 2 && i >= 0; i--) negated.add(singularToken(words[i]));
    }
  });
  return negated;
}

module.exports = {
  FOOD_CHOICES, FOOD_CATEGORIES, MENU_CATEGORIES, MENU_TAGS, ALIASES, LEGACY_CUISINE_TO_FOOD, DIETARY_WORDS,
  DISH_TERM_PATTERN, MAX_DISH_TERMS, tokens, normalisePhrase, canonicalPhrase, negatedTokens
};
