"""Prepare bounded, traceable corpus samples; never commit the source text pack."""
import argparse
import hashlib
import json
import uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import httpx
import pyarrow.parquet as pq
from huggingface_hub import HfFileSystem

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


def web(folder):
    repo='SlayerLab/hplt-v3-pl-cleaned';records=[];texts=[];revision=None
    with httpx.Client(timeout=30) as client:
        for offset in [0]:
            response=client.get('https://datasets-server.huggingface.co/rows',params={'dataset':repo,'config':'default','split':'train','offset':offset,'length':100});response.raise_for_status()
            if revision is not None and revision!=response.headers.get('x-revision'):raise RuntimeError('Source revision changed')
            revision=response.headers['x-revision']
            for record in response.json()['rows']:
                if record['truncated_cells']:continue
                row=record['row'];text=row['text'].strip()
                if len(text.encode())<300:continue
                texts.append(text);records.append({k:v for k,v in row.items() if k!='text'}|{'text_sha256':hashlib.sha256(text.encode()).hexdigest()})
    return save('\n\n'.join(texts),{'key':'hplt','name':'Web PL · HPLT','category':'web','repo':repo,'revision':revision,
        'url':'https://huggingface.co/datasets/'+repo+'/blob/'+revision+'/README.md',
        'documents':len(records),'records':records,'source_documents':response.json()['num_rows_total'],
        'source_token_estimate':None,'source_tokenizer':'upstream reference tokenizer',
        'sampling':'first 100 viewer rows, untruncated whole documents; workflow sample, not representative'},folder)


def fineweb(folder):
    repo='HuggingFaceFW/fineweb-2'
    response=httpx.get('https://datasets-server.huggingface.co/rows',params={'dataset':repo,'config':'pol_Latn','split':'train','offset':0,'length':100},timeout=30)
    response.raise_for_status();records=[];texts=[]
    for item in response.json()['rows']:
        if item['truncated_cells']:continue
        row=item['row'];text=row['text'].strip()
        if len(text.encode())<300:continue
        texts.append(text);records.append({k:v for k,v in row.items() if k!='text'}|{'text_sha256':hashlib.sha256(text.encode()).hexdigest()})
    revision=response.headers['x-revision']
    return save('\n\n'.join(texts),{'key':'fineweb2_pl','name':'FineWeb2 · polski web','category':'web',
        'repo':repo,'revision':revision,'config':'pol_Latn','url':'https://huggingface.co/datasets/'+repo+'/blob/'+revision+'/README.md',
        'documents':len(records),'records':records,'source_documents':response.json()['num_rows_total'],
        'source_token_estimate':None,'source_tokenizer':'upstream reference tokenizer',
        'sampling':'first 100 pol_Latn viewer rows, untruncated whole documents; workflow sample, not representative'},folder)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('folder',type=Path)
    parser.add_argument('--max-mb',type=int,default=1,choices=range(1,33))
    parser.add_argument('--sources',nargs='+',choices=[s[0] for s in SOURCES])
    args=parser.parse_args();args.folder.mkdir(parents=True,exist_ok=True)
    catalog_path=args.folder/'catalog.json'
    old=json.loads(catalog_path.read_text()) if catalog_path.exists() else []
    if args.sources:
        chosen=[s for s in SOURCES if s[0] in args.sources]
        entries=[d for d in old if d['key'] not in args.sources]
    else:
        chosen=SOURCES
        entries=[web(args.folder),fineweb(args.folder)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        entries+=list(pool.map(lambda source:build(source,args.folder,args.max_mb*1_000_000),chosen))
    for d in entries:
        previous=next((x for x in old if x['key']==d['key'] and x['id']!=d['id']),None)
        if previous:d['previous_ids']=list(dict.fromkeys(previous.get('previous_ids',[])+[previous['id']]))
    catalog_path.write_text(json.dumps(entries,ensure_ascii=False,indent=2))
