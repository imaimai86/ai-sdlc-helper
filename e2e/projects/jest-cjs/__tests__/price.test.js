/* eslint-disable */
const { formatPrice } = require('../src/price');

describe('formatPrice', () => {
  test('formats cents with two decimals', () => {
    expect(formatPrice(1250)).toBe('12.50');
  });
});
