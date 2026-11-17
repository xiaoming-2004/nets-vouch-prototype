// Test-only fixtures for the Task 7 menu suites. Nothing here touches a real database.
const { merchants } = require('../../sample-data/nets-vouch-task3.cjs');
const menu = require('../../sample-data/nets-vouch-task7-menu.cjs');

// Seeds the ten Task 3 fictional merchants (with their sample coordinates) into the fake catalogue.
function seedTask3Merchants(database) {
  merchants.forEach(m => database.seedMerchant({
    merchant_id: m.merchantId, name: m.name, location_label: m.locationLabel, distance_metres: m.distanceMetres,
    cuisine_type: m.cuisineType, typical_price: m.typicalPrice, dietary_halal: m.dietaryHalal ? 1 : 0,
    dietary_vegetarian: m.dietaryVegetarian ? 1 : 0, dietary_vegan: m.dietaryVegan ? 1 : 0,
    reward_amount: m.rewardAmount, min_spend: m.minSpend, is_sample_data: 1,
    latitude: m.latitude.toFixed(6), longitude: m.longitude.toFixed(6)
  }));
}

// Installs the sample menu as the rows the application's batch SELECT returns.
function seedMenu(database) { database.menuRows = menu.joinRows(); }

module.exports = { seedTask3Merchants, seedMenu, menu };
