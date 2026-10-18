import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { truncate } from '../src/truncate.js';

describe('truncate', () => {
  it('keeps short text', () => {
    assert.equal(truncate('hello', 10), 'hello');
  });
  it('cuts long text and adds an ellipsis', () => {
    assert.equal(truncate('hello world', 6), 'hello…');
  });
});
