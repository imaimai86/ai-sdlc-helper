import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toKelvin } from '../src/temperature.mjs';

test('toKelvin converts 0 C to 273.15 K', () => {
  assert.equal(toKelvin(0), 273.15);
});
test('toKelvin converts absolute zero to 0 K', () => {
  assert.equal(toKelvin(-273.15), 0);
});
test('toKelvin rejects a temperature below absolute zero', () => {
  assert.throws(() => toKelvin(-300), RangeError);
});
