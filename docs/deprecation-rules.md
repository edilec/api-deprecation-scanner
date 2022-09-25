# Rule catalog, schemas, the supported OpenAPI subset and limits

`api-deprecation-scanner` reads two documents and reports what they say
together. It opens no socket, so every conclusion it reaches is a statement
about the bytes it was given and the instant it was given as `--now`.

- [What this tool can and cannot conclude](#what-this-tool-can-and-cannot-conclude)
- [The supported OpenAPI subset](#the-supported-openapi-subset)
- [The usage inventory](#the-usage-inventory)
- [The injected clock and the policy windows](#the-injected-clock-and-the-policy-windows)
- [How coverage is decided](#how-coverage-is-decided)
- [Rule catalog](#rule-catalog)
- [Report, ordering and exit codes](#report-ordering-and-exit-codes)
- [Limits](#limits)

## What this tool can and cannot conclude

**It can conclude that a named consumer called a deprecated operation.** That
is a join between two documents, and it is exact: the inventory names the
consumer, the count and the last observation; the document names the removal
date and the replacement.

**It can conclude that a removal date has passed.** Against `--now`, which is
configuration. It never reads a system clock, so two people scanning the same
files on different days get the same answer unless one of them says otherwise.

**It cannot conclude that nothing calls an operation.** The inventory covers
the consumers it covers, over the window it covers, for the API version it was
watching. A consumer absent from it is *unknown*. Where the declared coverage
is complete, absence is reported as `deprecated-operation-unused` with the
window and the consumer count stated in the evidence, and that claim is bounded
by exactly those numbers. Where the coverage is short in any way, absence is
reported as `deprecated-operation-usage-unknown` -- an error -- and the run is
`incomplete`.

**It cannot see traffic.** It reads an inventory somebody else produced. An
inventory that under-reports produces an under-reported answer, and this tool
has no way to notice; that is why the coverage block is required and validated
as strictly as the usage.

**It cannot tell you that an operation is safe to delete.** It can tell you
that no covered consumer called it during the covered window. Whether that is
enough is a decision about your own risk, and the report gives you the numbers
that decision needs rather than making it for you.

**It does not validate an OpenAPI document.** It reads the fields that decide
deprecation, removal and replacement. It reads no schema, resolves no `$ref`,
and checks no request or response shape. A construct that could hide one of
those four answers is reported as unsupported, never skipped silently.

## The supported OpenAPI subset

There is no OpenAPI library here and no dependency of any kind. The reader
implements exactly this much, and declares the rest.

| Read | Where |
| --- | --- |
| `openapi` | `3.0.x` and `3.1.x` only |
| `info.version` | the API version the scan is about |
| `info.title` | printed in the summary, sanitised |
| `paths.<template>.<method>` | `delete`, `get`, `head`, `options`, `patch`, `post`, `put`, `trace` |
| `operationId` | the join key with the inventory |
| `deprecated` | must be a JSON boolean |
| `x-sunset` | ISO-8601 UTC instant, or a calendar day meaning midnight UTC |
| `x-deprecated-since` | same format; only used to check it precedes `x-sunset` |
| `x-replacement` | an `operationId` string, or `{ operationId, since, docs }` |

Everything else in the document -- schemas, parameters, responses, security,
servers, callbacks, tags -- is not read. Reading none of it is safe precisely
because none of it can change whether an operation is deprecated, when it is
removed or what replaces it.

These constructs **could** change one of those answers and are not supported.
Each is reported and makes the run `incomplete`:

| Construct | Rule |
| --- | --- |
| Swagger 2.0 (`swagger` key) | `spec-version-unsupported` |
| an `openapi` version outside 3.0 and 3.1 | `spec-version-unsupported` |
| `webhooks` (OpenAPI 3.1) | `spec-construct-unsupported` |
| `components.pathItems` | `spec-construct-unsupported` |
| a `$ref` path item or a `$ref` operation | `spec-construct-unsupported` |
| `deprecated` on a path item | `spec-construct-unsupported` |
| a near-miss deprecation extension | `sunset-extension-unrecognised` |

The near-miss list is fixed and is checked on every operation:
`x-deprecated-at`, `x-deprecation`, `x-deprecation-date`, `x-end-of-life`,
`x-eol`, `x-removal-date`, `x-removed-at`, `x-replaced-by`, `x-replacedBy`,
`x-successor`, `x-sunset-date`, `x-sunsetDate`. There is no registry for any of
these and every gateway spells the idea differently, so a spelling this reader
does not implement is reported as possibly holding the removal date rather than
ignored. An operation carrying one is never reported as having no removal date.

## The usage inventory

```json
{
  "schemaVersion": "1",
  "coverage": {
    "apiVersion": "2.4.0",
    "windowStart": "2026-03-01T00:00:00Z",
    "windowEnd": "2026-06-01T00:00:00Z",
    "consumersKnown": 4,
    "source": "gateway-access-log"
  },
  "consumers": [
    {
      "id": "billing-portal",
      "contact": "revenue-platform",
      "calls": [
        { "operationId": "listInvoicesV1", "count": 41203, "lastSeen": "2026-05-30T11:02:00Z" }
      ]
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | must be `"1"` |
| `coverage.apiVersion` | yes | the API version the usage was observed against; must match `info.version` |
| `coverage.windowStart` | yes | full ISO-8601 UTC instant; a calendar day is not precise enough |
| `coverage.windowEnd` | yes | full ISO-8601 UTC instant, after the start |
| `coverage.consumersKnown` | yes | how many consumers the source believes exist, listed or not |
| `coverage.source` | no | where the usage came from, 1–200 characters |
| `consumers[].id` | yes | printable identifier, 1–200 characters |
| `consumers[].contact` | no | a team or a channel. Never an address: a value containing `@` is refused |
| `consumers[].calls[].operationId` | yes | the operationId exactly as the document spells it |
| `consumers[].calls[].count` | yes | integer of at least 1; zero is not a call, omit the entry |
| `consumers[].calls[].lastSeen` | yes | full ISO-8601 UTC instant |

An unknown key at any level is refused rather than ignored. A `consumersKnwon`
that is silently dropped turns "three of twelve consumers were examined" into
"all known consumers were examined", which is a green run built on a typo.

`consumersKnown` is the field that makes this tool honest, and it is required
for that reason. State the number your source knows about even when it is
larger than the number you listed -- that difference is the whole point.

## The injected clock and the policy windows

`--now` is required and has no default. Three windows are measured against it:

| Window | Default | Decides |
| --- | ---: | --- |
| `--active-within-seconds` | 2592000 (30 days) | a consumer last seen this recently is **active** |
| `--imminent-window-seconds` | 2592000 (30 days) | a removal date this close is **imminent** |
| `--max-coverage-staleness-seconds` | 604800 (7 days) | how far behind `--now` the coverage window may end |

An operation is **expired** when its `x-sunset` instant is at or before `--now`.
A calendar-day `x-sunset` means midnight UTC at the start of that day, which is
the earliest instant the day can mean, so an operation is never reported as
still supported because the tool rounded its removal date forwards.

`process.hrtime.bigint` is used for one thing: the `--max-milliseconds` budget.
It is a monotonic counter, never printed, never compared with a date, and the
only thing it can change is turning a run that would have completed into one
that reports `time-limit-exceeded` and `incomplete`. A run that finishes inside
its budget is byte-identical every time.

## How coverage is decided

Coverage is complete when all four of these hold:

1. `coverage.apiVersion` equals the document's `info.version`;
2. the inventory lists at least `coverage.consumersKnown` consumers;
3. `coverage.windowEnd` is no further behind `--now` than the staleness
   allowance;
4. every consumer and every call entry compiled -- nothing was refused, no
   limit cut the walk short, every call named an operation the document
   declares, and the inventory is not empty.

Each of the first three raises its own error and makes the run `incomplete`.
The fourth is already flagged elsewhere -- by the declared-versus-compiled check
on the inventory, by `usage-operation-unknown`, and by
`no-consumers-inventoried` -- so it contributes to the coverage decision
without a second flag of its own. A flag backstopped by another flag is a flag
whose removal no test can catch.

Complete coverage is what licenses `deprecated-operation-unused` and
`expired-operation-unused`. Without it, the same silence is reported as
`deprecated-operation-usage-unknown` or `expired-operation-usage-unknown`.

## Rule catalog

Severity is taken from one frozen `ruleId -> severity` table in
`src/index.mjs`; an unknown rule id throws. This catalog is asserted against
that table in both directions. That is a check on the documentation, not the
pin on severity: the rules whose severity alone decides the verdict are pinned
by running the real binary and asserting the process exit code, and the rest by
asserting the error count and the printed severity word with literal values.

### The join

| ruleId | severity | What it reports |
| --- | --- | --- |
| `expired-operation-in-use` | error | an active consumer calls an operation past its removal date |
| `expired-operation-dormant-use` | warning | a consumer called an operation past its removal date, but not recently |
| `expired-operation-unused` | warning | an operation is past its removal date and no covered consumer called it |
| `expired-operation-usage-unknown` | error | the same silence, under coverage that is not complete |
| `sunset-imminent-operation-in-use` | warning | an active consumer calls an operation removed inside the imminent window |
| `deprecated-operation-in-use` | warning | an active consumer calls a deprecated operation |
| `deprecated-operation-dormant-use` | info | a consumer called a deprecated operation, but not recently |
| `deprecated-operation-unused` | info | no covered consumer called a deprecated operation in the declared window |
| `deprecated-operation-usage-unknown` | error | the same silence, under coverage that is not complete |
| `no-deprecated-operations` | info | the document was read and nothing in it is deprecated |

### The deprecation announcement

| ruleId | severity | What it reports |
| --- | --- | --- |
| `sunset-undeclared` | warning | a deprecated operation announces no removal date |
| `sunset-without-deprecation` | warning | a removal date is announced on an operation that is not marked deprecated |
| `sunset-invalid` | error | `x-sunset` or `x-deprecated-since` is not a real ISO-8601 UTC instant or day |
| `sunset-before-deprecation` | error | the removal date precedes the announcement, so consumers got no notice |
| `sunset-extension-unrecognised` | error | a near-miss extension that may hold the removal date or the replacement |
| `deprecated-flag-invalid` | error | `deprecated` is present and is not a JSON boolean |
| `replacement-undeclared` | warning | a deprecated operation names no replacement |
| `replacement-invalid` | error | `x-replacement` is malformed, so the migration target was not read |
| `replacement-unknown-operation` | error | the replacement names an operationId this document does not declare |
| `replacement-also-deprecated` | error | the replacement is itself deprecated |

### The document

| ruleId | severity | What it reports |
| --- | --- | --- |
| `spec-invalid` | error | the document, `info`, `paths` or a path item has the wrong shape |
| `spec-version-unsupported` | error | Swagger 2.0, or an OpenAPI version outside 3.0 and 3.1 |
| `spec-construct-unsupported` | error | webhooks, `components.pathItems`, a `$ref`, or `deprecated` on a path item |
| `operation-invalid` | error | an operation declares no usable `operationId` |
| `operation-duplicate` | error | one `operationId` is declared more than once |
| `no-operations` | error | the document declares no operations at all |

### The inventory

| ruleId | severity | What it reports |
| --- | --- | --- |
| `inventory-invalid` | error | the inventory, its `schemaVersion` or its `consumers` has the wrong shape |
| `inventory-key-unknown` | error | the inventory, a consumer, a call or the coverage block declares an unknown key |
| `coverage-invalid` | error | the coverage block is missing or one of its fields has the wrong shape |
| `coverage-consumers-incomplete` | error | fewer consumers are inventoried than the source knows about |
| `coverage-window-stale` | error | the coverage window ended further behind `--now` than the allowance |
| `coverage-version-mismatch` | error | the usage was observed against a different API version |
| `consumer-invalid` | error | a consumer entry, its contact or its `calls` has the wrong shape |
| `consumer-duplicate` | error | one consumer id appears more than once |
| `call-invalid` | error | a call entry, its `count` or its `lastSeen` has the wrong shape |
| `call-duplicate` | error | one consumer declares the same operation more than once |
| `call-observed-after-clock` | error | a call was observed after `--now` |
| `call-outside-coverage-window` | error | a call was observed outside the window the inventory declares |
| `usage-operation-unknown` | error | a call names an operationId the document does not declare |
| `no-consumers-inventoried` | error | the inventory lists no consumers at all |
| `identifier-invalid` | error | a path template, operationId or consumer id is not a printable identifier |

### Inputs and limits

| ruleId | severity | What it reports |
| --- | --- | --- |
| `input-unreadable` | error | an input could not be inspected, resolved or read |
| `input-not-utf8` | error | an input is not valid UTF-8 and was not parsed |
| `input-not-json` | error | an input decoded but is not JSON |
| `input-too-large` | error | an input is above `maxFileBytes` and was not read |
| `input-too-deep` | error | an input nests deeper than `maxJsonDepth` and was not read |
| `inputs-same-file` | error | `--spec` and `--inventory` are two names for one inode |
| `path-escapes-root` | error | an input resolves outside `--root` and was refused unread |
| `too-many-operations` | error | the document holds more operations than `maxOperations` |
| `too-many-consumers` | error | the inventory holds more consumers than `maxConsumers` |
| `too-many-calls` | error | the inventory holds more call entries than `maxCalls` |
| `too-many-calls-for-consumer` | error | one consumer holds more call entries than `maxCallsPerConsumer` |
| `too-many-findings` | error | the run produced more findings than `maxFindings` |
| `time-limit-exceeded` | error | the join ran past `maxMilliseconds` and stopped |

## Report, ordering and exit codes

stdout carries the JSON report and nothing else. stderr carries the human
summary and every diagnostic; a non-empty stderr is normal.

Findings are sorted by `location.file`, then `location.pointer`, then `ruleId`,
then `message`, then `evidence` -- every comparison by UTF-16 code unit. No
locale-aware comparison appears anywhere in this package, because collation
depends on ICU data that differs between Node builds and treats punctuation as
ignorable. `test/ordering.test.mjs` names all nine call sites that order
anything reaching output and pins each one by the order it emits.

Two consumers of one operation produce two findings that agree on file,
pointer, rule id and message. That is deliberate: the consumer lives in the
`evidence` field, so the sort key runs all the way to its last comparison on
values an input file chose, and the human report prints the evidence in
brackets after the message so nothing is lost by the split.

| Exit | Meaning | stdout |
| ---: | --- | --- |
| `0` | scanned, and no covered consumer calls an operation past its removal date | the report |
| `1` | scanned, and at least one error-severity rule fired | the report |
| `2` | invalid configuration or bad usage | **empty** |
| `2` | evidence that could not be obtained; status `incomplete` | the report |

## Limits

| Limit | Default | Cap | Exceeded |
| --- | ---: | ---: | --- |
| `maxFileBytes` | 5242880 | 67108864 | `input-too-large` |
| `maxJsonDepth` | 50 | 200 | `input-too-deep` |
| `maxOperations` | 2000 | 20000 | `too-many-operations` |
| `maxConsumers` | 2000 | 50000 | `too-many-consumers` |
| `maxCalls` | 50000 | 500000 | `too-many-calls` |
| `maxCallsPerConsumer` | 2000 | 50000 | `too-many-calls-for-consumer` |
| `maxConsumersNamed` | 5 | 100 | the evidence list says `(+N more)` |
| `maxMilliseconds` | 10000 | 600000 | `time-limit-exceeded` |
| `maxFindings` | 1000 | 20000 | `too-many-findings` |

Every one of them is enforced and tested from both sides of the bound. An
unknown limit name throws rather than being ignored, and every limit that cuts
a walk short makes the run `incomplete` rather than truncating in silence.

## How the two fragile guarantees were verified

Both of these have been satisfied by tests that looked like coverage and were
not, elsewhere in this catalog. So both were verified by breaking the code and
counting what the suite noticed, rather than by asserting that the code says
the right thing.

### Ordering

Nine call sites in this package order something that reaches output. Each one
was swapped, one at a time, to a comparator built from `Intl.Collator('en')` --
constructed without the literal text `Intl.`, so that the source-scan boundary
check in `test/guarantees.test.mjs` could not be what caught it -- and the whole
suite was run against the mutant.

| Site | Where | Failing tests |
| --- | --- | ---: |
| the unknown-key walk | `validateBounded` | 2 |
| the printed list of known names | `validateBounded` | **0** |
| the unknown-option walk | `scanDeprecations` | 1 |
| `compareFindings` 1: `location.file` | `compareFindings` | 2 |
| `compareFindings` 2: `location.pointer` | `compareFindings` | 2 |
| `compareFindings` 3: `ruleId` | `compareFindings` | **0** |
| `compareFindings` 4: `message` | `compareFindings` | 2 |
| `compareFindings` 5: `evidence` | `compareFindings` | 3 |
| the consumer list in a coverage gap | `describeCoverageGaps` | 2 |

Seven of the nine are pinned by a failing test. The two that are not are the
two whose alphabets this package declares rather than reads from a file, and
they are **equivalent mutants** rather than gaps: over the 54 rule ids (2862
ordered pairs) and the 9 limit names (72 ordered pairs) an English collator
agrees with code-unit order on every pair, and with the collator substituted at
either site the tool's output over all three example roots plus the three
rejection messages is **byte-identical**. `test/ordering.test.mjs` enumerates
those pairs, so the day a rule id or a limit name is added in an alphabet where
the two comparators could differ, that test fails and says the comparison has
become observable and needs a fixture of its own.

### Severity

Each of the 44 error rules was flipped to `warning` in **both** places a
declaration lives -- the frozen `RULE_SEVERITY` table and the catalog above --
and the suite was run against the coordinated edit.

**44 of 44 were caught. None survived.** The same exercise in the other
direction, promoting each of the 10 non-error rules to `error`, caught 10 of 10.

Seven of the error rules are caught by the process exit code alone, because
their severity is the only thing standing between the run and exit 0:
`expired-operation-in-use`, `replacement-unknown-operation`,
`replacement-also-deprecated`, `replacement-invalid`, `sunset-before-deprecation`,
`call-observed-after-clock` and `call-outside-coverage-window`. The other
thirty-seven also mark the run `incomplete`, so they exit 2 whichever severity
they carry; those are caught by `test/severity-word.test.mjs`, which asserts the
literal error count, the literal warning count and the literal severity word
printed in the human report, inline at each assertion, in a file that imports no
table, reads no catalog and shares no expectation with anything else.
