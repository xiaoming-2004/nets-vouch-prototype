// Test rows only; never inserted into a database or added to the application catalogue.
function row(values = {}) {
  return { merchant_id: 'catalogue-a', name: 'Catalogue fixture A', location_label: 'Fixture outlet A',
    distance_metres: 80, cuisine_type: 'rice', typical_price: '5.00', dietary_halal: 1,
    dietary_vegetarian: 0, dietary_vegan: 0, reward_amount: '0.75', min_spend: '2.00',
    is_sample_data: 0, ...values };
}
function seedCatalogue(database) {
  database.seedMerchant(row());
  database.seedMerchant(row({ merchant_id: 'catalogue-b', name: 'Catalogue fixture B', typical_price: '6.00', distance_metres: 160 }));
  database.seedMerchant(row({ merchant_id: 'catalogue-c', name: 'Catalogue fixture C', typical_price: '7.00', distance_metres: 240 }));
}
module.exports = { row, seedCatalogue };
