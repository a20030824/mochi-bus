# Shape-to-pattern TDX measurement harness

This directory is a measurement-only tool for the MB-C01 Shape-to-pattern matcher. It exists because production integration is blocked until real raw TDX distributions, solver latency, memory, projection-frontier width, assignment ambiguity cost, and Direction 2 outcomes are measured.

The harness is intentionally isolated under `scripts/`. It is not imported by `src/`, `web/`, Vite, the Worker, the snapshot producer, or public APIs.

## Why snapshot output is not evidence

The current snapshot producer pairs `StopOfRoute` and `Shape` records by an index and then falls back to the first Shape. That destroys the original candidate matrix. This harness fetches raw `StopOfRoute` and `Shape` endpoints and preserves every pattern and Shape inside source-scoped `RouteUID + Direction` partitions. It never uses `shapes[index]`, `shapes[0]`, a lexical first candidate, greedy pairing, or an existing snapshot result.

## Credentials

Live measurement requires TDX member credentials. Credentials are read only from:

1. `TDX_CLIENT_ID` and `TDX_CLIENT_SECRET` in the process environment; or
2. the repository's ignored `.dev.vars` file.

There are deliberately no `--client-id`, `--client-secret`, or `--token` flags. The token response, Authorization header, client ID, secret, credential fingerprint, raw response headers, and response bodies are never written to reports or errors.

## Live fetch

```sh
npm run measure:shape-pattern -- \
  --cities Taipei,NewTaipei,Taoyuan,Keelung,Taichung,Tainan,Kaohsiung,Chiayi,MiaoliCounty \
  --include-intercity
```

Raw payloads are written below `.tdx-measurement/raw/`, which is ignored by Git. City requests use:

- `StopOfRoute/City/{City}`
- `Shape/City/{City}`

InterCity is fetched once per run from:

- `StopOfRoute/InterCity`
- `Shape/InterCity`

Fetches use bounded concurrency, timeout + AbortController, bounded retries, exponential backoff with jitter, and `Retry-After` handling. Progress output contains only endpoint category, city, phase, and timestamp.

## Offline replay

```sh
npm run measure:shape-pattern -- --replay --raw-dir .tdx-measurement/raw
```

Replay verifies every endpoint content hash and the complete bundle hash before matcher execution. It does not make a network request. The same raw payload and matcher revision produce the same non-timing partition, outcome, and content-hash data; latency and memory fields are explicitly excluded from the deterministic content hash.

## Uninstrumented and instrumented modes

Uninstrumented mode transpiles the production TypeScript matcher source into an ignored temporary ES module and executes it without source modification. It measures complete matcher/partition wall time, process RSS, heap use, and outcomes.

Instrumented mode creates a temporary copy only. It never edits the production matcher. The loader:

1. reads `src/domain/map/shape-pattern-matcher.ts`;
2. verifies the pinned Git blob revision;
3. computes the source SHA-256 and requires an exact caller-supplied expected SHA-256;
4. verifies every exact injection anchor occurs once;
5. inserts only synchronous counters, monotonic timestamps, bounded numeric accumulators, and a callback hook;
6. transpiles and imports the ignored temporary copy;
7. deep-compares instrumented and uninstrumented results; and
8. removes the temporary source in `finally`, including when the callback throws.

Obtain the expected hash from the checked-out source, review it against the intended matcher revision, then run:

```sh
MATCHER_SHA256="$(node -e \"const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync('src/domain/map/shape-pattern-matcher.ts')).digest('hex'))\")"
npm run measure:shape-pattern -- \
  --replay \
  --instrumented \
  --expected-matcher-sha256 "$MATCHER_SHA256"
```

A source hash mismatch, Git blob mismatch, or missing/duplicated anchor fails closed as an unsupported matcher revision. The loader never guesses an insertion point with a fuzzy regular expression and never produces a partial instrumented report.

Instrumented counters cover projection candidate count, per-layer frontier width, peak frontier width, retained nodes, parent-node count, approximate path-key bytes, forward/reverse orientation time, cost/span projection solve time, geometry pair time, best/forced-match/forced-unmatched assignment solve counts and time, and active-mask/state peak.

## Outputs

A successful run writes:

- `metadata.json`
- `partitions.jsonl`
- `pairs.jsonl`
- `outcomes.json`
- `outliers.json`
- `summary.json`

`metadata.json` records repository SHA, matcher SHA-256 and Git blob, harness version, Node/OS/CPU/memory information, selected cities, endpoint hashes, maximum TDX `UpdateTime`, mode, warmups, and iterations. It never contains credentials, tokens, headers, raw payloads, or URLs with secrets.

`partitions.jsonl` records source scope, city, `RouteUID`, Direction, candidate sizes, identity diagnostics, assignment/ambiguity timing, outcomes, and memory observations. Exact compatible-edge count and density require instrumented mode; uninstrumented records them as `null` rather than inventing values that the public matcher result does not expose.

`pairs.jsonl` records every geometry-scoring attempt. Instrumented runs additionally record whether each attempt was compatible plus internal projection/frontier/path/solver counters and timing; uninstrumented mode leaves `compatible` as `null` rather than inferring matcher-internal outcomes.

`summary.json` uses a tested nearest-rank percentile algorithm for count, min, median, p75, p90, p95, p99, and max. `outliers.json` retains the configured top N, not a single maximum.

## Privacy and cleanup

All live raw data, generated matcher copies, complete reports, and route-level debug material remain below the ignored directory:

```text
.tdx-measurement/raw/
.tdx-measurement/generated/
.tdx-measurement/reports/
```

The harness deletes generated matcher copies after execution. To remove all local artifacts:

```sh
rm -rf .tdx-measurement
```

Before committing or pushing, verify:

```sh
git status --short
git check-ignore -v .tdx-measurement/raw/example.json
git diff --check
```

The working tree must contain no raw payload, token response, generated matcher, report output, or secret.

## Tests

```sh
npm run test:shape-pattern-measurement
npm run test -- src/domain/map/shape-pattern-matcher.test.ts src/domain/map/shape-pattern-matcher.options.test.ts
npm run check
```

CI runs only sanitized fixtures, candidate/report/redaction/replay/instrumentation tests, and architecture isolation. CI does not call live TDX, receive TDX production credentials, or upload raw payloads or real route-level reports.

## Production PR 2 readiness

This harness only creates measurement capability. It does not establish a production guard or authorize integration.

After a credentialed environment runs both modes on the required cities and InterCity, review at minimum:

- partition and compatible-edge distributions;
- stops, coordinates, segments, frontier width, retained nodes, and path-key allocation;
- pair, partition, best-assignment, and ambiguity-proof latency;
- RSS and heap distributions;
- Direction 2 truly closed / near-closed / open outcomes, identity/geometry successes, sibling ambiguity, and fail-closed unresolved rates.

Synthetic fixtures may verify correctness and instrumentation safety, but must not set production guards. PR 2 remains blocked until the real reports are reviewed and a bounded policy is justified. Any later integration must still forbid index, first-candidate, lexical, greedy, or snapshot-result fallback.
