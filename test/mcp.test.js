// What the assistant reads before it calls anything: the server's
// instructions. They sit in the context of every conversation the user has
// with ohmigo connected, and some clients cut them (see INSTRUCTIONS_MAX in
// src/mcp.js), so they have a budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTIONS, INSTRUCTIONS_MAX, QA_NOTE } from '../src/mcp.js';

test('mcp: the instructions, QA note included, fit before the clients that cut them do', () => {
  const n = INSTRUCTIONS.length + QA_NOTE.length;
  assert.ok(n <= INSTRUCTIONS_MAX, `${n} > ${INSTRUCTIONS_MAX} characters: move what one tool needs to its description, and what one result needs to the result`);
});
