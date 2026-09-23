"""The native 149M decoder used by Track's long-context GPU runner.

This deliberately does not share the byte-model implementation.  It consumes
already-tokenized integer IDs, so the runner can train from an immutable shard
manifest on a RunPod network volume rather than trying to copy a large corpus
through Track's SQLite upload API.
"""
import torch
from torch import nn
from torch.nn import functional as F


class RMSNorm(nn.Module):
    def __init__(self, width, eps=1e-6):
        super().__init__(); self.weight = nn.Parameter(torch.ones(width)); self.eps = eps
    def forward(self, x):
        return x * torch.rsqrt(x.float().pow(2).mean(-1, keepdim=True) + self.eps).to(x.dtype) * self.weight


def apply_rope(x, base=10_000):
    """Apply parameter-free rotary position embeddings to [B, H, T, D]."""
    _, _, length, dim = x.shape
    if dim % 2:
        raise ValueError("RoPE requires an even head dimension")
    positions = torch.arange(length, device=x.device, dtype=torch.float32)
    frequencies = 1.0 / (base ** (torch.arange(0, dim, 2, device=x.device, dtype=torch.float32) / dim))
    angles = torch.outer(positions, frequencies)
    cos, sin = angles.cos().to(x.dtype)[None, None], angles.sin().to(x.dtype)[None, None]
    even, odd = x[..., ::2], x[..., 1::2]
    return torch.stack((even * cos - odd * sin, even * sin + odd * cos), dim=-1).flatten(-2)


class Attention(nn.Module):
    def __init__(self, width=576, query_heads=9, kv_heads=3, head_dim=64):
        super().__init__()
        assert width == query_heads * head_dim and query_heads % kv_heads == 0
        self.query_heads, self.kv_heads, self.head_dim = query_heads, kv_heads, head_dim
        self.q = nn.Linear(width, query_heads * head_dim, bias=False)
        self.k = nn.Linear(width, kv_heads * head_dim, bias=False)
        self.v = nn.Linear(width, kv_heads * head_dim, bias=False)
        self.o = nn.Linear(query_heads * head_dim, width, bias=False)
        # Shared head-dimension Q/K RMSNorms account for 128 parameters/layer.
        self.q_norm, self.k_norm = RMSNorm(head_dim), RMSNorm(head_dim)
    def forward(self, x):
        b, t, _ = x.shape
        q = self.q_norm(self.q(x).view(b, t, self.query_heads, self.head_dim)).transpose(1, 2)
        k = self.k_norm(self.k(x).view(b, t, self.kv_heads, self.head_dim)).transpose(1, 2)
        v = self.v(x).view(b, t, self.kv_heads, self.head_dim).transpose(1, 2)
        q, k = apply_rope(q), apply_rope(k)
        repeat = self.query_heads // self.kv_heads
        k, v = k.repeat_interleave(repeat, 1), v.repeat_interleave(repeat, 1)
        return self.o(F.scaled_dot_product_attention(q, k, v, is_causal=True).transpose(1, 2).reshape(b, t, -1))


class Block(nn.Module):
    def __init__(self, width=576, intermediate=1536):
        super().__init__()
        self.attn_norm, self.attn = RMSNorm(width), Attention(width)
        self.ffn_norm = RMSNorm(width)
        self.gate = nn.Linear(width, intermediate, bias=False)
        self.up = nn.Linear(width, intermediate, bias=False)
        self.down = nn.Linear(intermediate, width, bias=False)
    def forward(self, x):
        x = x + self.attn(self.attn_norm(x))
        return x + self.down(F.silu(self.gate(self.ffn_norm(x))) * self.up(self.ffn_norm(x)))


class Deep576_37L(nn.Module):
    vocab_size = 32768
    context_length = 2048
    expected_parameters = 149_863_232
    def __init__(self):
        super().__init__()
        self.embed = nn.Embedding(self.vocab_size, 576)
        self.blocks = nn.ModuleList(Block() for _ in range(37))
        self.norm = RMSNorm(576)
        self.lm_head = nn.Linear(576, self.vocab_size, bias=False)
        self.lm_head.weight = self.embed.weight
    def forward(self, tokens):
        x = self.embed(tokens)
        for block in self.blocks: x = block(x)
        return self.lm_head(self.norm(x))
    def parameter_count(self):
        return sum(p.numel() for p in self.parameters())
