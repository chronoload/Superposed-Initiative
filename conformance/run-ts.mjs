#!/usr/bin/env node
/**
 * Reference runner + differential comparator for docs/MVP-CONTRACT.md.
 *
 * The TypeScript side uses @superpose/protocol (imported through its source
 * entry, no workspace link required). The Python side (run-python.py) is an
 * independent implementation. No expected outputs live in vectors.json: every
 * field is recomputed by both sides from the same inputs.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  b64urlDecode,
  b64urlEncode,
  canonical,
  isLegal,
  sha256hex,
  signEnvelope,
  verifyEnvelope,
} from "../packages/protocol/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "vectors.json"), "utf8"));
const cases = vectors.cases;

const NOW = Date.now();
const seed = b64urlDecode(vectors.signer.privateKeySeed);
const publicKey = b64urlDecode(vectors.signer.publicKey);
const encoder = new TextEncoder();

function verdictKey(verdict) {
  if (verdict === "SKIP") return "SKIP";
  return verdict.ok ? "ok:true" : `err:${verdict.code}`;
}

function tsSide(c) {
  const draft = {
    id: c.envelope.id,
    source: c.envelope.source,
    type: c.envelope.type,
    ts: NOW + c.tsOffsetMs,
    version: c.envelope.version,
    corrId: c.envelope.corrId,
    payload: c.envelope.payload,
  };
  const message = encoder.encode(canonical(draft));
  const signed = signEnvelope(draft, seed);
  const sig = "sigOverride" in c ? c.sigOverride : signed.sig;
  const envelope = { ...signed, sig };
  return {
    caseId: c.id,
    canonical: canonical(draft),
    sha256hex: sha256hex(message),
    b64url: b64urlEncode(message),
    sig,
    verify: verifyEnvelope(envelope, publicKey),
    legal: isLegal(c.header, c.subset ?? vectors.defaultSubset),
  };
}

function runPython() {
  const python = process.env.PYTHON ?? "python";
  const child = spawnSync(python, [join(here, "run-python.py"), "--now", String(NOW)], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.error) {
    console.error(`CONFORMANCE: FAIL (could not spawn ${python}: ${child.error.message})`);
    process.exit(1);
  }
  if (child.stderr.trim() !== "") process.stderr.write(child.stderr);
  if (child.status !== 0) {
    console.error(`CONFORMANCE: FAIL (python exited ${child.status})`);
    process.exit(1);
  }
  const byId = new Map();
  for (const line of child.stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parsed = JSON.parse(line);
    byId.set(parsed.caseId, parsed);
  }
  return byId;
}

const quiet = process.argv.includes("--quiet");
const tsResults = cases.map((c) => {
  const result = tsSide(c);
  if (!quiet) console.log(JSON.stringify(result));
  return result;
});
const pyResults = runPython();

let mismatches = 0;
let ed25519Skipped = false;

function mismatch(caseId, field, tsValue, pyValue) {
  mismatches += 1;
  console.log(
    `MISMATCH ${caseId} ${field} ts=${JSON.stringify(tsValue)} py=${JSON.stringify(pyValue)}`,
  );
}

for (const result of tsResults) {
  const py = pyResults.get(result.caseId);
  if (py === undefined) {
    mismatch(result.caseId, "missing-in-python", "present", "absent");
    continue;
  }
  for (const field of ["canonical", "sha256hex", "b64url"]) {
    if (result[field] !== py[field]) mismatch(result.caseId, field, result[field], py[field]);
  }
  const sigSkipped = result.sig === "SKIP" || py.sig === "SKIP";
  if (sigSkipped) {
    ed25519Skipped = true;
  } else if (result.sig !== py.sig) {
    mismatch(result.caseId, "sig", result.sig, py.sig);
  }
  if (!sigSkipped) {
    const tsVerify = verdictKey(result.verify);
    const pyVerify = verdictKey(py.verify);
    if (tsVerify !== pyVerify) mismatch(result.caseId, "verify", tsVerify, pyVerify);
  }
  const tsLegal = verdictKey(result.legal);
  const pyLegal = verdictKey(py.legal);
  if (tsLegal !== pyLegal) mismatch(result.caseId, "legal", tsLegal, pyLegal);
}

if (mismatches > 0) {
  console.log(`CONFORMANCE: FAIL (${mismatches} mismatches across ${cases.length} cases)`);
  process.exit(1);
}

console.log(
  `CONFORMANCE: PASS (${cases.length} cases, ed25519=${ed25519Skipped ? "skipped" : "ok"})`,
);
