-- Allow the one-off image-heal walk to keep its position in crawl_checkpoints
-- (provider='nguonc', lane='image-heal') alongside the existing 'backfill' lane.
ALTER TABLE crawl_checkpoints DROP CONSTRAINT IF EXISTS crawl_checkpoints_lane_check;
ALTER TABLE crawl_checkpoints
  ADD CONSTRAINT crawl_checkpoints_lane_check CHECK (lane IN ('backfill', 'image-heal'));
