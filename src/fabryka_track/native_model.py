import torch
from torch import nn

class TinyTransformer(nn.Module):
    """A causal decoder using a fixed UTF-8 byte vocabulary."""
    def __init__(self, width=64, layers=2, heads=4, context_length=32):
        super().__init__()
        self.tokens = nn.Embedding(256, width)
        self.positions = nn.Embedding(context_length, width)
        layer = nn.TransformerEncoderLayer(width, heads, width * 4, dropout=0.0, batch_first=True, norm_first=True)
        self.blocks = nn.TransformerEncoder(layer, layers, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(width)
        self.head = nn.Linear(width, 256, bias=False)

    def forward(self, x):
        length = x.shape[1]
        h = self.tokens(x) + self.positions(torch.arange(length, device=x.device))
        mask = torch.ones(length, length, dtype=torch.bool, device=x.device).triu(1)
        return self.head(self.norm(self.blocks(h, mask=mask)))

