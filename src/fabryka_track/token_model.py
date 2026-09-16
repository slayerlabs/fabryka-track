"""Subword (token-level) model architecture for the token checkpoint adapter.

Self-contained GoLLeM-style decoder (nanoGPT lineage): pre-LN, GELU MLP, SDPA causal
attention, learned positions, tied embeddings. This is the token-level sibling of
``native_model.TinyTransformer`` (byte-level) — it exists so the tracker can score
tokenized SLM checkpoints (e.g. GoLLeM V32k safetensors) without pulling HF Transformers.

Weights load from safetensors produced by the training stack (head tied to the token
embedding, so ``head.weight`` may be absent from the state dict — that is expected).
"""
import torch
import torch.nn as nn
import torch.nn.functional as F


class Block(nn.Module):
    def __init__(self, d, nh):
        super().__init__()
        self.nh = nh
        self.ln1 = nn.LayerNorm(d)
        self.ln2 = nn.LayerNorm(d)
        self.qkv = nn.Linear(d, 3 * d)
        self.proj = nn.Linear(d, d)
        self.fc = nn.Linear(d, 4 * d)
        self.fc2 = nn.Linear(4 * d, d)

    def forward(self, x):
        B, T, D = x.shape
        q, k, v = self.qkv(self.ln1(x)).split(D, 2)
        q = q.view(B, T, self.nh, D // self.nh).transpose(1, 2)
        k = k.view(B, T, self.nh, D // self.nh).transpose(1, 2)
        v = v.view(B, T, self.nh, D // self.nh).transpose(1, 2)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        y = y.transpose(1, 2).contiguous().view(B, T, D)
        x = x + self.proj(y)
        x = x + self.fc2(F.gelu(self.fc(self.ln2(x))))
        return x


class TokenGPT(nn.Module):
    """Token-level decoder. ``forward`` returns logits only (loss omitted — eval-only)."""

    def __init__(self, vocab_size, d_model, n_layer, n_head, block_size):
        super().__init__()
        self.vocab_size = vocab_size
        self.block_size = block_size
        self.tok = nn.Embedding(vocab_size, d_model)
        self.pos = nn.Embedding(block_size, d_model)
        self.blocks = nn.ModuleList([Block(d_model, n_head) for _ in range(n_layer)])
        self.lnf = nn.LayerNorm(d_model)
        self.head = nn.Linear(d_model, vocab_size, bias=False)
        self.tok.weight = self.head.weight  # weight tying (GPT-2 style)

    def forward(self, idx):
        T = idx.shape[1]
        x = self.tok(idx) + self.pos(torch.arange(T, device=idx.device))[None]
        for block in self.blocks:
            x = block(x)
        return self.head(self.lnf(x))
