import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFahrenheit } from '../src/temperature.mjs';

test('toFahrenheit converts 100 C to 212 F', () => {
  assert.equal(toFahrenheit(100), 212);
});
