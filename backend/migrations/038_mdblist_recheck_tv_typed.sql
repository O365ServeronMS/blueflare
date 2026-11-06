-- Rows typed movie but identified by TMDB as tv were looked up under the wrong MDBList type
-- (lookupIdentity now uses tmdb_media_type). Make them due again; keep the stored scores so the
-- next check compares old with new through changedScore and invalidates caches. Data only.
UPDATE movies SET mdblist_checked_at = NULL
WHERE tmdb_id > 0 AND tmdb_media_type = 'tv' AND media_type = 'movie';
