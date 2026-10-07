// Undo one tmdb_identity_changes row (assign or merge): node scripts/tmdb-identity-undo.mjs <changeId>
// Writes to the database it is pointed at; the caller must invalidate the printed slugs afterwards.
import { pool } from '../src/db.js';
import { undoTmdbIdentity } from '../src/tmdbIdentity.js';

const id = Number(process.argv[2]);
if (!Number.isInteger(id) || id <= 0) {
  console.error('usage: node scripts/tmdb-identity-undo.mjs <changeId>');
  process.exit(2);
}
try {
  console.log(JSON.stringify(await undoTmdbIdentity(id)));
} finally {
  await pool.end();
}
