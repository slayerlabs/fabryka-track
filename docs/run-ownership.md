# Moving an SDK run to an account

A run belongs to the account that authenticated its first `run.init` event.
A public run can be inspected through its link, but it appears in an account's
runs workspace only when that account owns it.

The server operator can transfer a specific run without rotating either
account's API key or interrupting the training process:

```bash
python -m fabryka_track.account_admin transfer-run hf_example \
  --run-id 00000000-0000-0000-0000-000000000001 \
  --token-file /private/new-observer.env --days 14
```

The command exclusively creates a mode-0600 environment file and assigns the
run to the existing account in one database transaction. Move the file securely
to the observer's machine, replace its credential file, and restart only the
SDK observer. Durable SDK events are replayed for the same run UUID.

The generated bearer credential expires after the specified lifetime (default
14 days) and is stored only as a hash on the server. It can ingest events and
upload artifacts only for its run, and read that run. It cannot create another
run, rotate account credentials or use other authenticated APIs. A mixed batch
containing another run is rejected before any event is written. Ownership
changes invalidate existing credentials; another transfer revokes the previous
run tokens. Keep the observer credential private and renew it before expiry if
the training will continue beyond its lifetime.

After signing in, open `/runs`. Active runs appear in Focused runs; All runs
also includes the complete unarchived history. Search by the run name or project.
