-- 001-team-foundation.sql
-- Team workspaces foundation: verified accounts, provider identity sessions,
-- web (BFF) sessions, workspaces, memberships and invitations.
--
-- Forward-only: never edit an applied migration; add a new one instead. UUID
-- primary keys are generated server-side; every workspace-owned table carries
-- workspace_id NOT NULL and cross-table relationships are composite FKs that
-- include workspace_id, so an object belonging to another workspace is
-- rejected by the database even if an application check is missing.

-- Accounts are identified by (issuer, subject) from the OIDC provider; the
-- verified email is contact metadata, never the account identity (accounts
-- are not auto-linked by matching email).
CREATE TABLE team_users (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer           text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
    subject          text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
    verified_email   text NOT NULL,
    normalized_email text NOT NULL,
    display_name     text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
    disabled_at      timestamptz,
    deleted_at       timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX team_users_issuer_subject_uq ON team_users (issuer, subject);
CREATE INDEX team_users_normalized_email_idx ON team_users (normalized_email);

-- Provider identity sessions, keyed by validated (issuer, sid, client, user).
-- Revoked rows are retained forever so a revoked key can never re-register
-- automatically; a fresh IdP login must produce a new sid.
CREATE TABLE team_sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES team_users(id),
    issuer       text NOT NULL,
    sid          text NOT NULL,
    client_id    text NOT NULL,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer, sid, client_id, user_id)
);

CREATE INDEX team_sessions_user_idx ON team_sessions (user_id);
CREATE INDEX team_sessions_last_seen_idx ON team_sessions (last_seen_at);

-- Browser (BFF) sessions: only an opaque cookie token hash is stored, never
-- the raw cookie; the provider refresh token is stored encrypted with its
-- AES-GCM nonce and operator key id kept separately.
CREATE TABLE team_web_sessions (
    token_hash        bytea PRIMARY KEY,
    app_session_id    uuid NOT NULL REFERENCES team_sessions(id),
    encrypted_refresh bytea NOT NULL,
    refresh_nonce     bytea NOT NULL,
    refresh_key_id    text NOT NULL,
    csrf_hash         bytea NOT NULL,
    expires_at        timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    last_seen_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX team_web_sessions_app_session_idx ON team_web_sessions (app_session_id);
CREATE INDEX team_web_sessions_expiry_idx ON team_web_sessions (expires_at);

-- The workspace row itself is the serialization lock for every workspace
-- write (selected FOR UPDATE first in every mutation transaction).
CREATE TABLE team_workspaces (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    entity_version   integer NOT NULL DEFAULT 1 CHECK (entity_version > 0),
    next_catalog_seq bigint NOT NULL DEFAULT 1 CHECK (next_catalog_seq > 0),
    server_epoch     uuid NOT NULL,
    deleted_at       timestamptz,
    purge_after      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX team_workspaces_purge_idx ON team_workspaces (purge_after)
    WHERE deleted_at IS NOT NULL;

-- Roles come from Postgres, never from identity-provider claims or client
-- input. removed_at retains the row so re-adds rotate the generation and old
-- queued commands cannot silently regain permission.
CREATE TABLE team_memberships (
    workspace_id   uuid NOT NULL REFERENCES team_workspaces(id),
    user_id        uuid NOT NULL REFERENCES team_users(id),
    role           text NOT NULL CHECK (role IN ('owner', 'maintainer', 'contributor', 'viewer')),
    generation     uuid NOT NULL,
    entity_version integer NOT NULL DEFAULT 1 CHECK (entity_version > 0),
    removed_at     timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX team_memberships_user_active_idx ON team_memberships (user_id)
    WHERE removed_at IS NULL;
CREATE INDEX team_memberships_workspace_active_idx ON team_memberships (workspace_id)
    WHERE removed_at IS NULL;

-- Invitations: single-use 256-bit tokens stored hashed only, bound to the
-- invited normalized verified email. Owner role is never grantable by
-- invitation; ownership transfer is an explicit owner action.
CREATE TABLE team_invitations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES team_workspaces(id),
    email        text NOT NULL,
    role         text NOT NULL CHECK (role IN ('maintainer', 'contributor', 'viewer')),
    token_hash   bytea NOT NULL UNIQUE,
    created_by   uuid NOT NULL REFERENCES team_users(id),
    expires_at   timestamptz NOT NULL,
    accepted_by  uuid REFERENCES team_users(id),
    accepted_at  timestamptz,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (accepted_at IS NULL OR accepted_by IS NOT NULL),
    CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX team_invitations_workspace_idx ON team_invitations (workspace_id, created_at DESC);
CREATE INDEX team_invitations_email_idx ON team_invitations (email);
