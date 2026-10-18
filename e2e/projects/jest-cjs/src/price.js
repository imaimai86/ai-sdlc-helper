/* eslint-disable */
// Prices are whole cents.

/** "12.50" for 1250. */
function formatPrice(cents) {
  return (cents / 100).toFixed(2);
}

module.exports = { formatPrice };
