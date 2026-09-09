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
- Re-running an already extracted SHA requires inspecting/removing its failed release directory first, or making a new commit. This prevents silently overwriting an immutable release.

GitHub branch-protection configuration is unavailable for this private repository on its current plan (API returned 403). The deployment still requires its workflow tests to pass. No account-plan changes were made.
