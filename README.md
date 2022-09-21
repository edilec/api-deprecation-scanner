# api-deprecation-scanner

Read a versioned OpenAPI document and a consumer usage inventory, and link the
deprecated operations to the consumers actually calling them — with the
announced removal date and the documented replacement.

The headline it exists for: **an active consumer is still calling an operation
whose removal date has already passed.** That is an error, it fails the run, and
the finding names the consumer, the date and where to send them instead.

- **Repository:** [edilec/api-deprecation-scanner](https://github.com/edilec/api-deprecation-scanner)
- **License:** MIT
- **Runtime:** Node 22 or later, no dependencies

## Install

```sh
npm install api-deprecation-scanner
```

Or run it from a checkout with no install step at all — the package has no
runtime and no development dependencies.

## Use

```sh
api-deprecation-scanner --root examples/clean --now 2026-06-05T00:00:00Z
api-deprecation-scanner --root examples/broken --now 2026-06-05T00:00:00Z --json | jq '.findings[].ruleId'
```

The JSON report goes to stdout and nothing else does, so stdout pipes straight
into a parser. The human summary and every diagnostic go to stderr; `--json`
suppresses the summary.

```
spec openapi.json: 6 operation(s) read, 3 deprecated, 0 past their removal date at 2026-06-05T00:00:00Z.
inventory usage.json: 4 consumer(s), 5 call(s) read, 0 entr(ies) not evaluated, 0 coverage gap(s).
join: 3 deprecated-operation/consumer link(s), 0 where an active consumer calls an operation past its removal date. status pass.
WARNING openapi.json/paths/~1v1~1invoices/get deprecated-operation-in-use Operation "listInvoicesV1" (GET /v1/invoices) is deprecated and is removed at 2026-12-01T00:00:00Z; it is still being called. [consumer billing-portal; 41203 call(s); last seen 2026-05-30T11:02:00Z; owner revenue-platform]
```

As a library:

```js
import { scanDeprecations, exitCodeFor, formatReport } from 'api-deprecation-scanner'

const report = await scanDeprecations({ root: 'examples/broken', now: '2026-06-05T00:00:00Z' })
process.stderr.write(formatReport(report, { now: '2026-06-05T00:00:00Z' }))
process.exitCode = exitCodeFor(report)
```

### `--now` is required, and that is the point

Whether an operation has passed its removal date is the question this tool
answers, so the instant it is answered at is **configuration**. Nothing in this
package reads a system clock. Two people scanning the same two files on
different days get the same report unless one of them says otherwise, a CI run
from last month can be reproduced exactly, and a test can stand an operation one
millisecond either side of its own sunset without waiting for a calendar.

### Exit codes

| Exit | Meaning | stdout |
| ---: | --- | --- |
| `0` | scanned, and no covered consumer calls an operation past its removal date | the report |
| `1` | scanned, and at least one error-severity rule fired | the report |
| `2` | invalid configuration or bad usage | **empty** |
| `2` | evidence that could not be obtained; status `incomplete` | the report |

A consumer that pipes stdout must handle an empty stdout on exit 2. A
configuration error means the run never had a subject, so there is nothing to
report about; unreadable or incomplete evidence means the run had a subject and
failed to learn something about it, and the report says which.

## The two inputs

A **versioned OpenAPI document** — 3.0 or 3.1 — whose deprecated operations
carry the announcement:

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Billing API", "version": "2.4.0" },
  "paths": {
    "/v1/invoices": {
      "get": {
        "operationId": "listInvoicesV1",
        "deprecated": true,
        "x-deprecated-since": "2026-01-15",
        "x-sunset": "2026-12-01T00:00:00Z",
        "x-replacement": {
          "operationId": "listInvoices",
          "since": "2.2.0",
          "docs": "https://docs.example.test/billing/migrations/invoices"
        }
      }
    }
  }
}
```

A **consumer usage inventory**, which says what it covers before it says what it
saw:

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

`consumersKnown` is how many consumers your source believes exist, whether or
not you listed them. State the real number even when it is larger than the
number you listed — that difference is the whole point of the field, and it is
what turns "nobody calls this" into "nobody among the four I looked at".

Both documents are decoded with `TextDecoder('utf-8', { fatal: true })`, and an
unknown key anywhere in the inventory is refused rather than ignored: a
`consumersKnwon` that is silently dropped turns a coverage gap into a green run.

## What the report says

One finding per **(deprecated operation, consumer)** pair, located at the
operation in the document, with the consumer, its call count and its last
observation in the evidence, and the migration target in the suggestion. Nothing
is aggregated away — the question a deprecation scan has to answer is "who do I
have to talk to", and a count does not answer it.

The rule depends on two things the injected clock decides: whether the removal
date has passed, and whether the consumer is still active.

| | active consumer | dormant consumer |
| --- | --- | --- |
| **past its removal date** | `expired-operation-in-use` (error) | `expired-operation-dormant-use` (warning) |
| **removed soon** | `sunset-imminent-operation-in-use` (warning) | `deprecated-operation-dormant-use` (info) |
| **deprecated** | `deprecated-operation-in-use` (warning) | `deprecated-operation-dormant-use` (info) |

And when nobody was seen calling it, the coverage decides the answer:

| coverage | finding |
| --- | --- |
| complete | `deprecated-operation-unused` / `expired-operation-unused`, with the window and consumer count stated |
| short in any way | `deprecated-operation-usage-unknown` / `expired-operation-usage-unknown` (error), run `incomplete` |

The full catalog of 54 rules, the supported OpenAPI subset, the coverage rules
and every limit are in [`docs/deprecation-rules.md`](./docs/deprecation-rules.md).

## Limits and non-goals

**It cannot conclude that nothing calls an operation.** It can conclude that no
consumer *in the inventory* called it *during the declared window*. A consumer
absent from the inventory is unknown, not safe. That is why the coverage block
is required, why it is validated as strictly as the usage, and why any shortfall
in it is an error that makes the run `incomplete` rather than a quiet pass.

**It cannot tell you an operation is safe to delete.** It can give you the
numbers that decision needs: who called it, how often, how recently, out of how
many consumers, over what window, from what source. Whether that is enough is a
judgement about your own risk, and the tool does not make it for you.

**It cannot see traffic.** It reads an inventory somebody else produced. An
inventory that under-reports produces an under-reported answer and this tool has
no way to notice.

**It does not validate an OpenAPI document.** There is no OpenAPI library here
and there is not going to be one. The reader implements the bounded subset that
decides whether an operation is deprecated, when it is removed and what replaces
it. It reads no schema, resolves no `$ref` and checks no request or response
shape — and a construct that *could* hide one of those four answers is reported
as unsupported and makes the run `incomplete`, never treated as satisfied:
Swagger 2.0, an OpenAPI version outside 3.0 and 3.1, `webhooks`,
`components.pathItems`, a `$ref` path item or operation, a `deprecated` flag on
a path item, and any of twelve near-miss deprecation extensions such as
`x-sunset-date` or `x-replaced-by`.

**It is not a policy engine.** It reports what the two documents say together.
It has no opinion about how long a deprecation period should be, beyond
reporting a removal date that precedes its own announcement.

**It does not check that the replacement is equivalent.** It checks that the
replacement exists in the same document and is not itself deprecated. Whether it
does the same job is not visible in a schema.

**It opens no socket, reads no clock, reads no environment variable and writes
no file.** A run leaves its root byte-identical. `process.hrtime.bigint` is used
for one thing, the `--max-milliseconds` budget, and the only outcome it can
change is turning a completed run into an `incomplete` one.

## Determinism

Running twice over identical bytes with the same `--now` produces byte-identical
stdout. Findings sort by `location.file`, `location.pointer`, `ruleId`,
`message`, then `evidence` — every comparison by UTF-16 code unit, never by
locale collation, because collation depends on ICU data that differs between
Node builds and treats punctuation as ignorable.

## Development

```sh
npm run check     # lint, test, example, pack:check
npm test
npm run test:coverage
```

No install step is required and no dependency is added. Lint is `node --check`
over every file in the package.

## License

MIT. See [LICENSE](./LICENSE).
