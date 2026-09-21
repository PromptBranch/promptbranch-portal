-- 002-team-content.sql
-- Approved library: tags, collections, agent tokens, prompts, immutable
-- revisions, publications, proposals, reviews, junction tables, comments,
-- activity items and the published search projection.
--
-- Isolation invariant: every cross-table relationship is a composite FK that
-- includes workspace_id, so cross-workspace references are rejected by the
-- database itself (e.g. a valid revision ID from workspace A can never back a
-- proposal in workspace B).

CREATE TABLE team_tags (
    workspace_id    uuid NOT NULL REFERENCES team_workspaces(id),
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 50),
    normalized_name text NOT NULL,
    entity_version  integer NOT NULL DEFAULT 1 CHECK (entity_version > 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    -- Trimmed case-insensitive uniqueness per workspace; display case preserved.
    UNIQUE (workspace_id, normalized_name)
);

CREATE TABLE team_collections (
    workspace_id    uuid NOT NULL REFERENCES team_workspaces(id),
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    normalized_name text NOT NULL,
    entity_version  integer NOT NULL DEFAULT 1 CHECK (entity_version > 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    UNIQUE (workspace_id, normalized_name)
);

-- Scoped agent capabilities owned by a member (never an independent role).
-- Only the secret hash is stored; the raw secret is shown exactly once.
CREATE TABLE team_agent_tokens (
    workspace_id         uuid NOT NULL REFERENCES team_workspaces(id),
    id                   uuid NOT NULL DEFAULT gen_random_uuid(),
    owner_user_id        uuid NOT NULL REFERENCES team_users(id),
    name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    secret_hash          bytea NOT NULL UNIQUE,
    scopes               text[] NOT NULL DEFAULT ARRAY['catalog:read']::text[],
    membership_generation uuid NOT NULL,
    expires_at           timestamptz NOT NULL,
    revoked_at           timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    -- Every token carries catalog:read (contract C1); nothing outside the
    -- supported scope set is accepted.
    CHECK ('catalog:read' = ANY (scopes)),
    CHECK (scopes <@ ARRAY['catalog:read', 'proposal:write', 'note:write', 'run:write']::text[]),
    -- Authorship columns elsewhere reference the token by id alone; the uuid
    -- is workspace-independent by generation and unique here by declaration.
    UNIQUE (id)
);

CREATE INDEX team_agent_tokens_owner_active_idx ON team_agent_tokens (workspace_id, owner_user_id)
    WHERE revoked_at IS NULL;
CREATE INDEX team_agent_tokens_expiry_idx ON team_agent_tokens (expires_at);

CREATE TABLE team_prompts (
    workspace_id        uuid NOT NULL REFERENCES team_workspaces(id),
    id                  uuid NOT NULL DEFAULT gen_random_uuid(),
    title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description         text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
    approved_revision_id uuid,
    entity_version      integer NOT NULL DEFAULT 1 CHECK (entity_version > 0),
    archived_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id)
);

CREATE INDEX team_prompts_listing_idx ON team_prompts (workspace_id, title, id)
    WHERE archived_at IS NULL;

