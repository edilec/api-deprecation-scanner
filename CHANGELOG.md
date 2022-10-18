# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a bounded OpenAPI 3.0 / 3.1 reader covering exactly the four fields that
  decide a deprecation — `deprecated`, `x-sunset`, `x-deprecated-since` and
  `x-replacement` — with the operation's `operationId` as the join key. Nothing
  else in a document is read, because nothing else can change those answers;
- an explicit unsupported list for the constructs that *could* change them, each
  reported and each making the run `incomplete` rather than being skipped in
  silence: Swagger 2.0, an OpenAPI version outside 3.0 and 3.1, `webhooks`,
  `components.pathItems`, a `$ref` path item or operation, a `deprecated` flag
  on a path item, and twelve near-miss deprecation extensions (`x-sunset-date`,
  `x-replaced-by`, `x-eol` and the rest). An operation carrying one of those is
  never reported as having no removal date, because the date may be in the very
  key this reader did not interpret;
- a consumer usage inventory that must declare its **coverage** before it
  declares what it saw — the API version it watched, the window it covered, how
  many consumers the source believes exist and where the usage came from — with
  unknown keys refused at every level, so that a `consumersKnwon` cannot turn a
  coverage gap into a green run;
- the join itself: one finding per (deprecated operation, consumer) pair,
  located at the operation, with the consumer, its call count and its last
  observation in the evidence and the documented migration target in the
  suggestion. Five rules split those pairs by phase and activity, from
  `expired-operation-in-use` (error) down to `deprecated-operation-dormant-use`
  (info);
- an **injected clock**. `--now` is required and has no default, and nothing in
  this package reads a system clock: whether an operation has passed its removal
  date is the question being answered, so the instant it is answered at is
  configuration. Three policy windows are measured against it —
  `--active-within-seconds`, `--imminent-window-seconds` and
  `--max-coverage-staleness-seconds` — and a removal date written as a calendar
  day means midnight UTC at the start of that day, the earliest instant it can
  mean, so an operation is never called supported because a date was rounded
  forwards;
- the coverage honesty rules, each an error that makes the run `incomplete`:
  fewer consumers inventoried than the source knows about, a window that ended
  too far behind the clock, usage recorded against another API version. When the
  coverage is complete, an operation nobody called is reported as unused with
  the window and consumer count stated in the evidence; when it is short in any
  way, the same silence is reported as `...-usage-unknown` instead;
- announcement rules over the document alone: no removal date, no replacement, a
  removal date announced without the deprecated flag, a removal date that
  precedes its own announcement, a replacement that names an operation the
  document does not declare, and a replacement that is itself deprecated;
- strict UTF-8 decoding with `TextDecoder('utf-8', { fatal: true })` on both
  inputs, and ISO-8601 UTC instants validated against the calendar
  arithmetically, so `2026-02-31` and `24:00:00` are refused rather than rolled
  silently forward;
- real-path confinement on both sides for both inputs, and a **device and inode**
  comparison to refuse two names for one file. A hard link has no target, so two
  names for one inode are two different real paths and a real-path comparison
  says they are different files — which is how a sibling tool in this catalog
  destroyed its own input;
- explicit file-byte, JSON-depth, operation, consumer, call, per-consumer-call,
  named-consumer, finding and wall-clock limits, each reported by name when hit
  and each making the run `incomplete` instead of truncating in silence;
- sanitisation of every untrusted string that reaches output — operation ids,
  consumer ids, path templates, JSON pointers, coverage sources, contacts,
  messages and suggestions as well as `evidence`, and an unknown CLI option on
  its way to stderr — covering C0 and DEL, the whole C1 range (U+0085 NEL forges
  a line of its own, U+009B is the 8-bit CSI), U+2028 and U+2029, and the bidi
  and isolate controls U+200E, U+200F, U+202A–U+202E and U+2066–U+2069, which are
  also refused inside an identifier. Ordinary right-to-left letters are
  untouched: they carry their own direction and need no override;
- a CLI with `--help`, `--version`, `--json`, three policy flags and nine limit
  flags, the report on stdout, diagnostics on stderr, exit codes 0 / 1 / 2 with
  an empty stdout for a configuration error and an `incomplete` report for
  evidence that could not be obtained, and a repeated value-carrying flag
  refused instead of silently overwriting the earlier value;
