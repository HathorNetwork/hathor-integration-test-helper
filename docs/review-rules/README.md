# Review rules

Machine-readable conventions that this repository enforces in code
review. Each Markdown file in this directory (except this one) is a
single rule. A review-agent — or a human reviewer — can iterate over
the rules, decide which ones apply to the files changed in a PR, and
act on them mechanically.

## Discovery convention

> Every `*.md` file in `docs/review-rules/` other than `README.md` is
> a rule.

There is no manifest file to keep in sync. Adding a rule means
dropping a new file in this directory. Removing a rule means deleting
its file.

## File format

Each rule file has YAML frontmatter followed by a Markdown body. The
schema:

### Frontmatter

| Field               | Required | Type            | Meaning                                                          |
| ------------------- | -------- | --------------- | ---------------------------------------------------------------- |
| `id`                | yes      | slug            | Stable identifier; MUST equal the filename without `.md`.        |
| `title`             | yes      | string          | One-line human-readable summary.                                 |
| `severity`          | yes      | `must`/`should` | `must` blocks the PR. `should` leaves a comment.                 |
| `applies-to`        | yes      | list of globs   | The rule is evaluated only when at least one changed file matches. |
| `rationale-summary` | yes      | string          | One-sentence "why", short enough to quote in a review comment.   |

The two-level severity is intentional. `must` means "this is a hard
requirement; do not merge without fixing." `should` means "the
reviewer will leave a comment, the author may push back." Anything
finer invites bikeshedding.

### Body

Every rule body has these four sections, in order:

- `## Rule` — the precise statement, preferably with a regex,
  schema, or other mechanical predicate the agent can apply.
- `## Why` — the rationale at length. Include the threat model or
  failure mode being prevented; this is what makes the rule
  defensible against future "let's just add an exception" pressure.
- `## How to check` — the algorithm. Concrete enough that a script
  could implement it.
- `## How to fix` — the remediation steps the author should take.

## Agent loop

```
for file in pr.changed_files:
    for rule in load_rules("docs/review-rules/"):
        if any(fnmatch(file.path, glob) for glob in rule.applies_to):
            evaluate(rule, file)
```

Anything more sophisticated belongs in the rule body, not in the
agent's outer loop.

## Adding a rule

1. Create `docs/review-rules/<slug>.md` with the frontmatter and
   four body sections above.
2. Pick `severity: must` only if violating the rule could cause a
   security, correctness, or supply-chain incident. Everything else
   is `should`.
3. Reference the new rule from the project's `CLAUDE.md` only when
   it materially changes how contributors should write code; the
   discovery convention above means the rule is already visible to
   any review-agent without an extra registration step.

## Current rules

- [`dependency-pinning`](dependency-pinning.md) — Pin all dependency
  versions to defend against supply-chain attacks via floating
  semver ranges.
- [`github-actions-pinning`](github-actions-pinning.md) — Pin every
  `uses:` reference in workflows and composite actions to a
  40-character commit SHA with a `# <version>` comment, so mutable
  tags cannot be re-pointed at malicious code.
- [`no-guards-on-local-wallet-reads`](no-guards-on-local-wallet-reads.md)
  — Don't wrap local wallet reads (`getUtxos` over synced storage) in
  timeout/abort/retry machinery; they can't hang.
- [`reservation-release-on-failure`](reservation-release-on-failure.md)
  — Release every UTXO reservation on every failure path; `reservedSet`
  leaks never self-heal.
