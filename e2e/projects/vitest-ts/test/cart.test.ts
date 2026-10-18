import { describe, expect, it } from 'vitest';
import { cartTotal } from '../src/cart.js';

describe('cartTotal', () => {
  it('adds quantity times unit price', () => {
    expect(cartTotal([{ sku: 'a', quantity: 2, unitCents: 150 }, { sku: 'b', quantity: 1, unitCents: 99 }])).toBe(399);
  });
});
