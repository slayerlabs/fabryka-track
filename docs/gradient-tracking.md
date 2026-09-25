# Gradient tracking

Track displays gradient metrics on public and owner run pages. Existing runs with no
measurements show an explicit empty state: gradients cannot be reconstructed from loss.

Built-in CPU and RunPod trainers report the global L2 norm before clipping, the
clipping threshold, and whether the sampled update exceeded that threshold. They
reuse the norm already computed by clipping and transfer its scalar only when
reporting metrics. These are sampled updates, not an interval clipping frequency.

For an SDK trainer, at the optimizer-update boundary after accumulation:

```python
loss.backward()
# With GradScaler: scaler.unscale_(optimizer) before clipping.
grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
optimizer.step()  # With GradScaler use scaler.step(optimizer), then scaler.update().
if should_log:
    norm = float(grad_norm)
    if math.isfinite(norm):
        run.log({
            "optimizer/gradient_norm": norm,
            "optimizer/gradient_clip_threshold": 1.0,
            "optimizer/gradient_clipped": float(norm > 1.0),
        }, step=optimizer_step)
```

Use the trainer's existing clipping call and threshold; do not clip a second time
just to log. With sharded parameters, use the training framework's global norm
operation. Handle nonfinite gradients using the trainer's existing failure/skip
policy; do not replace them with zero. This example uses ordinary unscaled training.

The external JSONL sidecar accepts `gradient_norm`, `gradient_norm_after_clip`,
`gradient_clip_threshold`, and `gradient_clipped` inside update `metrics`, and maps
them to the corresponding `optimizer/` keys. Only send an after-clipping norm when
it was actually measured. The public SDK view also recognizes `grad_norm`,
`train/grad_norm`, and `gradient_norm`; their clipping convention depends on the producer.

Gradient norm describes update inputs, not throughput. Compare it with loss,
learning rate, and clipping threshold. Neither a spike nor a small norm alone
establishes instability or identifies a slow content item. A clipping rate needs
counters over every optimizer update, not an average of sparse plotted samples.

Reference: https://docs.pytorch.org/docs/stable/generated/torch.nn.utils.clip_grad_norm_.html
