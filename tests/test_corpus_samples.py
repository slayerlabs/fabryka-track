import importlib.util
from pathlib import Path

import pytest
pytest.importorskip("pyarrow")

spec=importlib.util.spec_from_file_location('corpus_builder',Path(__file__).parents[1]/'scripts/build_corpus_samples.py')
builder=importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def test_web_sample_continues_after_first_hundred_documents():
    rows=({'text':f'{i:05d} '+('ą'*200)} for i in range(1000))
    content,records=builder.bounded_texts(rows,100_000)
    assert len(records)>100
    assert 98_000<=len(content.encode('utf-8'))<=100_000
    assert len({r['text_sha256'] for r in records})==len(records)


def test_sample_keeps_whole_unique_documents_within_utf8_budget():
    a='ą'*200;b='b'*400
    content,records=builder.bounded_texts(iter([{'text':'tiny'},{'text':a},{'text':a},{'text':'x'*250001},{'text':b}]),805)
    assert content==a+'\n\n'+b
    assert len(records)==2
    assert len(content.encode())==802
