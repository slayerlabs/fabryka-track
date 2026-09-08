"""Import a verified starter pack without modifying existing sources or runs."""
import argparse
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from fabryka_track.database import SessionLocal, engine
from fabryka_track.models import Dataset

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('folder',type=Path);args=parser.parse_args()
    catalog=json.loads((args.folder/'catalog.json').read_text())
    verified=[]
    for meta in catalog:
        content=(args.folder/(meta['key']+'.txt')).read_text()
        assert hashlib.sha256(content.encode()).hexdigest()==meta['sha256']
        assert 300<=len(content.encode())<=32_000_000
        verified.append((meta,content))
    if engine.url.drivername=='sqlite':
        backup=Path('backups')/('corpus-import-'+datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'));backup.mkdir(parents=True,exist_ok=True)
        with sqlite3.connect(engine.url.database) as source, sqlite3.connect(backup/'database.sqlite') as target:source.backup(target)
    with SessionLocal() as db:
        for meta,content in verified:
            item=db.get(Dataset,meta['id'])
            if item:
                assert item.sha256==meta['sha256'] and item.content==content
            else:db.add(Dataset(id=meta['id'],name=meta['name'],content=content,example=True,sha256=meta['sha256']))
        db.commit()
    print('Imported',len(verified),'real corpus samples; existing sources and run weights retained.')