-- Immutable revision rows: content/hash/parent/author/prompt never change
-- after insert; a BEFORE UPDATE trigger rejects any attempt (see below).
-- display name is NOT denormalized here — author presentation resolves from
-- team_users at read time (accounts anonymize in one place).
CREATE TABLE team_revisions (
    workspace_id       uuid NOT NULL REFERENCES team_workspaces(id),
    id                 uuid NOT NULL DEFAULT gen_random_uuid(),
    prompt_id          uuid NOT NULL,
    parent_revision_id uuid,
    content            text NOT NULL,
    content_format     text NOT NULL DEFAULT 'markdown' CHECK (content_format = 'markdown'),
    content_hash       text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    change_note        text NOT NULL DEFAULT '' CHECK (length(change_note) <= 8000),
    author_user_id     uuid REFERENCES team_users(id),
    author_agent_id    uuid REFERENCES team_agent_tokens(id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    -- Exactly one author identity: the human member or their agent token.
    CHECK ((author_user_id IS NULL) <> (author_agent_id IS NULL)),
    -- Required unique key for composite (workspace, prompt, revision) references.
    UNIQUE (workspace_id, prompt_id, id),
    -- A revision's parent must be a revision of the same prompt in the same
    -- workspace (self-referencing composite FK).
    FOREIGN KEY (workspace_id, prompt_id, parent_revision_id)
        REFERENCES team_revisions(workspace_id, prompt_id, id),
    FOREIGN KEY (workspace_id, prompt_id) REFERENCES team_prompts(workspace_id, id)
);

CREATE INDEX team_revisions_prompt_idx ON team_revisions (workspace_id, prompt_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION team_revisions_immutable_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
        OR NEW.prompt_id IS DISTINCT FROM OLD.prompt_id
        OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id
        OR NEW.content IS DISTINCT FROM OLD.content
        OR NEW.content_format IS DISTINCT FROM OLD.content_format
        OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
        OR NEW.change_note IS DISTINCT FROM OLD.change_note
        OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
        OR NEW.author_agent_id IS DISTINCT FROM OLD.author_agent_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'team_revisions rows are immutable'
            USING ERRCODE = 'PBT01';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER team_revisions_immutable
    BEFORE UPDATE ON team_revisions
    FOR EACH ROW EXECUTE FUNCTION team_revisions_immutable_trigger();

-- Approved head pointer closes the prompt <-> revision cycle. Deferrable
-- initially deferred so a seed transaction can insert prompt + first approved
-- revision without any observable unapproved head.
ALTER TABLE team_prompts
    ADD CONSTRAINT team_prompts_approved_revision_fk
    FOREIGN KEY (workspace_id, approved_revision_id)
    REFERENCES team_revisions(workspace_id, id)
    DEFERRABLE INITIALLY DEFERRED;

-- Catalogue membership: only revisions with a publication row enter
-- catalogue APIs, search, bootstrap and the change feed.
CREATE TABLE team_publications (
    workspace_id uuid NOT NULL,
    revision_id  uuid NOT NULL,
    prompt_id    uuid NOT NULL,
    source       text NOT NULL CHECK (source IN ('seed', 'review')),
    review_id    uuid,
    published_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, revision_id),
    FOREIGN KEY (workspace_id, prompt_id) REFERENCES team_prompts(workspace_id, id),
    FOREIGN KEY (workspace_id, prompt_id, revision_id)
        REFERENCES team_revisions(workspace_id, prompt_id, id)
);

CREATE INDEX team_publications_prompt_idx ON team_publications (workspace_id, prompt_id, published_at DESC);

CREATE TABLE team_proposals (
    workspace_id          uuid NOT NULL REFERENCES team_workspaces(id),
    id                    uuid NOT NULL DEFAULT gen_random_uuid(),
    prompt_id             uuid NOT NULL,
    base_revision_id      uuid NOT NULL,
    candidate_revision_id uuid NOT NULL,
    author_user_id        uuid REFERENCES team_users(id),
    author_agent_id       uuid REFERENCES team_agent_tokens(id),
    rationale             text NOT NULL
        CHECK (length(btrim(rationale)) > 0 AND length(rationale) <= 8000),
    status                text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'approved', 'rejected', 'withdrawn', 'superseded')),
    supersedes_id         uuid,
    entity_version        integer NOT NULL DEFAULT 1 CHECK (entity_version > 0),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CHECK ((author_user_id IS NULL) <> (author_agent_id IS NULL)),
    -- The candidate is workspaces-unique: rebasing always creates a NEW
    -- immutable revision, so one revision backs at most one proposal.
    UNIQUE (workspace_id, candidate_revision_id),
    FOREIGN KEY (workspace_id, prompt_id) REFERENCES team_prompts(workspace_id, id),
    FOREIGN KEY (workspace_id, prompt_id, base_revision_id)
        REFERENCES team_revisions(workspace_id, prompt_id, id),
    FOREIGN KEY (workspace_id, prompt_id, candidate_revision_id)
        REFERENCES team_revisions(workspace_id, prompt_id, id),
    FOREIGN KEY (workspace_id, supersedes_id)
        REFERENCES team_proposals(workspace_id, id)
);

CREATE INDEX team_proposals_workspace_status_idx ON team_proposals (workspace_id, status, updated_at DESC);
CREATE INDEX team_proposals_author_idx ON team_proposals (workspace_id, author_user_id, author_agent_id);

CREATE TABLE team_reviews (
    workspace_id          uuid NOT NULL,
    id                    uuid NOT NULL DEFAULT gen_random_uuid(),
    proposal_id           uuid NOT NULL,
    candidate_revision_id uuid NOT NULL,
    candidate_hash        text NOT NULL CHECK (candidate_hash ~ '^[0-9a-f]{64}$'),
    reviewer_user_id      uuid NOT NULL REFERENCES team_users(id),
    decision              text NOT NULL CHECK (decision IN ('approve', 'reject')),
    comment               text NOT NULL DEFAULT '' CHECK (length(comment) <= 8000),
    created_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    -- Terminal decision is unique: approval/rejection closes the proposal
    -- forever; a rebase produces a new proposal instead.
    UNIQUE (workspace_id, proposal_id),
    -- The review must bind exactly the proposal's immutable candidate.
    FOREIGN KEY (workspace_id, candidate_revision_id)
        REFERENCES team_proposals(workspace_id, candidate_revision_id)
);

