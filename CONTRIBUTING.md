# Contributing

## Local quality gate

Run before opening a PR:

```bash
bun run check
```

This runs:

1. Typecheck (`bun run typecheck`)
2. Unit tests (`bun run test:unit`)

Editing `docs/openapi.yaml` additionally needs:

```bash
bun run validate:openapi
```

It is kept out of `bun run check` because it fetches the validator over
the network; CI runs it as its own job.

Integration tests are optional locally and require Docker:

```bash
(cd integration && docker compose up -d)
bun run test:integration
```

## Source-of-truth docs (DRY policy)

Keep documentation synchronized without duplication:

1. API schema source of truth: [`docs/openapi.yaml`](docs/openapi.yaml)
2. Human summaries should link to it instead of repeating schemas.

## PR checklist

1. Behavior change covered by tests.
2. `docs/openapi.yaml` updated if the API contract changed — including
   retry/error/readiness behavior, which it documents.
3. Backward compatibility impact noted in PR description.
4. Logs/metrics updated when adding new critical paths.

