// The deployed commit shown on /healthz comes from GIT_SHA or src/commit.txt; a bad value must
// never turn into a link to a tree that doesn't exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function load(sha, tag = '') {
  if (sha === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = sha;
  return import(`../src/version.js?sha=${encodeURIComponent(String(sha))}${tag}`);
}

test('a hex SHA is kept, lower-cased, and the source links to that tree', async () => {
  const v = await load(' ABCDEF1234567 ');
  assert.equal(v.COMMIT, 'abcdef1234567');
  assert.equal(v.SOURCE_URL, `${v.REPO_URL}/tree/abcdef1234567`);
});

test('unset or malformed: no commit, the source is the repo itself', async () => {
  for (const bad of [undefined, '', 'main', 'abc', 'g'.repeat(40), 'a'.repeat(41), '../x']) {
    const v = await load(bad);
    assert.equal(v.COMMIT, null, String(bad));
    assert.equal(v.SOURCE_URL, v.REPO_URL);
  }
});

test('without GIT_SHA, the commit the build wrote to src/commit.txt is used', async () => {
  const { writeFileSync, rmSync } = await import('node:fs');
  const file = new URL('../src/commit.txt', import.meta.url);
  writeFileSync(file, 'ABCDEF1234567\n');
  try {
    const v = await load(undefined, '&file');
    assert.equal(v.COMMIT, 'abcdef1234567');
  } finally {
    rmSync(file, { force: true });
  }
});
