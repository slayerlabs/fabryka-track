---
pretty_name: "Wolne Lektury"
language:
- "pl"
license: "other"
license_name: "Multiple licenses"
domains:
- "Books"
- "Social Media"
---

# Dataset Card for Wolne Lektury

<!-- START-SHORT DESCRIPTION -->
School reading list.
<!-- END-SHORT DESCRIPTION -->

## Dataset Description

<!-- START-DESC-STATS -->
- **Number of samples**: 47.96K
- **Number of tokens (cl100k_base)**: 212.40M
- **Average document length in tokens (min, max)**: 4.43K (3, 90.00K)
<!-- END-DESC-STATS -->

## Dataset Structure
An example from the dataset looks as follows.

<!-- START-SAMPLE -->
```py
{
  "id": "wl-000001",
  "text": "Ala ma kota \u003c!-- x --\u003e",
  "source": "wolne_lektury"
}
```

### Data Fields

An entry in the dataset consists of the following fields:

- `id` (`str`): A unique identifier for each document.
- `text` (`str`): The content of the document.
- `source` (`str`): The source of the document (see [Source](#source)).
- `added` (`str`): The date when the document was added to this collection.
- `created` (`str`): The date range when the document was originally created.
- `token_count` (`int`): The number of tokens in the sample computed using the cl100k_base tokenizer.
<!-- END-SAMPLE -->

### Dataset Statistics

<!-- START-DATASET PLOTS -->
Plots are not generated for this source yet.
<!-- END-DATASET PLOTS -->

## Source

- **Address**: https://example.org/wl
- **Publisher**: Fundacja Nowoczesna Polska

## License Information

The records carry different licences:

| License | Records |
|---|---|
| `CC-BY-4.0` | 30000 |
| `CC-BY-SA-4.0` | 17000 |
| `a\|b 'c'` | 960 |

## Limitations

<script>alert(1)</script> <img src=x onerror=alert(1)>

See [click](javascript:alert(1)) and ![img](http://x/y.png).

## Additional Information

Per-record provenance is in `metadata.parquet`: one row per row of `data.parquet`, in the same order, joined by `id`, with `license`, `author`, `source_ref`, `attribution`, `quality_warnings`.
