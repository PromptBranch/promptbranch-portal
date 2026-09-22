-- P9: owner-authorized NDJSON exports (materialized snapshot rows like the
-- C7 bootstrap) and the recovery provenance log. Workspace purge and audit
-- retention reuse existing columns (team_workspaces.purge_after, audit ages).

CREATE TABLE team_exports (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES team_workspaces(id),
    principal_user_id uuid NOT NULL REFERENCES team_users(id),
    high_water      bigint NOT NULL CHECK (high_water >= 0),
    manifest_json   jsonb NOT NULL,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX team_exports_expiry_idx ON team_exports (expires_at);

CREATE TABLE team_export_rows (
    export_id   uuid NOT NULL REFERENCES team_exports(id) ON DELETE CASCADE,
    ordinal     bigint NOT NULL CHECK (ordinal >= 0),
    record_json jsonb NOT NULL,
    PRIMARY KEY (export_id, ordinal)
);

-- Restore provenance (plan P9): every recovery window is recorded, and the
-- roster reconciliation that closes it is attributable.
CREATE TABLE team_recovery_log (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    restored_from text NOT NULL,
    note         text NOT NULL DEFAULT ''
);
