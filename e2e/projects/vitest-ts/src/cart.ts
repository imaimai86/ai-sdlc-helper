export interface Line {
  sku: string;
  quantity: number;
  unitCents: number;
}

/** The cart total in cents. */
export function cartTotal(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.quantity * l.unitCents, 0);
}
