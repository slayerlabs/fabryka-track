"""Shared CPU/GPU learning-rate schedule; step is one-based."""
import math


def learning_rate_at(config, step):
    peak = config['learning_rate']
    if config.get('lr_schedule', 'constant') == 'constant':
        return peak
    total = config['steps']
    step = min(total, max(1, step))
    warmup = max(1, math.ceil(total * .05))
    cooldown_start = total * .5
    if step <= warmup:
        factor = step / warmup
    elif step <= cooldown_start:
        factor = 1.
    else:
        factor = 1. - .95 * (step - cooldown_start) / (total - cooldown_start)
    return peak * max(.05, factor) if step > warmup else peak * factor
