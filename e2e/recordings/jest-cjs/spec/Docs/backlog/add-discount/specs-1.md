# Spec: add-discount

## Behaviour
`applyDiscount(cents, percent)` in `src/discount.js` returns the price in whole cents after a `percent` discount,
rounded to the nearest cent (halves round up).

## Errors
A `percent` below 0 or above 100 throws a `RangeError`.

## Acceptance criteria
- `applyDiscount(1000, 10)` is 900.
- `applyDiscount(999, 50)` is 500 (499.5 rounds up).
- `applyDiscount(1000, 0)` is 1000 and `applyDiscount(1000, 100)` is 0.
- `applyDiscount(1000, 101)` and `applyDiscount(1000, -1)` throw a RangeError.
