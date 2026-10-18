# Test cases: add-kelvin

| Case | Input | Expected |
|---|---|---|
| freezing | 0 | 273.15 |
| absolute zero | -273.15 | 0 |
| below absolute zero | -300 | RangeError |
