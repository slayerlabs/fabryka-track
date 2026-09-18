#!/usr/bin/env bash
# Install once as root-owned /usr/local/sbin/fabryka-track-github.
set -Eeuo pipefail
umask 077
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  revision=${BASH_REMATCH[1]}
else
  echo 'Only deploy <40-character commit SHA> is allowed.' >&2
  exit 64
fi
base=/opt/fabryka-track
exec 9>"$base/deploy.lock"
flock -w 900 9
mkdir -p "$base/releases" "$base/backups/deployments"
archive=$(mktemp "$base/deploy/upload.XXXXXX.tar")
trap 'rm -f "$archive"' EXIT
# Archive arrives on stdin; credentials and application data never enter it.
head -c 104857601 > "$archive"
[[ $(stat -c %s "$archive") -le 104857600 ]] || { echo 'Archive exceeds 100 MB' >&2; exit 1; }
release="$base/releases/$revision"
[[ ! -e "$release" ]] || { echo 'Release already exists; use a new commit or inspect the previous deployment.' >&2; exit 1; }
mkdir "$release"
python3 - "$archive" "$release" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    for entry in archive:
        if entry.issym() or entry.islnk():
            raise ValueError('Release archives may not contain links')
    archive.extractall(sys.argv[2], filter='data')
PY
printf '%s\n' "$revision" > "$release/REVISION"
previous=''
if [[ -L "$base/current" ]]; then previous=$(readlink -f "$base/current"); fi
venv_source="${previous:-$base}/.venv"
cp -a --reflink=auto "$venv_source" "$release/.venv"
"$release/.venv/bin/python" -m pip install --disable-pip-version-check "$release"
"$release/.venv/bin/python" -m pip check
(cd "$release" && PYTHONPATH= "$release/.venv/bin/python" -c 'import fabryka_track.api, pathlib, sys; assert pathlib.Path(fabryka_track.api.__file__).is_relative_to(pathlib.Path(sys.prefix)); print("Release import passed")')
cat > "$release/start" <<EOF
#!/bin/sh
export FABRYKA_DEPLOY_SHA=$revision
cd "$release"
export PYTHONPATH="$release"
exec "$release/.venv/bin/python" -m uvicorn fabryka_track.api:app --host 127.0.0.1 --port 8130
EOF
chmod 700 "$release/start"
# Preserve a consistent snapshot. Never automatically restore it over newer writes.
"$base/.venv/bin/python" - "$base" "$revision" <<'PY'
import sqlite3, sys
from pathlib import Path
base=Path(sys.argv[1])
with sqlite3.connect(base/'fabryka-track.db') as source, sqlite3.connect(base/'backups/deployments'/f'{sys.argv[2]}.sqlite') as target:
    source.backup(target)
PY
mkdir -p /etc/systemd/system/fabryka-track.service.d
cat > /etc/systemd/system/fabryka-track.service.d/deployment.conf <<EOF
[Service]
ExecStart=
ExecStart=$base/current/start
EOF
systemctl daemon-reload
ln -s "$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
healthy=false
if systemctl restart fabryka-track; then
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 http://127.0.0.1:8130/health | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("status")=="ok" and d.get("release")==sys.argv[1] else 1)' "$revision" 2>/dev/null; then
      healthy=true; break
    fi
    sleep 2
  done
fi
if [[ $healthy != true ]]; then
  if [[ -n $previous ]]; then
    ln -s "$previous" "$base/current.rollback"
    mv -Tf "$base/current.rollback" "$base/current"
  else
    unlink "$base/current"
    rm /etc/systemd/system/fabryka-track.service.d/deployment.conf
    systemctl daemon-reload
  fi
  systemctl restart fabryka-track
  echo 'New release failed health verification; previous application restored.' >&2
  exit 1
fi
printf '%s\n' "$revision" > "$base/DEPLOYED_REVISION"
printf 'Deployed %s\n' "$revision"

# Retain the five newest immutable releases and backups, plus the rollback target.
python3 - "$base" "$previous" <<'PYRETENTION'
from pathlib import Path
import re, shutil, sys
base=Path(sys.argv[1]);protected={base.joinpath('current').resolve(),Path(sys.argv[2])}
releases=sorted((p for p in base.joinpath('releases').iterdir() if p.is_dir() and not p.is_symlink() and re.fullmatch('[0-9a-f]{40}',p.name)),key=lambda p:p.stat().st_mtime,reverse=True)
for p in releases[5:]:
    if p not in protected:shutil.rmtree(p)
backups=sorted(base.joinpath('backups/deployments').glob('*.sqlite'),key=lambda p:p.stat().st_mtime,reverse=True)
for p in backups[5:]:p.unlink()
PYRETENTION
