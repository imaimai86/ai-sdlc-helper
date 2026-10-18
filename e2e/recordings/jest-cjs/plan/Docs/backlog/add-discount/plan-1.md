# Plan: add-discount

1. New module `src/discount.js` (CommonJS, like `src/price.js`) exporting `applyDiscount`.
2. Validate `percent` first (RangeError outside 0..100), then `Math.round(cents * (100 - percent) / 100)`.
3. Tests in `__tests__/discount.test.js`.
