import { sqlite } from '@flue/runtime/node';

// Docker sets FLUE_DB_PATH=/data/flue.db; local dev falls back to the
// gitignored .volumes directory at the repository root.
export default sqlite(
  process.env.FLUE_DB_PATH?.trim() || '../../.volumes/agent/flue.db',
);
