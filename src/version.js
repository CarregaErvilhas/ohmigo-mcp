// The server's version, from package.json only: bump it there (npm version).
import { createRequire } from 'node:module';

export const VERSION = createRequire(import.meta.url)('../package.json').version;
