"""Import a verified starter pack without modifying existing sources or runs."""
import argparse
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from fabryka_track.database import SessionLocal, engine
from fabryka_track.models import Dataset

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('folder',type=Path);args=parser.parse_args()
    catalog=json.loads((args.folder/'catalog.json').read_text())
    verified=[]
    for meta in catalog:
        path=args.folder/(meta['key']+'.txt')
        assert 300<=path.stat().st_size<=512_000_000
        digest=hashlib.sha256()
        with path.open('rb') as source:
            for chunk in iter(lambda: source.read(1024*1024), b''):
                digest.update(chunk)
        assert digest.hexdigest()==meta['sha256']
        verified.append((meta,path))
    if engine.url.drivername=='sqlite':
        backup=Path('backups')/('corpus-import-'+datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'));backup.mkdir(parents=True,exist_ok=True)
        with sqlite3.connect(engine.url.database) as source, sqlite3.connect(backup/'database.sqlite') as target:source.backup(target)
    with SessionLocal() as db:
        for meta,path in verified:
            content=path.read_bytes().decode('utf-8')
            item=db.get(Dataset,meta['id'])
            if item:
                assert item.sha256==meta['sha256'] and item.content==content
            else:
                for old in db.scalars(select(Dataset).where(Dataset.name==meta['name'],Dataset.example==True,Dataset.id!=meta['id'])):
                    if not old.name.endswith(' · legacy sample'):
                        old.name += ' · legacy sample'
                db.add(Dataset(id=meta['id'],name=meta['name'],content=content,example=True,sha256=meta['sha256']))
                db.flush()
            db.commit()
            db.expunge_all()
        db.commit()
    print('Imported',len(verified),'real corpus samples; existing sources and run weights retained.')
