/* eslint-disable */
/** The price in cents after a <percent> discount, rounded to the nearest cent (halves up). */
function applyDiscount(cents, percent) {
  if (percent < 0 || percent > 100) throw new RangeError(`percent must be between 0 and 100, got ${percent}`);
  return Math.round(cents * (100 - percent) / 100);
}

module.exports = { applyDiscount };
