"""Server-operator account maintenance; never exposed as a public API."""
import argparse

from sqlalchemy import delete, select, update

from .database import SessionLocal, create_tables
from .models import Account, AccountSession, Dataset, Run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['claim-legacy'])
    parser.add_argument('username')
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


if __name__ == '__main__':
    main()
