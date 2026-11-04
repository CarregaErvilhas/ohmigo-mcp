// What the assistant reads before it calls anything: the server's
// instructions. They sit in the context of every conversation the user has
// with ohmigo connected, and some clients cut them (test/budget.test.js
// holds them to a budget).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTIONS } from '../src/mcp.js';

test('the instructions point to the source, as AGPL section 13 asks', async () => {
  const { REPO_URL } = await import('../src/version.js');
  assert.ok(INSTRUCTIONS.includes(REPO_URL));
});
