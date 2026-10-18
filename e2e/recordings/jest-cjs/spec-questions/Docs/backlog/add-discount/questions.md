# Questions for add-discount

### Q1: Rounding
The brief says "rounded to the nearest cent" but not how halves round. 499.5 cents could become 499 or 500.
**Suggested:** Halves round up (Math.round).
**Answer:**

### Q2: Invalid percent
The brief says a percent outside 0 to 100 is an error, but not which error.
**Suggested:** Throw a RangeError.
**Answer:**
