"""Model-kind classification for benchmark ingestion (register-external-model core).

Given a LOCAL model directory (already fetched — fetch/DB surface is separate), decide
which scoring adapter applies, honoring the security contract agreed by the team:

  DATA not CODE — we read weights+config+tokenizer, we NEVER import a model's own
  ``modeling_*.py`` and NEVER enable ``trust_remote_code``. Two RCE vectors are closed:
    1. pickle weights (.pt/.bin only, no safetensors) -> REJECT.
    2. remote-code arch (config ``auto_map`` / custom loader) -> not run; only known
       bundled archs use our own code, everything else is N/A.

Classification is pure and side-effect free: no network, no imports of foreign code,
no model construction. It maps 1:1 onto the leaderboard status model (Mierniczy):
``eval_status in {scored, na_unsupported_arch, na_no_safetensors}``.
"""
import glob
import json
import os

# model_type values whose architecture we bundle and can score with our own code.
GOLLEM_FAMILY = {"gollem-gpt", "token-gpt"}


def classify_model(model_dir):
    """Classify a local model dir. Returns a dict; never imports foreign code.

    kind:        gollem_family | hf_standard | unsupported | no_safetensors
    adapter:     TokenCheckpointLM | HFLM | None
    eval_status: scored | na_unsupported_arch | na_no_safetensors
    reason:      short human-readable justification
    trust_remote_code is ALWAYS False for HFLM — surfaced explicitly for the caller.
    """
    cfg_path = os.path.join(model_dir, "config.json")
    if not os.path.exists(cfg_path):
        return _result("unsupported", None, "na_unsupported_arch", "no config.json")
    try:
        with open(cfg_path, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError) as exc:
        return _result("unsupported", None, "na_unsupported_arch", f"unreadable config.json ({type(exc).__name__})")

    has_safetensors = bool(glob.glob(os.path.join(model_dir, "*.safetensors")))
    if not has_safetensors:
        # Weights would be pickle (.pt/.bin) -> RCE vector #1. Never load untrusted pickle.
        return _result("no_safetensors", None, "na_no_safetensors",
                       "no *.safetensors (pickle weights are refused)")

    model_type = (cfg.get("model_type") or "").lower()

    # Known bundled family -> our own arch code (token_model.TokenGPT). Safe.
    if model_type in GOLLEM_FAMILY:
        return _result("gollem_family", "TokenCheckpointLM", "scored",
                       f"bundled arch (model_type={model_type!r})")

    # Remote-code arch (config asks to run the model's own loader) -> RCE vector #2.
    # We never execute it; if it is not our bundled family, it is N/A.
    if "auto_map" in cfg:
        return _result("unsupported", None, "na_unsupported_arch",
                       "config requires remote code (auto_map) — not executed")

    # Standard HF architecture: lm-eval's HFLM handles tokenizer+arch natively,
    # with trust_remote_code disabled. Requires a declared architecture/model_type.
    if cfg.get("architectures") or model_type:
        return _result("hf_standard", "HFLM", "scored",
                       f"standard HF arch (model_type={model_type or 'n/a'})",
                       trust_remote_code=False)

    return _result("unsupported", None, "na_unsupported_arch", "no recognizable architecture")


def _result(kind, adapter, eval_status, reason, trust_remote_code=None):
    out = {"kind": kind, "adapter": adapter, "eval_status": eval_status, "reason": reason}
    if trust_remote_code is not None:
        out["trust_remote_code"] = trust_remote_code
    return out
