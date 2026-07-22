# Shape-to-pattern TDX measurement harness

This directory contains the measurement-only MB-C01 harness for the deterministic Shape-to-pattern matcher. It is isolated under `scripts/` and is not imported by `src/`, `web/`, Vite, the Worker, the snapshot producer, public APIs, journey ranking, rendering, or production telemetry.

The harness creates replayable evidence. It does **not** establish a production guard or authorize production integration. Until real credentialed TDX reports are reviewed, the gate remains:

> C. Temporarily not ready for production integration.

Production PR 2 remains blocked.

## Why snapshot output is not evidence

The snapshot producer has already selected Shapes using index and first-Shape fallback, so it cannot recover the original candidate matrix. This harness reads raw `StopOfRoute` and `Shape` endpoints and preserves all valid records in source-scoped `RouteUID + Direction` partitions. It never uses index pairing, the first candidate, lexical selection, greedy assignment, or snapshot output as measurement evidence.

## Filesystem ownership and cleanup

Raw data, reports, and generated matcher modules have separate, pairwise-disjoint roots:

```text
.tdx-measurement/raw/
.tdx-measurement/reports/
.tdx-measurement/generated/
```

CLI validation rejects overlapping roots, repository-root ownership, protected source paths, ancestor/descendant overlap, and realpath/symlink aliases. Each run creates a unique `run-*` child below the generated root with `mkdtemp()`. Cleanup verifies the real generated root, strict-child relationship, ownership marker, and per-run token before removing only that child. It never recursively removes the generated root, raw cache, report root, or unrelated sentinels.

## Strict raw TDX boundary

The candidate builder validates the original JSON values without coercion:

- `Direction` must be the number `0`, `1`, or `2`; strings and other values are rejected.
- Coordinates must be finite numbers within longitude/latitude ranges.
- A direct Shape with any invalid coordinate is rejected as a whole.
- `StopSequence` must be a unique positive safe integer.
- Stops are ordered by numeric `StopSequence`, with original position as the stable tie-breaker after validation.
- Missing, null, empty, and non-empty identities remain distinct contract states.
- Rejected records retain explicit reasons and aggregate rejection counts.

A malformed record is removed from the matcher input, but a valid record on the opposite side remains available in its one-sided partition. The harness does not erase valid raw candidates merely because a sibling record failed validation.

## Credentials

Live measurement requires TDX member credentials from either:

1. `TDX_CLIENT_ID` and `TDX_CLIENT_SECRET` in the process environment; or
2. the ignored `.dev.vars` file.

There are no secret CLI flags. Token responses, Authorization headers, client IDs, secrets, credential fingerprints, raw response headers, and response bodies are excluded from reports and bounded errors.

## Live fetch and atomic cache publication

```sh
npm run measure:shape-pattern -- \
  --cities Taipei,NewTaipei,Taoyuan,Keelung,Taichung,Tainan,Kaohsiung,Chiayi,MiaoliCounty \
  --include-intercity
```

City endpoints:

- `StopOfRoute/City/{City}`
- `Shape/City/{City}`

InterCity endpoints, fetched once per run:

- `StopOfRoute/InterCity`
- `Shape/InterCity`

Fetches use bounded concurrency, timeout plus `AbortController`, bounded retries, exponential backoff with jitter, and `Retry-After`. The timeout remains active through request, headers, complete body consumption, and JSON parsing. Timers are cleared on success and every failure path. Authentication failures are not retried indefinitely and response bodies are not exposed.

A live cache is assembled in a temporary sibling directory. Endpoint payloads and the manifest are fully written and verified before a same-filesystem rename publishes the final cache. Existing targets and partial caches fail closed.

## Verified offline replay

```sh
npm run measure:shape-pattern -- --replay --raw-dir .tdx-measurement/raw
```

The verified manifest is the replay source of truth for selected cities, InterCity inclusion, endpoint identity, canonical filenames, item counts, endpoint hashes, maximum `UpdateTime`, fetched-at time, and bundle hash. Replay rejects:

