"""Build an immutable English diagnostic pack; text stays outside Git."""
import hashlib
import json
import random
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys

import httpx
from datasets import load_dataset
from huggingface_hub import HfApi

ROOT='https://api.osf.io/v2/nodes/ad7qg/files/osfstorage/'
FOLDERS={'fast_blimp':'66358ee7e8eec5175f6bebc4','fast_supplement':'66358ef14664da20a9ed6c6f'}


def build(folder):
    folder.mkdir(parents=True,exist_ok=True);manifest={'protocol':'fast-en-v1','seed':42,'sources':{},'components':{}}
    def save(key,rows,source):
        raw=('\n'.join(json.dumps(x,ensure_ascii=False) for x in rows)+'\n').encode()
        (folder/(key+'.jsonl')).write_bytes(raw)
        manifest['components'][key]={'sha256':hashlib.sha256(raw).hexdigest(),'items':len(rows)}
        manifest['sources'][key]=source
        print(key,len(rows),len(raw),flush=True)
    for key,directory in FOLDERS.items():
        url=ROOT+directory+'/?page[size]=100';files=[]
        while url:
            response=httpx.get(url,timeout=60);response.raise_for_status();data=response.json()
            files+=data['data'];url=data.get('links',{}).get('next')
        files=sorted(files,key=lambda x:x['attributes']['name'])
        def download(item):
            cache=folder/(key+'-'+item['attributes']['name'])
            if not cache.exists():
                response=httpx.get(item['links']['download'],follow_redirects=True,timeout=120);response.raise_for_status()
                cache.write_text(response.text)
            rows=[json.loads(line) for line in cache.read_text().splitlines() if line.strip()]
            random.Random(42).shuffle(rows)
            if key=='fast_blimp':rows=rows[:127]
            return [{'context':'','good':r['sentence_good'],'bad':r['sentence_bad'],'group':item['attributes']['name']} for r in rows]
        with ThreadPoolExecutor(max_workers=4) as pool:rows=[r for group in pool.map(download,files) for r in group]
        save(key,rows,{'url':ROOT+directory+'/','variant':'BabyLM 2024 vocabulary-filtered','selection':'seed42; 127 per phenomenon' if key=='fast_blimp' else 'all available pairs'})
    api=HfApi()
    repo='allenai/ai2_arc';rev=api.dataset_info(repo).sha
    rows=list(load_dataset(repo,'ARC-Easy',split='test',revision=rev));random.Random(42).shuffle(rows)
    save('fast_arc',[{'context':r['question']+'\nAnswer:', 'choices':[' '+x for x in r['choices']['text']],
                     'answer':r['choices']['label'].index(r['answerKey'])} for r in rows[:1000]],{'repo':repo,'revision':rev,'config':'ARC-Easy','split':'test'})
    repo='Salesforce/wikitext';rev=api.dataset_info(repo).sha
    rows=load_dataset(repo,'wikitext-103-raw-v1',split='validation',revision=rev)
    text='\n'.join(r['text'] for r in rows if r['text'].strip());raw=text.encode()[:1_000_000]
    text=raw.decode('utf-8',errors='ignore')
    if len(text.encode())<500_000:raise RuntimeError('Insufficient held-out text')
    save('fast_lm',[{'text':text}],{'repo':repo,'revision':rev,'config':'wikitext-103-raw-v1','split':'validation','bytes':len(text.encode()),'contamination':'external validation split; user training overlap not audited'})
    try:
        repo='ewok-core/ewok-core-1.0';rev=api.dataset_info(repo).sha
        rows=list(load_dataset(repo,split='test',revision=rev));random.Random(42).shuffle(rows)
        save('fast_ewok',[{'context':r['Context1'],'good':r['Target1'],'bad':r['Target2'],
                          'context2':r['Context2'],'group':r['Domain']} for r in rows[:1500]],{'repo':repo,'revision':rev,'split':'test'})
    except Exception as exc:
        from datasets.exceptions import DatasetNotFoundError
        if not isinstance(exc,DatasetNotFoundError):raise
        manifest['unavailable']={'fast_ewok':'Hugging Face access approval required'}
        print('fast_ewok: access approval required',flush=True)
    (folder/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))

if __name__=='__main__':build(Path(sys.argv[1]))
