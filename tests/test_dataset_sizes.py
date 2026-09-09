from types import SimpleNamespace
from fabryka_track.training import describe


def test_dataset_sizes_measure_utf8_bytes_not_characters():
    text = 'Zażółć gęślą jaźń 🌍'
    row = describe(SimpleNamespace(id='fixture', name='Polish sample', content=text, byte_count=None, example=True, sha256='fixture'))
    assert row['bytes'] == len(text.encode('utf-8')) > len(text)
    assert row['token_count'] == row['bytes']
    assert row['size_mb'] == row['bytes'] / 1_000_000
    assert row['tokenizer'] == 'utf8-bytes'
