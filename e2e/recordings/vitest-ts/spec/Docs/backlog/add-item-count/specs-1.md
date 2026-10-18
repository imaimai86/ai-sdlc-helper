# Spec: add-item-count

`itemCount(lines)` in `src/count.ts` returns the sum of the `quantity` of every line (the `Line` type of
`src/cart.ts`). An empty cart returns 0.

## Acceptance criteria
- `itemCount([])` is 0.
- Two lines with quantities 2 and 3 give 5.
