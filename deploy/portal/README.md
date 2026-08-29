# PromptBranch Production Portal Deployment

*Ops runbook for hosting the [sharing portal](../README.md) on your own VPS.
Part of [PromptBranch](../../../README.md).*

This directory is the production deployment for the PromptBranch sharing
portal on a single Ubuntu/Docker host:

```text
Internet :80/:443 -> Nginx Proxy Manager -> promptbranch-app network -> portal:3000
```

The portal has no published host port. Nginx Proxy Manager is the only service
bound to the public HTTP/HTTPS ports. Its admin UI is bound to `127.0.0.1:81`
on the host and should be reached through an SSH tunnel, not from the public
Internet.

## First deployment

1. Point the DNS `A` record for the public hostname at the VPS. The repository
   example uses `promptbranch.app`; for this server its public `A` record must
   resolve to `2.24.209.210` before requesting a certificate.
2. Copy `.env.example` to `.env`, set `PUBLIC_BASE_URL`, and add a unique
   `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` for the first NPM boot.
   Keep `.env` out of version control and set it to mode `600`.
3. Start the stack as the `dev` user:

   ```sh
   cd /home/dev/promptbranch/deploy/portal
   docker compose config
   docker compose up --build -d
   docker compose ps
   ```

4. Remove `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` from `.env` after
   Nginx Proxy Manager has created the first administrator. The account and
   its password live in the persistent `npm-data` volume.
5. Open the NPM admin UI through an SSH tunnel from a trusted workstation:

   ```sh
   ssh -N -L 8181:127.0.0.1:81 dev@2.24.209.210
   ```

   Then browse to <http://127.0.0.1:8181>.

6. In NPM, create a Proxy Host with:

   - Domain: `promptbranch.app`
   - Scheme: `http`
   - Forward hostname: `portal`
   - Forward port: `3000`
   - Block Common Exploits: enabled
   - Websockets Support: enabled if needed by a future portal feature

   In the SSL tab, request a new Let's Encrypt certificate for the same
   hostname, provide a real renewal/contact email, accept the terms, enable
   Force SSL, and enable HTTP/2. The DNS `A` record and inbound TCP ports 80
   and 443 must already reach this host for the HTTP-01 challenge.

7. Verify from outside the VPS:

   ```sh
   curl -fsSI https://promptbranch.app/
   curl -fsS https://promptbranch.app/robots.txt
   ```

   The first command must show a trusted certificate and an HTTP success
   response. The second must retain `Disallow: /p/` and `Disallow: /api/`
   (snapshot links stay unlisted while the landing page and docs remain
   indexable).

## Operations

The server checkout is deliberately transferred without `.git` metadata. Run
upgrades from the trusted repository checkout, then rebuild as `dev` on the
server:

```sh
rsync -az \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.next/' \
  --exclude='dist/' \
  --exclude='**/.env' \
  --exclude='apps/portal/data/' \
  --exclude='deploy/portal/data/' \
  ./ dev@2.24.209.210:/home/dev/promptbranch/
ssh dev@2.24.209.210 \
  'cd /home/dev/promptbranch/deploy/portal && docker compose config && docker compose build --pull portal && docker compose up -d'
```

Then verify the deployment:

```sh
ssh dev@2.24.209.210 \
  'cd /home/dev/promptbranch/deploy/portal && docker compose ps'
```

The portal image runs as UID/GID `1000:1000` (`node` in the image), with a
read-only root filesystem, no Linux capabilities, and only `/data` plus a
temporary `/tmp` writable. Nginx Proxy Manager remains root inside its
official container because it binds ports 80/443, manages nginx configuration,
and runs certbot; it has no public admin port and no host Docker socket.

Named volumes are deliberately stable across Compose project-directory or
image changes:

| Volume | Contents |
| --- | --- |
| `promptbranch-portal-data` | Portal SQLite database and WAL/SHM files |
| `promptbranch-npm-data` | NPM SQLite database, config, and generated nginx state |
| `promptbranch-npm-letsencrypt` | NPM's Let's Encrypt accounts, certificates, and renewal state |

Before an upgrade, make a backup while the services are stopped or after a
SQLite checkpoint. A simple host-level backup of the named volumes is:

```sh
docker run --rm --network none \
  -v promptbranch-portal-data:/source:ro \
  -v /var/backups/promptbranch:/backup \
  alpine:3.22 sh -c 'tar czf /backup/portal-data-$(date +%F).tgz -C /source .'
docker run --rm --network none \
  -v promptbranch-npm-data:/source:ro \
  -v promptbranch-npm-letsencrypt:/letsencrypt:ro \
  -v /var/backups/promptbranch:/backup \
  alpine:3.22 sh -c 'tar czf /backup/npm-data-$(date +%F).tgz -C /source . && tar czf /backup/npm-letsencrypt-$(date +%F).tgz -C /letsencrypt .'
```

The Docker daemon is configured as the normal rootful system service with a
Unix socket only; it is not exposed over TCP and no rootless daemon is mixed
into this deployment. `dev` is in the `docker` group so Docker commands do not
require a root login. Membership in that group is equivalent to root on the
host, so only trusted administrators should use it. The NPM image is pinned by
digest in `.env.example`; update it deliberately and back up the NPM volumes
before upgrades.

The host firewall permits only SSH, HTTP, and HTTPS inbound. SSH password
authentication and root SSH login are disabled after the `dev` key path is
verified. Change the temporary `dev` password immediately with `sudo passwd dev`
after the key login is verified. NPM's admin UI is loopback-only and should
be reached through an SSH local-forwarding tunnel.

The reproducible host policy files live under `host/`: Docker daemon logging
and live-restore settings, the SSH hardening drop-in, the fail2ban SSH jail,
and the unattended-upgrades schedule. The initial host bootstrap is
`scripts/bootstrap-host.sh` — run it as root with the staged host-files
directory as its only argument (`sudo bash scripts/bootstrap-host.sh
/path/to/staged-host-files`; the temporary `dev` password is read from stdin).
It installs these policy files and validates `sshd -t`; the hardened SSH
configuration takes effect once SSH restarts after the `dev` key login has
been verified.
