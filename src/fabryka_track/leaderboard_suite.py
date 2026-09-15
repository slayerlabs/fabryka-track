"""Pinned continuation benchmarks for native Track checkpoints.

Only benchmark data is read. Upstream Python/model code is never executed.
BananaMind data remains in a private evaluation-only cache, outside the repo.
"""
import hashlib
import json
import math
import os
from pathlib import Path

PROTOCOL = 'track-leaderboard-v1-byte-sliding'
TASKS = ['arc_easy','arc_challenge','piqa','arithmark2','arithmark3','bananamind_base_1_1','hellaswag','int_index']
DATA = {
    'arithmark2': ('AxiomicLabs/ArithMark-2.0','5bd986c7305dcccec88432d630aae1ac9280a71f','arithmark_2.0.jsonl',2500,'c245b4e50e603b32814d4f489f64934f9eeb4488ae29f744d906c8e3f326ebcd'),
    'arithmark3': ('AxiomicLabs/Arithmark-3.0','6f6e59dd9b7e2c63455f7af7f838f9ecc3d0a746','arithmark-3.jsonl',1000,'bf8ab1a5193d52cdf0e05ff0b3ca226bdfcf416cb6e75562dcbe72e7e4559435'),
    'bananamind_base_1_1': ('BananaMind/BananaMind-Base-Bench-1.1','d4aade51312889e8580963e1ce960c6eaef1a450','data/test.jsonl',350,'2f563bb46df778ca494fa20f994a8d3045d4c51fbbffeee433764e2813abea21'),
}
REVISIONS = {'allenai/ai2_arc':'210d026faf9955653af8916fad021475a3f00453',
             'baber/piqa':'142f6d7367fd9877f0fb3b5734ea6a545f54cdd1',
             'Rowan/hellaswag':'218ec52e09a7e7462a5400043bb9a69a41d06b76',
             **{row[0]:row[1] for row in DATA.values()}}


def load_rows(task):
    repo,revision,filename,count,digest=DATA[task]
    folder=os.environ.get('TRACK_BENCHMARK_DATA_DIR')
    if folder:
        path=Path(folder)/(task+'.jsonl')
    else:
        from huggingface_hub import hf_hub_download
        path=Path(hf_hub_download(repo,filename,repo_type='dataset',revision=revision))
    raw=path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=digest:raise ValueError('Benchmark dataset checksum mismatch: '+task)
    rows=[json.loads(line) for line in raw.splitlines() if line.strip()]
    if len(rows)!=count:raise ValueError('Benchmark dataset sample count mismatch: '+task)
    return rows


def fixed_item_elo(games):
    """BananaMind 1.1 weighted likelihood rating, including its four-game prior."""
    def expected(rating,item):return 1/(1+10**((item-rating)/400))
    low,high=0.,3000.
    for _ in range(80):
        rating=(low+high)/2
        residual=4*(.5-expected(rating,1000))
        residual+=sum(weight*(int(passed)-expected(rating,item)) for weight,item,passed in games)
        if residual>0:low=rating
        else:high=rating
    return (low+high)/2


def intelligence_index(results):
    keys=['arc_easy','arc_challenge','piqa','hellaswag','arithmark3']
    values=[results.get(k,{}).get('acc_norm') for k in keys]
    if any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) for v in values):return None
    easy,challenge,piqa,hella,arith=values
    norm=lambda value,chance:100*(value-chance)/(1-chance)
    return (norm(hella,.25)+norm((easy+challenge)/2,.25)+norm(piqa,.5)+.65*norm(arith,.25))/3.65


def index_result(results):
    score=intelligence_index(results)
    if score is None:raise ValueError('INT Index requires all five component results')
    components={k:results[k] for k in ['arc_easy','arc_challenge','piqa','hellaswag','arithmark3']}
    signature={k:{'digest':v['sample_digest'],'revisions':v['dataset_revisions'],'versions':v['task_versions']} for k,v in components.items()}
    return {'index':score,'samples':sum(v['samples'] for v in components.values()),'unit':'component examples',
            'sample_digest':hashlib.sha256(json.dumps(signature,sort_keys=True).encode()).hexdigest(),
            'dataset_revisions':{k:v for r in components.values() for k,v in r['dataset_revisions'].items()},
            'task_versions':{'int_index':'open-slm-75ebf270c9230e39bf661a8e26ae51a824a7e672-full-components'},
            'splits':{k:str(v['splits']) for k,v in components.items()}}


def evaluate(task,model,mode,rows=None):
    rows=load_rows(task) if rows is None else rows
    rows=rows[:10] if mode=='smoke' else rows
    correct=normalized=0;games=[];signature=hashlib.sha256()
    for start in range(0,len(rows),32):
        block=rows[start:start+32];pairs=[]
        for row in block:
            choices=row['continuations'] if task=='bananamind_base_1_1' else row['endings']
            context=row['context'] if task=='bananamind_base_1_1' else row['ctx']
            if not choices or any(not s for s in choices):raise ValueError('Empty continuation')
            pairs.extend((context,s) for s in choices)
        scored=model.score_many(pairs);offset=0
        for row in block:
            choices=row['continuations'] if task=='bananamind_base_1_1' else row['endings']
            scores=[s[0] for s in scored[offset:offset+len(choices)]];offset+=len(choices)
            norms=[score/len(text.encode('utf-8')) for score,text in zip(scores,choices)]
            label=int(row['label']);raw=max(range(len(scores)),key=scores.__getitem__);norm=max(range(len(norms)),key=norms.__getitem__)
            correct+=raw==label;normalized+=norm==label
            signature.update(json.dumps(row,sort_keys=True,ensure_ascii=False).encode()+b'\n')
            if task=='bananamind_base_1_1':
                games.append((float(row['category_weight'])*float(row['difficulty_weight']),float(row['item_elo']),norm==label))
    repo,revision,_,_,digest=DATA[task]
    result={'accuracy':correct/len(rows),'acc_norm':normalized/len(rows),'samples':len(rows),
            'sample_digest':signature.hexdigest(),'dataset_sha256':digest,'dataset_revisions':{repo:revision},
            'task_versions':{task:'native-byte-v1'},'splits':{task:'test' if task=='bananamind_base_1_1' else 'train'},
            'normalization':'UTF-8 byte count (native model tokens)'}
    if games:result['elo']=fixed_item_elo(games)
    return result
