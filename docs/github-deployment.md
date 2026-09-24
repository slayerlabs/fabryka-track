# Production deployment

Canonical repository: `slayerlabs/fabryka-track`. `.github/workflows/deploy.yml` tests pull requests and deploys successful pushes to `main` (including merges). It can also be dispatched manually on `main`. Older workflow runs skip deployment if main has advanced. Production jobs are serialized and are not cancelled mid-deployment.

## Server

Target: `root@70.34.245.254`, systemd `fabryka-track.service`, Caddy at `https://track.fabryka.ai`.

The dedicated GitHub SSH key is restricted to `/usr/local/sbin/fabryka-track-github` with `deploy <commit SHA>`. It cannot open an interactive shell, forward ports, or run arbitrary SSH commands. The workflow transfers a Git archive of the tested commit over stdin. `PRODUCTION_SSH_KEY` and `PRODUCTION_KNOWN_HOSTS` are repository Actions secrets; the host key was obtained through the existing trusted administrator connection.

Each release lives at `/opt/fabryka-track/releases/<SHA>` with an isolated copy of the previous Python environment and the newly installed application. Dependencies are installed before cutover. `/opt/fabryka-track/current` points to the live release. The service continues using `/opt/fabryka-track` as its working directory, so `.env`, the database, artifact directories, corpus packs and the fast-ladder pack remain outside releases. GPU pods are not terminated by deployment. External benchmark-worker machines are not updated by this workflow.

The server takes a consistent SQLite backup, switches the release symlink, restarts the API, and verifies `/health` reports the expected commit. If startup/health verification fails, it switches back and restarts the previous application. The workflow separately verifies the public HTTPS health response. A public/network verification failure is reported without discarding a locally healthy release.

Five releases and database snapshots are retained, plus the previous release when needed for rollback. Migrations must remain backward-compatible for application rollback. Database snapshots are never restored automatically over newer user writes.

## Operations

- Inspect deployments in the repository's Actions tab and `journalctl -u fabryka-track`.
- `/health` exposes the active release SHA; `/opt/fabryka-track/DEPLOYED_REVISION` records the last successful switch.
- To roll back, an administrator can point `current` at a retained release and restart `fabryka-track.service`. For the first deployment, the original environment/source tree remains available and removing `deployment.conf` restores the original service command.
- The forced-command script is deliberately root-owned and installed separately from application releases. Changes to `deploy/github-deploy.sh` require an administrator to update `/usr/local/sbin/fabryka-track-github`.
- Re-running the currently active SHA succeeds without another restart if its local health response matches the requested SHA. Other already extracted SHAs require inspecting/removing the failed release directory first, or making a new commit. Immutable release directories are never overwritten.

GitHub branch-protection configuration is unavailable for this private repository on its current plan (API returned 403). The deployment still requires its workflow tests to pass. No account-plan changes were made.

## Fast deployment path

The test job builds the frontend before Python checks because route integration tests load its assets. CI caches the installed CPU Python environment using the exact Python version, OS/architecture, dependency declarations, lockfile and workflow contents as the key. A cache hit skips dependency resolution and installation; the current application is always reinstalled without dependencies and `pip check` still runs. To force a fresh environment, increment `cpu-test-env-v1` in the workflow. The first run for a new key is a cold build.

The test job builds once, runs website and Python tests, and uploads an immutable `release-<SHA>` artifact containing the Git archive plus built frontend. The deployment job downloads that same artifact after all checks pass. It does not install Node dependencies or rebuild frontend assets. Artifacts expire after three days.

New commits cancel obsolete checks, but production deployments remain serialized and cannot be cancelled midway. Database backups, atomic cutover, health checks and rollback remain enabled. The server environment stays isolated per release; avoid sharing a mutable virtualenv across releases because package installation would also modify the rollback target.

Measured baseline on 2026-09-24 (workflow 36030661679): Python dependency installation 59 seconds, Python tests 62 seconds, duplicate frontend build 9 seconds, server deployment 25 seconds. Cache-hit savings must be measured separately from the initial cold run. A container migration is not required for these savings; a prebuilt dependency image remains an option if cache restore becomes the bottleneck.
