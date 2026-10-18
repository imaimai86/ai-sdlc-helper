# Spec: add-kelvin

`toKelvin(celsius)` in `src/temperature.mjs` returns `celsius + 273.15`. Below -273.15 it throws a RangeError.

## Acceptance criteria
- `toKelvin(0)` is 273.15.
- `toKelvin(-273.15)` is 0.
- `toKelvin(-300)` throws a RangeError.
