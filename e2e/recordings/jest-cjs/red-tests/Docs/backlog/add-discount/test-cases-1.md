# Test cases: add-discount

| Case | Input | Expected |
|---|---|---|
| ten percent | 1000, 10 | 900 |
| half rounds up | 999, 50 | 500 |
| bounds | 1000, 0 / 1000, 100 | 1000 / 0 |
| out of range | 1000, 101 / 1000, -1 | RangeError |
