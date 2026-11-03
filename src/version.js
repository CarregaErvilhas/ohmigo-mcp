// The server's version, from package.json only: bump it there (npm version).
import { createRequire } from 'node:module';

export const VERSION = createRequire(import.meta.url)('../package.json').version;

// AGPL section 13: the repository is the Corresponding Source of what runs here.
export const REPO_URL = 'https://github.com/CarregaErvilhas/ohmigo-mcp';

// The git commit this build came from, set at deploy time (GIT_SHA, see
// docs/06-run-and-deploy.md). Anything that isn't a hex SHA is dropped, so
// /healthz never links to a tree that can't exist; unset means "not known".
const sha = (process.env.GIT_SHA || '').trim().toLowerCase();
export const COMMIT = /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
export const SOURCE_URL = COMMIT ? `${REPO_URL}/tree/${COMMIT}` : REPO_URL;
