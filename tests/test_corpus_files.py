import hashlib
import pytest
from fabryka_track.corpus_files import split_files, documents
from fabryka_track.training import _holdout_split


@pytest.mark.parametrize('raw', [b'one document '*200, b'\n\n'.join((f'Document {i} '.encode()*100) for i in range(30)), b'a'*1048575+b'\n\n'+b'b'*3000+b'\n\n'+b'c'*3000])
def test_disk_holdout_matches_existing_split(tmp_path, raw):
    source=tmp_path/'source';source.write_bytes(raw)
    train,val=tmp_path/'train',tmp_path/'val'
    seen={hashlib.sha256(b'not in this source').hexdigest()}
    expected_seen=set(seen)
    expected=_holdout_split(raw,42,expected_seen)
    split_files(source,train,val,42,seen)
    assert (train.read_bytes(),val.read_bytes())==expected
    assert seen==expected_seen


def test_cross_source_dedup(tmp_path):
    source=tmp_path/'source'; train,val=tmp_path/'train',tmp_path/'val'
    seen=set()
    for start in (0,5):
        raw=b'\n\n'.join(f'Document {i}'.encode() for i in range(start,start+10))
        source.write_bytes(raw)
        expected_seen=set(seen)
        expected=_holdout_split(raw,42,expected_seen)
        split_files(source,train,val,42,seen)
        assert (train.read_bytes(),val.read_bytes())==expected
        assert seen==expected_seen
