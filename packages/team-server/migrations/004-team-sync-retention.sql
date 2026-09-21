-- 004-team-sync-retention.sql
-- Change-feed retention floor. The workspace row tracks the lowest feed
-- sequence a client may still resume from; pruning advances it only after
-- the corresponding rows are gone, so a sweep can never manufacture an
-- apparent gap between the retained floor and surviving events.

ALTER TABLE team_workspaces
    ADD COLUMN min_retained_seq bigint NOT NULL DEFAULT 0
    CHECK (min_retained_seq >= 0 AND min_retained_seq <= next_catalog_seq);
