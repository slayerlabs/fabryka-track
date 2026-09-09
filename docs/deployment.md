# GitHub Actions deployment

`.github/workflows/ci-deploy.yml` runs tests and builds the Python package on pushes to `main` and on pull requests. Deployment is a manual `workflow_dispatch` action from `main` and starts only after verification succeeds.

The deployment uses the same SSH configuration names as `training-suit/mvp-model`, but it must use its own application directory. The two projects run as separate Compose projects and use different ports.

## GitHub environment

Create a `production` environment and copy the server connection settings used by the other repository:

| Variable | Purpose | Fabryka Track value |
| --- | --- | --- |
| `DEPLOY_HOST` | SSH host name or IP address | same server as Training Suit |
| `DEPLOY_USER` | dedicated deployment user | same deployment account |
| `DEPLOY_PORT` | SSH port | same port, defaults to `22` |

The application directory is fixed in the workflow as `/srv/track-fabryka-ai`; it is not a GitHub variable.

Add the same server-specific secrets to this repository's `production` environment:

| Secret | Purpose |
| --- | --- |
| `DEPLOY_SSH_KEY` | private key for the deployment user |
| `DEPLOY_KNOWN_HOSTS` | verified OpenSSH host entry for the configured host and port |

GitHub secrets are scoped to a repository or organization. A secret configured only in the Training Suit repository is not automatically visible here. Do not disable strict host-key checking.

## Server state

Before the first deployment, create `/srv/track-fabryka-ai` and its `.env`. The workflow preserves `.env`, database files, artifacts, backups, corpus samples and `DEPLOYED_COMMIT` during synchronization. `FABRYKA_DATABASE_URL` is required in the server-side `.env`; other settings follow `.env.example`. Set `FABRYKA_PUBLIC_URL=https://contest.fabryka.ai` there.

The deployment deliberately requires the existing `fabryka-track_postgres` Docker volume. It fails instead of silently creating an empty production database. Verify that the current PostgreSQL container uses that volume before the first workflow run. If the historical Compose project used another volume name, migrate or rename the volume during a maintenance window before enabling this workflow.

The first containerized deployment also requires port `8130` to be free. If the current application is a host process or systemd service, stop and disable that legacy process during the same maintenance window. Later deployments replace only the Compose-managed application.

The production Compose file:

- requires and reuses the stable `fabryka-track_postgres` volume;
- binds the web process to `127.0.0.1:8130`, matching `deploy/contest.fabryka.ai.caddy`;
- runs exactly one Uvicorn worker;
- keeps artifacts in `${FABRYKA_ARTIFACT_PATH:-./artifacts}`;
- records the successfully deployed Git commit in `DEPLOYED_COMMIT`.

Set `FABRYKA_ARTIFACT_PATH` in `.env` when artifacts should live outside the synchronized application directory.

## Deploy

Confirm that no local training, benchmark or Hugging Face upload is active and take a database backup. Then open **Actions > CI and deploy**, select **Run workflow** on `main`, and approve the `production` environment if it has required reviewers.

Push and pull-request workflows only verify the code; they never connect to the server.