- runnable `examples/clean`, `examples/broken` and `examples/incomplete` roots
  that exit 0, 1 and 2 at the documented clock;
- the rule catalog, both schemas, the supported OpenAPI subset, the coverage
  rules, the ordering rule, the limits and the exit codes in
  `docs/deprecation-rules.md`, and an honest "Limits and non-goals" in the
  README.

### Fixed

- a consumer contact containing `@` is refused unread rather than copied into a
  report that gets piped, logged and pasted. A contact names a team or a
  channel; the people are in your own directory.
- `no-deprecated-operations` is no longer claimed for a walk that stopped
  early. The join's loops break on an exhausted `--max-milliseconds` budget,
  and a run whose first pass broke skipped the second pass entirely — leaving
  `deprecated` at zero, which the caller read as an answer and reported as
  "None of the 2 operation(s) read from this document is marked deprecated"
  for a document in which one of them was. The run was `incomplete` and exited
  2, but the false claim was in the JSON on stdout. The claim is now made only
  when the walk finished and examined something;
- the evidence on `deprecated-operation-unused` says how many consumers were
  actually examined beside how many the source claims to know about. The
  coverage comparison is one-sided on purpose, so the two numbers may
  disagree, and reporting only the source's number read as "all 0 known
  consumer(s)" for an inventory whose one consumer really had been examined;
- a path template is bounded by the identifier bound itself, once. The second
  clause against a second constant of the same value could not decide a case,
  so the number the message named was never the number enforced.

### Guaranteed

- Nothing in this package opens a socket, reads a wall clock, reads a random
  source, reads the environment or writes a file. A run leaves its root
  byte-identical. `process.hrtime.bigint` is the single time source and is used
  for one budget: it is never printed, never compared with a date, and the only
  thing it can change is turning a completed run into an `incomplete` one.
- `pass` is never reported on evidence that was not obtained. Every site that
  marks a run `incomplete` has a test that isolates it, so removing that flag
  turns exit 2 into exit 1 and fails; no site is backstopped by another, because
  a flag whose removal changes nothing cannot be caught by any test.
- `pass` with `checked: 0` is not reachable, and neither is a pass over an
  inventory with no consumers in it.
- Every finding takes its severity from one frozen `ruleId -> severity` table;
  an unknown rule id throws, and the table is asserted against the documented
  catalog in both directions. Those are declarations, and a coordinated edit
  agrees with itself, so severity is also pinned by behaviour: the seven error
  rules whose severity alone decides the verdict are pinned by the process exit
  code, the other thirty-seven — which also mark the run incomplete and so exit
  2 either way — by literal inline error counts and printed severity words in a
  file that shares no map, no table import and no parameterised expectation with
  anything else, and all ten non-error rules by runs that must exit 0.
- No wall clock, locale-aware comparison, random source, network access or
  filesystem enumeration order affects the output. All nine call sites that
  order something reaching output are named. Seven are pinned by the order they
  emit, using inputs an English collator orders the other way round; the other
  two order closed alphabets this package declares, where no fixture can tell
  the comparators apart, and are proved equivalent by enumerating every ordered
  pair — an enumeration that fails the moment a value is added in an alphabet
  where the two could differ.
- An inventory cannot show that nothing calls an operation, and this tool does
  not claim otherwise. `README.md` and `docs/deprecation-rules.md` both state
  what a `pass` does and does not mean.

### Verified by breaking it

- Each of the nine ordering call sites was swapped to a collator, one at a
  time, and the suite run against the mutant: seven failed a test. The two that
  did not are equivalent mutants over closed alphabets -- output byte-identical,
  every ordered pair enumerated -- and not gaps.
- Each of the 44 error rules was demoted to `warning` in both the frozen table
  and the documented catalog at once: 44 of 44 were caught. Promoting each of
  the 10 non-error rules to `error` caught 10 of 10.
- The counts and the method are recorded in `docs/deprecation-rules.md` under
  "How the two fragile guarantees were verified".

No release has been published.
