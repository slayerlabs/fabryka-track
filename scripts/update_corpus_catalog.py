"""Embed the verified, text-free source catalog into the standalone UI."""
import argparse
import hashlib
import json
import re
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
    p=Path('src/fabryka_track/static/index.html');s=p.read_text()
    encoded=json.dumps({d['id']:d for d in catalog},ensure_ascii=True).replace('<','\\u003c')
    s=re.sub(r'// CORPUS_CATALOG_START.*?// CORPUS_CATALOG_END',lambda _: '// CORPUS_CATALOG_START\n      const corpusSources = '+encoded+';\n      // CORPUS_CATALOG_END',s,flags=re.S)
    p.write_text(s)
