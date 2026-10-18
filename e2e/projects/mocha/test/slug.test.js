import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { slugify } from '../src/slug.js';

describe('slugify', () => {
  it('lowercases and joins words with dashes', () => {
    assert.equal(slugify('Hello, World!'), 'hello-world');
  });
});
