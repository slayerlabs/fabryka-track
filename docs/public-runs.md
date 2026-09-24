# Public run visibility

New runs are public by default, including SDK, Studio, external training and goal runs. Public details are readable in every state, without signing in. The Runs page lists all public runs under Public runs with name search; `GET /api/public/runs` provides the minimal discovery list.

The `all-runs-public-v2` startup migration publishes all existing runs once, including legacy unowned runs. Owners can still make supported runs private afterwards; restarts preserve that choice.

Public responses retain the restricted serializer. Private dataset contents, logs, notes, artifacts, credentials and write operations remain owner-only. The leaderboard still requires finished runs and completed evaluation evidence.
