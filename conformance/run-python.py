#!/usr/bin/env python3
"""Independent Python implementation of the Superpose envelope conformance surface.

This file deliberately shares no code with packages/protocol. It re-derives
canonical JSON, sha256, base64url, the legality verdict and the envelope
verification verdict from docs/MVP-CONTRACT.md alone.

Output: one NDJSON object per input case, in vectors.json order.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import re
import sys
from decimal import Decimal
from pathlib import Path

LEGAL_CATEGORIES = ("env", "perm", "iface", "device")
SCHEMA_FOR_CATEGORY = {
    "env": "env.v1",
    "perm": "perm.v1",
    "iface": "iface.v1",
    "device": "device.v1",
}
REQUIRED_FIELDS = {
    "env": ("region", "epochMs", "subjects"),
    "perm": ("subjectId", "op", "resource", "granteeKeyIds", "notBefore", "notAfter"),
    "iface": ("deviceId", "ops", "meta", "ownerSuiteId"),
    "device": ("deviceId", "state", "observedAt"),
}

MAX_CLOCK_SKEW_MS = 60_000
MAX_ENVELOPE_AGE_MS = 300_000

B64URL_RE = re.compile(r"^[A-Za-z0-9_-]*$")
_JSON_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}

try:  # optional dependency: the suite degrades to SKIP, never to a fake PASS
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey,
        Ed25519PublicKey,
    )

    HAVE_ED25519 = True
except Exception:  # pragma: no cover - environment dependent
    HAVE_ED25519 = False


# --------------------------------------------------------------------------
# canonical JSON (contract 3.1: keys ascending by UTF-16 code unit, no
# whitespace, numbers in JSON.stringify representation, no Unicode
# normalisation)
# --------------------------------------------------------------------------


def js_number(value: float) -> str:
    """ECMAScript Number::toString for a finite double (what JSON.stringify prints)."""
    if value == 0:
        return "0"
    if math.isnan(value) or math.isinf(value):
        return "null"
    sign = "-" if value < 0 else ""
    dec = Decimal(repr(abs(value)))
    _, digits, exponent = dec.as_tuple()
    digits = list(digits)
    exponent = int(exponent)
    while len(digits) > 1 and digits[-1] == 0:
        digits.pop()
        exponent += 1
    if digits == [0]:
        return "0"
    s = "".join(str(d) for d in digits)
    k = len(s)
    n = exponent + k
    if k <= n <= 21:
        return sign + s + "0" * (n - k)
    if 0 < n <= 21:
        return sign + s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + s
    exp = n - 1
    exp_text = ("+" if exp >= 0 else "-") + str(abs(exp))
    if k == 1:
        return sign + s + "e" + exp_text
    return sign + s[0] + "." + s[1:] + "e" + exp_text


def js_quote(text: str) -> str:
    out = ['"']
    for char in text:
        escaped = _JSON_ESCAPES.get(char)
        if escaped is not None:
            out.append(escaped)
        elif ord(char) < 0x20:
            out.append("\\u%04x" % ord(char))
        else:
            out.append(char)
    out.append('"')
    return "".join(out)


def canonical(value) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return js_number(float(value))
    if isinstance(value, str):
        return js_quote(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        ordered = sorted(value.keys(), key=lambda key: key.encode("utf-16-be"))
        return "{" + ",".join(js_quote(k) + ":" + canonical(value[k]) for k in ordered) + "}"
    raise TypeError(f"canonical JSON cannot encode {type(value).__name__}")


def sha256hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    if len(text) % 4 == 1 or not B64URL_RE.match(text):
        raise ValueError("invalid base64url text")
    padded = text + "=" * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


# --------------------------------------------------------------------------
# legality verdict (contract 3.2, fixed order 1..5)
# --------------------------------------------------------------------------


def bad(code: str):
    return {"ok": False, "code": code}


def legality(header, subset):
    category = header.get("category")
    if category not in LEGAL_CATEGORIES:
        return bad("E_LEGALITY")
    schema = header.get("schema") or {}
    if schema.get("name") != SCHEMA_FOR_CATEGORY[category]:
        return bad("E_CATEGORY_MISMATCH")
    if schema.get("version") != "1":
        return bad("E_VERSION")
    allowed = set((subset or {}).get("legalFields") or ())
    fields = header.get("fields") or []
    for name in fields:
        if name not in allowed:
            return bad("E_LEGALITY")
    present = set(fields)
    for name in REQUIRED_FIELDS[category]:
        if name not in present:
            return bad("E_FIELDS_MISSING")
    if len(header.get("keyIds") or []) < 1:
        return bad("E_KEYIDS_EMPTY")
    return {"ok": True}


# --------------------------------------------------------------------------
# envelope verification (contract 3.1: sig -> version -> staleness)
# --------------------------------------------------------------------------


def signing_bytes(envelope) -> bytes:
    return canonical(
        {
            "id": envelope.get("id"),
            "source": envelope.get("source"),
            "type": envelope.get("type"),
            "ts": envelope.get("ts"),
            "version": envelope.get("version"),
            "corrId": envelope.get("corrId"),
            "payload": envelope.get("payload"),
        }
    ).encode("utf-8")


def sign(message: bytes, seed: bytes) -> bytes:
    return Ed25519PrivateKey.from_private_bytes(seed).sign(message)


def verify_signature(signature: bytes, message: bytes, public_key: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
        return True
    except Exception:
        return False


def envelope_verdict(envelope, public_key, now_ms):
    try:
        signature = b64url_decode(envelope.get("sig") or "")
    except Exception:
        return bad("E_SIG")
    if not verify_signature(signature, signing_bytes(envelope), public_key):
        return bad("E_SIG")
    if envelope.get("version") != "0.1":
        return bad("E_VERSION")
    ts = envelope.get("ts")
    if ts > now_ms + MAX_CLOCK_SKEW_MS or ts < now_ms - MAX_ENVELOPE_AGE_MS:
        return bad("E_STALE")
    return {"ok": True}


# --------------------------------------------------------------------------
# driver
# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--now", type=int, required=True)
    parser.add_argument("--vectors", default=str(Path(__file__).with_name("vectors.json")))
    args = parser.parse_args()

    with open(args.vectors, "r", encoding="utf-8") as handle:
        # JSON.parse semantics: every JSON number is an IEEE-754 double.
        document = json.load(handle, parse_int=float, parse_float=float)

    if not HAVE_ED25519:
        sys.stderr.write(
            "run-python.py: cryptography is not importable; "
            "sig/verify are reported as SKIP and are not cross-checked.\n"
        )

    signer = document["signer"]
    seed = b64url_decode(signer["privateKeySeed"])
    public_key = b64url_decode(signer["publicKey"])

    for case in document["cases"]:
        envelope = dict(case["envelope"])
        envelope["ts"] = args.now + case["tsOffsetMs"]

        message = signing_bytes(envelope)
        canon = message.decode("utf-8")
        line = {
            "caseId": case["id"],
            "canonical": canon,
            "sha256hex": sha256hex(canon),
            "b64url": b64url_encode(message),
        }

        if HAVE_ED25519:
            signature = sign(message, seed)
            if "sigOverride" in case:
                effective = case["sigOverride"]
            else:
                effective = b64url_encode(signature)
            envelope["sig"] = effective
            line["sig"] = effective
            line["verify"] = envelope_verdict(envelope, public_key, args.now)
        else:
            line["sig"] = "SKIP"
            line["verify"] = "SKIP"

        line["legal"] = legality(case["header"], case.get("subset", document["defaultSubset"]))
        sys.stdout.write(json.dumps(line, ensure_ascii=True, separators=(",", ":")) + "\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
