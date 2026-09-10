"""Bounded provider diagnostics for operator logs; never log requests or credentials."""
import json
import re


def response_details(response, secrets=()):
    text = response.text
    for secret in secrets:
        if secret:
            text = text.replace(str(secret), "[REDACTED]")
    text = re.sub(r"(?i)bearer\s+[^\s\"<>]+", "Bearer [REDACTED]", text)
    text = re.sub(r"hf_[A-Za-z0-9]+", "[REDACTED]", text)
    text = re.sub(r'(?i)(["\']?(?:access_token|refresh_token|token|authorization|api_key|TRACK_RUN_TOKEN)["\']?\s*[:=]\s*)["\']?[^,\s}]+', r'\1[REDACTED]', text)
    return json.dumps({"status": response.status_code,
                       "request_id": response.headers.get("x-request-id", "")[:200],
                       "body": text[:2000]}, ensure_ascii=True)