CREATE INDEX team_reviews_reviewer_idx ON team_reviews (workspace_id, reviewer_user_id, created_at DESC);

-- Publication provenance for review-sourced publications.
ALTER TABLE team_publications
    ADD CONSTRAINT team_publications_review_fk
    FOREIGN KEY (workspace_id, review_id) REFERENCES team_reviews(workspace_id, id);

CREATE TABLE team_prompt_tags (
    workspace_id uuid NOT NULL,
    prompt_id    uuid NOT NULL,
    tag_id       uuid NOT NULL,
    PRIMARY KEY (workspace_id, prompt_id, tag_id),
    FOREIGN KEY (workspace_id, prompt_id) REFERENCES team_prompts(workspace_id, id),
    FOREIGN KEY (workspace_id, tag_id) REFERENCES team_tags(workspace_id, id)
);

CREATE INDEX team_prompt_tags_tag_idx ON team_prompt_tags (workspace_id, tag_id);

CREATE TABLE team_collection_prompts (
    workspace_id  uuid NOT NULL,
    collection_id uuid NOT NULL,
    prompt_id     uuid NOT NULL,
    PRIMARY KEY (workspace_id, collection_id, prompt_id),
    FOREIGN KEY (workspace_id, collection_id) REFERENCES team_collections(workspace_id, id),
    FOREIGN KEY (workspace_id, prompt_id) REFERENCES team_prompts(workspace_id, id)
);

CREATE INDEX team_collection_prompts_prompt_idx ON team_collection_prompts (workspace_id, prompt_id);

CREATE TABLE team_comments (
    workspace_id    uuid NOT NULL,
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    proposal_id     uuid NOT NULL,
    author_user_id  uuid REFERENCES team_users(id),
    author_agent_id uuid REFERENCES team_agent_tokens(id),
    body            text NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 8000),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CHECK ((author_user_id IS NULL) <> (author_agent_id IS NULL)),
    FOREIGN KEY (workspace_id, proposal_id) REFERENCES team_proposals(workspace_id, id)
);

CREATE OR REPLACE FUNCTION team_comments_append_only_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'team_comments is append-only' USING ERRCODE = 'PBT02';
END;
$$;

CREATE TRIGGER team_comments_append_only
    BEFORE UPDATE OR DELETE ON team_comments
    FOR EACH ROW EXECUTE FUNCTION team_comments_append_only_trigger();

CREATE INDEX team_comments_proposal_idx ON team_comments (workspace_id, proposal_id, created_at DESC);

-- Notes and sanitized run summaries. Bound to an already-PUBLISHED revision
-- via the publications FK; run metrics live in run_json (finite nonnegative
-- values validated by the service before insert — never raw provider output).
CREATE TABLE team_activity_items (
    workspace_id    uuid NOT NULL,
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    prompt_id       uuid NOT NULL,
    revision_id     uuid NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('note', 'run')),
    body            text NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 8000),
    run_json        jsonb,
    author_user_id  uuid REFERENCES team_users(id),
    author_agent_id uuid REFERENCES team_agent_tokens(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CHECK ((author_user_id IS NULL) <> (author_agent_id IS NULL)),
    CHECK (kind <> 'run' OR run_json IS NOT NULL),
    CHECK (kind <> 'note' OR run_json IS NULL),
    FOREIGN KEY (workspace_id, prompt_id) REFERENCES team_prompts(workspace_id, id),
    -- Same-prompt invariant for the referenced revision.
    FOREIGN KEY (workspace_id, prompt_id, revision_id)
        REFERENCES team_revisions(workspace_id, prompt_id, id),
    -- Already-published only: activity attaches to the approved catalogue.
    FOREIGN KEY (workspace_id, revision_id) REFERENCES team_publications(workspace_id, revision_id)
);

CREATE INDEX team_activity_items_prompt_idx ON team_activity_items (workspace_id, prompt_id, created_at DESC);
CREATE INDEX team_activity_items_author_idx ON team_activity_items (workspace_id, author_user_id, author_agent_id);

-- Published search projection: workspace-scoped tsvector built from prompt
-- metadata plus the current approved revision only, weighted title/tags
-- first. Maintained in the same transaction as mutations; candidate (never
-- approved) text never enters this table.
CREATE TABLE team_prompt_search (
    workspace_id uuid NOT NULL,
    prompt_id    uuid NOT NULL,
    tsv          tsvector NOT NULL,
    PRIMARY KEY (workspace_id, prompt_id),
    FOREIGN KEY (workspace_id, prompt_id) REFERENCES team_prompts(workspace_id, id)
);

CREATE INDEX team_prompt_search_tsv_idx ON team_prompt_search USING gin (tsv);
