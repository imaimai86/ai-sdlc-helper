/* eslint-disable */
const { applyDiscount } = require('../src/discount');

describe('applyDiscount', () => {
  test('takes ten percent off', () => {
    expect(applyDiscount(1000, 10)).toBe(900);
  });
  test('rounds a half cent up', () => {
    expect(applyDiscount(999, 50)).toBe(500);
  });
  test('accepts 0 and 100 percent', () => {
    expect(applyDiscount(1000, 0)).toBe(1000);
    expect(applyDiscount(1000, 100)).toBe(0);
  });
  test('rejects a percent outside 0 to 100', () => {
    expect(() => applyDiscount(1000, 101)).toThrow(RangeError);
    expect(() => applyDiscount(1000, -1)).toThrow(RangeError);
  });
});
