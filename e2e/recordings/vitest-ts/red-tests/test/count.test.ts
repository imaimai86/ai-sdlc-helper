import { describe, expect, it } from 'vitest';
import { itemCount } from '../src/count.js';

describe('itemCount', () => {
  it('is 0 for an empty cart', () => {
    expect(itemCount([])).toBe(0);
  });
  it('adds the quantities', () => {
    expect(itemCount([{ sku: 'a', quantity: 2, unitCents: 1 }, { sku: 'b', quantity: 3, unitCents: 1 }])).toBe(5);
  });
});
