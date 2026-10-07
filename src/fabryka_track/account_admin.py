"""Server-operator account maintenance; never exposed as a public API."""
import argparse
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import secrets

from sqlalchemy import delete, select, update

from .database import SessionLocal, create_tables
from .accounts import digest
from .models import Account, AccountSession, Dataset, Run, RunSDKToken


def transfer_run(db, username, run_id, token_file, days=14):
    """Transfer one run and write a run-scoped credential without rotating account keys."""
    user = db.scalar(select(Account).where(Account.username == username.lower()))
    run = db.get(Run, run_id)
    if not user or not run:
        raise ValueError('Account or run does not exist.')
    if not 1 <= days <= 90:
        raise ValueError('Credential lifetime must be between 1 and 90 days.')
    token = 'frun_' + secrets.token_urlsafe(32)
    destination = Path(token_file)
    # Exclusive creation avoids overwriting credentials or following a symlink.
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as handle:
            handle.write(f'FABRYKA_API_KEY={token}\nFABRYKA_RUN_ID={run.id}\n'
                         'FABRYKA_API_URL=https://track.fabryka.ai\nFABRYKA_PUBLIC_LIVE_TRACKING=1\n')
            handle.flush()
            os.fsync(handle.fileno())
        db.execute(delete(RunSDKToken).where(RunSDKToken.run_id == run.id))
        run.owner_id = user.id
        expires = datetime.now(timezone.utc) + timedelta(days=days)
        db.add(RunSDKToken(key_hash=digest(token), account_id=user.id, run_id=run.id, expires_at=expires))
        db.commit()
    except Exception:
        db.rollback()
        destination.unlink(missing_ok=True)
        raise
    return {'run_id': run.id, 'username': user.username, 'expires_at': expires.isoformat()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['claim-legacy', 'transfer-run'])
    parser.add_argument('username')
    parser.add_argument('--run-id')
    parser.add_argument('--token-file')
    parser.add_argument('--days', type=int, default=14)
    args = parser.parse_args()
    create_tables()
    with SessionLocal() as db:
        user = db.scalar(select(Account).where(Account.username == args.username.lower()))
        if not user:
            parser.error('Account does not exist. Sign in with Hugging Face through the website first.')
        if args.action == 'claim-legacy':
            runs = db.execute(update(Run).where(Run.owner_id.is_(None)).values(owner_id=user.id)).rowcount
            datasets = db.execute(update(Dataset).where(Dataset.owner_id.is_(None), Dataset.example == False).values(owner_id=user.id)).rowcount
            db.commit()
            print(f'Assigned {runs} legacy runs and {datasets} uploaded datasets to {user.username}.')
        elif args.action == 'transfer-run':
            if not args.run_id or not args.token_file:
                parser.error('transfer-run requires --run-id and --token-file.')
            result = transfer_run(db, user.username, args.run_id, args.token_file, args.days)
            print(f'Assigned {result["run_id"]} to {result["username"]}; SDK access expires {result["expires_at"]}.')


if __name__ == '__main__':
    main()
