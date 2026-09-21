-- 003-team-sync-operations.sql
-- Change feed, catalogue bootstraps, command receipts, audit log, job outbox
-- and shared rate buckets.

-- Per-workspace catalogue change feed. Sequences are allocated from the
-- workspace row (next_catalog_seq) while holding its lock, so commit order
-- and sequence order can never disagree; this table is the ordered feed.
CREATE TABLE team_changes (
    workspace_id uuid NOT NULL REFERENCES team_workspaces(id),
    seq          bigint NOT NULL CHECK (seq > 0),
    payload_json jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, seq)
);

-- Retention is 30 days; the service keeps the minimum retained cursor
-- transactionally consistent while pruning (never a visible gap).
CREATE INDEX team_changes_age_idx ON team_changes (created_at);

-- Materialized catalogue snapshots for bootstrap. Bound to the requesting
-- principal, workspace, membership generation and server epoch; the service
-- enforces one ACTIVE bootstrap per principal/workspace and 10-minute expiry.
CREATE TABLE team_bootstraps (
    snapshot_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id          uuid NOT NULL REFERENCES team_workspaces(id),
    principal_key         text NOT NULL,
    principal_user_id     uuid NOT NULL REFERENCES team_users(id),
    membership_generation uuid NOT NULL,
    server_epoch          uuid NOT NULL,
    high_water            bigint NOT NULL CHECK (high_water >= 0),
    expires_at            timestamptz NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    -- Reuse identity per contract C7: same principal/workspace/generation/
    -- epoch reuses a still-valid snapshot (200) instead of materializing again.
    UNIQUE (workspace_id, principal_key, membership_generation, server_epoch)
);

CREATE INDEX team_bootstraps_expiry_idx ON team_bootstraps (expires_at);

-- Snapshot rows are materialized server-side with SQL INSERT ... SELECT and
-- streamed by ordinal; never one unbounded JSON array in app memory.
CREATE TABLE team_bootstrap_rows (
    snapshot_id uuid NOT NULL REFERENCES team_bootstraps(snapshot_id) ON DELETE CASCADE,
    ordinal     bigint NOT NULL CHECK (ordinal >= 0),
    record_json jsonb NOT NULL,
    PRIMARY KEY (snapshot_id, ordinal)
);

-- Domain command receipts (contract C6). principal_id is server-authored
-- ("human:<userId>" | "agent:<tokenId>") and distinguishes an agent token
-- from its owner. request_hash is the canonical JSON hash of the complete
-- command envelope including membership generation.
CREATE TABLE team_command_receipts (
    workspace_id uuid NOT NULL REFERENCES team_workspaces(id),
    principal_id text NOT NULL,
    command_id   uuid NOT NULL,
    request_hash bytea NOT NULL,
    result_json  jsonb NOT NULL,
    committed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, principal_id, command_id)
);

-- User-scoped receipts for workspace creation and invitation acceptance
-- (mutations that do not yet have a workspace context of their own).
CREATE TABLE team_user_receipts (
    user_id      uuid NOT NULL REFERENCES team_users(id),
    command_id   uuid NOT NULL,
    request_hash bytea NOT NULL,
    result_json  jsonb NOT NULL,
    committed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, command_id)
);

-- Metadata-only, append-only audit trail. No prompt content, no secrets, no
-- raw tokens: actors are referenced by ID and display resolves live from
-- team_users (so account deletion anonymizes everywhere at once).
CREATE TABLE team_audit (
    workspace_id        uuid NOT NULL REFERENCES team_workspaces(id),
    id                  uuid NOT NULL DEFAULT gen_random_uuid(),
    actor_user_id       uuid,
    actor_agent_token_id uuid,
    action              text NOT NULL,
    resource_type       text NOT NULL,
    resource_id         text NOT NULL,
    metadata_json       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id)
);

CREATE OR REPLACE FUNCTION team_audit_append_only_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'team_audit is append-only' USING ERRCODE = 'PBT03';
END;
$$;

CREATE TRIGGER team_audit_append_only
    BEFORE UPDATE ON team_audit
    FOR EACH ROW EXECUTE FUNCTION team_audit_append_only_trigger();

CREATE INDEX team_audit_time_idx ON team_audit (workspace_id, created_at DESC, id);

-- Transactional job outbox (invitation email first). Invitation raw tokens
-- are encrypted at rest only until the email job completes; successful
-- delivery clears the encrypted payload.
CREATE TABLE team_jobs (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     uuid REFERENCES team_workspaces(id),
    type             text NOT NULL CHECK (type IN (
                         'invitation.email',
                         'workspace.purge',
                         'audit.purge',
                         'bootstrap.expire',
                         'changes.expire',
                         'maintenance'
                     )),
    payload_encrypted bytea,
    payload_nonce    bytea,
    payload_key_id   text,
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
    attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    run_after        timestamptz NOT NULL DEFAULT now(),
    locked_until     timestamptz,
    last_error_code  text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX team_jobs_due_idx ON team_jobs (status, run_after);

-- Shared rate-limit counters (contract C8): atomic limits across app
-- instances; anonymous snapshot limits stay in the portal's separate store.
CREATE TABLE team_rate_buckets (
    bucket_key   text NOT NULL,
    window_start timestamptz NOT NULL,
    count        integer NOT NULL DEFAULT 0 CHECK (count >= 0),
    expires_at   timestamptz NOT NULL,
    PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX team_rate_buckets_expiry_idx ON team_rate_buckets (expires_at);