- explicit CLI scope that differs from the manifest;
- missing, duplicate, or extra endpoints;
- endpoint identity/filename mismatch;
- path traversal and absolute paths;
- symlinks and non-regular files;
- endpoint content-hash mismatch; and
- bundle metadata/hash mismatch.

Replay does not access credentials or the network.

## Matcher loading and observer instrumentation

Uninstrumented and instrumented matcher modules are loaded once per report run. Source verification, transpilation, and import timings are recorded separately from matcher latency. Warmups and formal iterations invoke the same loaded function.

Instrumented mode:

1. verifies the pinned production matcher Git blob;
2. requires an exact caller-supplied matcher SHA-256;
3. verifies every exact injection anchor occurs once;
4. creates an ignored temporary module only;
5. inserts synchronous observer calls, counters, and monotonic timings;
6. compares instrumented and plain semantic results;
7. requires structural counters to agree across iterations; and
8. removes the generated module during cleanup.

Pair rows are created only from observer events emitted by the production matcher control flow. The report layer does not implement a second geometry normalizer, closure classifier, segment builder, compatibility pass, or Cartesian pair reconstruction.

Projection solves emit matching start/end events for success, no-path, frontier-empty, threshold-rejected, and throw outcomes. End events include non-negative duration. Callback exceptions are contained so matcher semantics complete; the first callback error is retained, cleanup runs, and the measurement then fails with `MEASUREMENT_COLLECTOR_ERROR`. No final report is published after collector failure.

## Timing, memory, and unavailable metrics

Formal iteration timing uses a documented nearest-rank median. Raw iteration samples are retained. Loader timings are excluded from matcher latency.

Memory observations are only process RSS/heap before, after, and delta. The harness does not claim an unobserved peak and does not claim forced garbage collection.

Unavailable values are `null` or absent, never invented zeroes. A summary distribution with count zero has null min/median/percentiles/max. Null values are excluded from percentiles and top-N outliers. In uninstrumented mode `pairs.jsonl` is empty and `pairMetricsAvailable` is false.

## Transactional reports

Each successful mode/run publishes an immutable run directory under the report root. Publication is transactional:

1. create a temporary sibling directory;
2. write the six report files;
3. parse and validate every file;
4. run cross-file reconciliation;
5. calculate each report-file hash;
6. write `completion.json` last; and
7. atomically rename the temporary directory to the final run ID.

The six report files are:

- `metadata.json`
- `partitions.jsonl`
- `pairs.jsonl`
- `outcomes.json`
- `outliers.json`
- `summary.json`

Readers require a valid completion marker and verify all six hashes before returning data. Mid-write failure, validation failure, a stale target, missing completion marker, corruption, duplicate IDs, orphan references, unknown reasons, illegal nulls, range errors, and accounting mismatches fail closed without publishing a mixed directory.

## Determinism

Partition identities, pair identities, outcomes, JSONL ordering, and deterministic content hashes use stable ordering. Timings, memory observations, timestamps, run IDs, and publication metadata are excluded from deterministic content hashes.

## Tests

```sh
npm ci
npm run test:shape-pattern-measurement
npm run check
npm run build
git diff --check
git status --short
```

Committed sanitized tests cover destructive-cleanup boundaries, strict candidate validation, numeric `StopSequence`, verified manifest provenance and path integrity, body-inclusive timeouts, callback containment, failed projection durations, null metrics, load-once timing aggregation, transactional publication, report schema/reconciliation, sanitized replay, and production architecture isolation.

CI does not call live TDX, receive production TDX credentials, or upload raw payloads or real route-level reports.

## Credentialed follow-up

A later credentialed environment must fetch the required nine cities plus InterCity, run uninstrumented and instrumented replay, confirm cleanup and a clean worktree, inspect distributions/outliers, and record an explicit production-gate decision. Synthetic fixtures verify capability and safety only; they must not select a production guard.
