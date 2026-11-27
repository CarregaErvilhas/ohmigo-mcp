// The server's version, from package.json only: bump it there (npm version).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export const VERSION = createRequire(import.meta.url)('../package.json').version;

// AGPL section 13: the repository is the Corresponding Source of what runs here.
export const REPO_URL = 'https://github.com/CarregaErvilhas/ohmigo-mcp';

// The git commit this build came from: GIT_SHA, else src/commit.txt, which
// the Zerops build writes (docs/06-run-and-deploy.md). Anything that isn't a
// hex SHA is dropped, so /healthz never links to a tree that can't exist;
// neither set means "not known".
function buildCommit() {
  try { return readFileSync(new URL('./commit.txt', import.meta.url), 'utf8'); } catch { return ''; }
}
const sha = (process.env.GIT_SHA || buildCommit()).trim().toLowerCase();
export const COMMIT = /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
export const SOURCE_URL = COMMIT ? `${REPO_URL}/tree/${COMMIT}` : REPO_URL;
