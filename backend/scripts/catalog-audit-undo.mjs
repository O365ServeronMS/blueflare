// Undo one applied catalog_audit_actions row: node scripts/catalog-audit-undo.mjs <actionId>
// Writes to the database it is pointed at; the caller must invalidate the printed slugs afterwards.
import { pool } from '../src/db.js';
import { undoAuditAction } from '../src/catalogAuditApply.js';

const id = Number(process.argv[2]);
if (!Number.isInteger(id) || id <= 0) {
  console.error('usage: node scripts/catalog-audit-undo.mjs <actionId>');
  process.exit(2);
}
try {
  console.log(JSON.stringify(await undoAuditAction(id)));
} finally {
  await pool.end();
}
