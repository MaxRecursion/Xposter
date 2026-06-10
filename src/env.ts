import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from repo root regardless of working directory (fixes worktree starts).
//
// This lives in its own module so it can be the FIRST import of the entrypoint.
// ESM hoists and evaluates every static import before any module body runs, so
// calling dotenvConfig() inside index.ts would happen only after modules like
// storage/db.ts have already read process.env at their top level.
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '../.env') });
