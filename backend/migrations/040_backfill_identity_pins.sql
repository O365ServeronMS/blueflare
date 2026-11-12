-- Backfill tmdb_identity_pinned (039) for identities settled before the column existed: every row
-- the catalog audit wrote (reason catalog-audit:*, or evidence pass catalog-audit) and every row an
-- undo touched (the undone change's row, and the restored rows logged with reason 'undone').
-- Without it the provider pass could rewrite identities a person or the audit already settled.
-- Idempotent; rows deleted since (merged away) simply do not match.
UPDATE movies SET tmdb_identity_pinned = true
WHERE tmdb_identity_pinned IS NOT TRUE
  AND id IN (
    SELECT movie_id FROM tmdb_identity_changes
    WHERE reason LIKE 'catalog-audit:%'
       OR evidence->>'pass' = 'catalog-audit'
       OR reason = 'undone'
       OR undone_at IS NOT NULL
  );
