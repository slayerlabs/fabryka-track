# Public run visibility

New runs are public by default, including SDK, Studio, external training and goal runs. Public details are readable in every state, without signing in. The unguarded `/public-runs` page is linked from Research & resources; it shows a newest-first list with name search, exact state and started-within-7/30-days filters, plus links to `/run/{id}`. Filters apply together in the browser and can be cleared when no runs match; a successful empty list says there are no public runs yet. `GET /api/public/runs` provides only ID, name, state, start and end timestamps for discovery. The private `/runs` workspace does not embed public browsing.

The `all-runs-public-v2` startup migration publishes all existing runs once, including legacy unowned runs. Owners can still make supported runs private afterwards; restarts preserve that choice.

Public responses retain the restricted serializer. Private dataset contents, logs, notes, artifacts, credentials and write operations remain owner-only. The leaderboard still requires finished runs and completed evaluation evidence.
