"""Server-operator account maintenance; never exposed as a public API."""
import argparse
import getpass

from sqlalchemy import delete, select, update

from .accounts import passwords
from .database import SessionLocal, create_tables
from .models import Account, AccountSession, Dataset, Run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['claim-legacy', 'reset-password'])
    parser.add_argument('username')
    args = parser.parse_args()
    create_tables()
    with SessionLocal() as db:
        user = db.scalar(select(Account).where(Account.username == args.username.lower()))
        if not user:
            parser.error('Account does not exist. Register through the website first.')
        if args.action == 'claim-legacy':
            runs = db.execute(update(Run).where(Run.owner_id.is_(None)).values(owner_id=user.id)).rowcount
            datasets = db.execute(update(Dataset).where(Dataset.owner_id.is_(None), Dataset.example == False).values(owner_id=user.id)).rowcount
            db.commit()
            print(f'Assigned {runs} legacy runs and {datasets} uploaded datasets to {user.username}.')
        else:
            password = getpass.getpass('New password (12–128 characters): ')
            if not 12 <= len(password) <= 128 or password != getpass.getpass('Repeat password: '):
                parser.error('Password length or confirmation is invalid.')
            user.password_hash = passwords.hash(password)
            user.api_key_hash = None
            db.execute(delete(AccountSession).where(AccountSession.account_id == user.id))
            db.commit()
            print('Password reset; sessions and API key revoked.')


if __name__ == '__main__':
    main()
