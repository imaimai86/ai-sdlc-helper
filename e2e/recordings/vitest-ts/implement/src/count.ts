import type { Line } from './cart.js';

/** The number of items in the cart: the sum of the quantities. */
export function itemCount(lines: Line[]): number {
  return lines.reduce((n, l) => n + l.quantity, 0);
}
