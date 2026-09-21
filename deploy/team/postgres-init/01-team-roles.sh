#!/bin/bash
# Runs once on first initdb (docker-entrypoint-initdb.d) as the postgres
# superuser. Creates the separate dev-only roles/databases for the team stack:
# team data lives in `team` (roles team_migrate/team_app/team_admin), the
# identity provider has its own `keycloak` database and role.
#
# All credentials arrive from deploy/team/.env via compose environment. They
# are SYNTHETIC local development credentials only (contract C10); production
# uses a separate, non-test identity and database configuration.
set -euo pipefail

: "${TEAM_APP_PG_PASSWORD:?TEAM_APP_PG_PASSWORD required}"
: "${TEAM_MIGRATE_PG_PASSWORD:?TEAM_MIGRATE_PG_PASSWORD required}"
: "${TEAM_ADMIN_PG_PASSWORD:?TEAM_ADMIN_PG_PASSWORD required}"
: "${KEYCLOAK_PG_PASSWORD:?KEYCLOAK_PG_PASSWORD required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- DML-only role used by the portal application at runtime.
    CREATE ROLE team_app LOGIN PASSWORD '$TEAM_APP_PG_PASSWORD';
    -- DDL role used exclusively by the forward-only migration runner
    -- (scripts/team-migrate.mjs). Owns the `team` database and its schema.
    CREATE ROLE team_migrate LOGIN PASSWORD '$TEAM_MIGRATE_PG_PASSWORD';
    -- Dev-only superuser used by the test harness to create/drop scratch
    -- databases. Never use in production.
    CREATE ROLE team_admin LOGIN SUPERUSER PASSWORD '$TEAM_ADMIN_PG_PASSWORD';
    -- Identity provider has its own database and role, isolated from team data.
    CREATE ROLE keycloak LOGIN PASSWORD '$KEYCLOAK_PG_PASSWORD';

    CREATE DATABASE team OWNER team_migrate;
    CREATE DATABASE keycloak OWNER keycloak;

    GRANT CONNECT ON DATABASE team TO team_app;
EOSQL
