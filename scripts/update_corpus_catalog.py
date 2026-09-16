"""Refresh the verified, text-free source catalog consumed by the React UI."""
import argparse
import hashlib
import json
from pathlib import Path

COLORS={'hplt':'#a84d33','wikipedia':'#527660','eurlex':'#647d96','wolne_lektury':'#91733a',
        'biblioteka_nauki':'#806589','wikibooks':'#267c7e','wikivoyage':'#84675a',
        'parliamentary':'#944766','wikisource':'#677d3e','fineweb2_pl':'#386b9c'}
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('folder',type=Path);args=parser.parse_args()
    catalog=json.loads((args.folder/'catalog.json').read_text())
    for d in catalog:
        assert hashlib.sha256((args.folder/(d['key']+'.txt')).read_bytes()).hexdigest()==d['sha256']
        d['color']=COLORS[d['key']]
    Path('docs/corpus-samples.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
