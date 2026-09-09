"""Prepare bounded, traceable corpus samples; never commit the source text pack."""
import argparse
import hashlib
import json
import uuid
from pathlib import Path

import httpx
import pyarrow.parquet as pq
from huggingface_hub import HfFileSystem, HfApi

REV='02bcb0b5f991a30f8454c6444f701633b71f69d4'
REPO='SlayerLab/polish-dynaword'
SOURCES=[('wikipedia','Wikipedia PL','encyclopedia'),
         ('eurlex','Prawo UE · EUR-Lex','law'),
         ('wolne_lektury','Wolne Lektury','literature'),
         ('biblioteka_nauki','Biblioteka Nauki','science'),
         ('wikibooks','Wikibooks · podręczniki','science'),
         ('wikivoyage','Wikipodróże','encyclopedia'),
         ('parliamentary','Sejm / parlament','law'),
         ('wikisource','Wikiźródła','literature')]


def build(source,folder,max_bytes=1_000_000):
    key,name,category=source
    fs=HfFileSystem();records=[];texts=[];used=0;seen=set()
    with fs.open(f'datasets/{REPO}@{REV}/data/{key}/{key}.parquet','rb',block_size=1024*1024) as f:
        parquet=pq.ParquetFile(f)
        for batch in parquet.iter_batches(batch_size=32,row_groups=None):
            for row in batch.to_pylist():
                text=row['text'].strip();size=len(text.encode())
                digest=hashlib.sha256(text.encode()).hexdigest()
                if size<300 or size>250000 or digest in seen:continue
                if used+size+2>max_bytes:continue
                seen.add(digest);texts.append(text);used+=size+2
                records.append({k:v for k,v in row.items() if k!='text'}|{'text_sha256':digest})
            if used>=max_bytes*0.98:break
    if not records:raise RuntimeError('No records for '+key)
    content='\n\n'.join(texts)
    stats=httpx.get(f'https://huggingface.co/datasets/{REPO}/resolve/{REV}/data/{key}/{key}.stats.json',follow_redirects=True,timeout=30);stats.raise_for_status()
    meta={'key':key,'name':name,'category':category,'repo':REPO,'revision':REV,
          'url':f'https://huggingface.co/datasets/{REPO}/blob/{REV}/data/{key}/{key}.md',
          'sampling':'first eligible whole documents in source order; bounded sample, not representative',
          'source_documents':parquet.metadata.num_rows,'source_token_estimate':stats.json().get('tokens'),
          'source_tokenizer':'upstream tiktoken proxy','documents':len(records),'records':records}
    return save(content,meta,folder)


def save(content,meta,folder):
    digest=hashlib.sha256(content.encode()).hexdigest()
    meta.update(id=str(uuid.uuid5(uuid.NAMESPACE_URL,meta['repo']+'/'+meta['key']+'/'+digest)),sha256=digest,bytes=len(content.encode()))
    (folder/(meta['key']+'.txt')).write_text(content)
    (folder/(meta['key']+'.json')).write_text(json.dumps(meta,ensure_ascii=False,indent=2))
    print(meta['key'],meta['documents'],meta['bytes'],flush=True)
    return {k:v for k,v in meta.items() if k!='records'}


WEB_SOURCES = {
    'hplt': ('SlayerLab/hplt-v3-pl-cleaned', 'data', 'Web PL · HPLT'),
    'fineweb2_pl': ('HuggingFaceFW/fineweb-2', 'data/pol_Latn/train', 'FineWeb2 · polski web'),
}


def bounded_texts(rows, max_bytes):
    texts=[];records=[];seen=set();used=0
    for row in rows:
        text=(row.get('text') or '').strip()
        raw=text.encode('utf-8');digest=hashlib.sha256(raw).hexdigest()
        size=len(raw)+(2 if texts else 0)
        if len(raw)<300 or len(raw)>250_000 or digest in seen or used+size>max_bytes:
            continue
        texts.append(text);seen.add(digest);used+=size
        records.append({'text_sha256':digest})
        if used>=max_bytes*0.98:break
    if not texts:raise RuntimeError('No eligible corpus documents')
    return '\n\n'.join(texts),records


def web_sample(key,folder,max_bytes):
    repo,directory,name=WEB_SOURCES[key]
    api=HfApi();revision=api.dataset_info(repo).sha
    fs=HfFileSystem();files=[]
    def rows():
        for entry in api.list_repo_tree(repo,repo_type='dataset',revision=revision,path_in_repo=directory,recursive=True):
            if not entry.path.endswith('.parquet'):continue
            files.append(entry.path)
            with fs.open(f'datasets/{repo}@{revision}/{entry.path}','rb',block_size=1024*1024) as stream:
                parquet=pq.ParquetFile(stream)
                for batch in parquet.iter_batches(batch_size=128,columns=['text']):
                    yield from batch.to_pylist()
    content,records=bounded_texts(rows(),max_bytes)
    if len(content.encode())<max_bytes*0.98:
        raise RuntimeError(f'{key}: source exhausted before requested sample size')
    return save(content,{'key':key,'name':name,'category':'web','repo':repo,'revision':revision,
        'url':f'https://huggingface.co/datasets/{repo}/blob/{revision}/README.md',
        'documents':len(records),'records':records,'source_files':files,'target_bytes':max_bytes,
        'sampling':'first eligible unique whole documents from pinned source parquet files; bounded sample, not representative'},folder)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('folder',type=Path)
    parser.add_argument('--max-mb',type=int,default=103,choices=range(1,129))
    parser.add_argument('--sources',nargs='+',choices=[s[0] for s in SOURCES]+list(WEB_SOURCES))
    args=parser.parse_args();args.folder.mkdir(parents=True,exist_ok=True)
    catalog_path=args.folder/'catalog.json'
    old=json.loads(catalog_path.read_text()) if catalog_path.exists() else []
    keys=args.sources or [s[0] for s in SOURCES]+list(WEB_SOURCES)
    entries=[d for d in old if d['key'] not in keys]
    for key in keys:
        if key in WEB_SOURCES:
            entries.append(web_sample(key,args.folder,args.max_mb*1_000_000))
        else:
            entries.append(build(next(s for s in SOURCES if s[0]==key),args.folder,args.max_mb*1_000_000))
    for d in entries:
        previous=next((x for x in old if x['key']==d['key'] and x['id']!=d['id']),None)
        if previous:d['previous_ids']=list(dict.fromkeys(previous.get('previous_ids',[])+[previous['id']]))
    catalog_path.write_text(json.dumps(entries,ensure_ascii=False,indent=2))
