# Contributing

## Local quality gate

Run before opening a PR:

```bash
bun run check
```

This runs:

1. Typecheck (`bun run typecheck`)
2. Unit tests (`bun run test:unit`)

Integration tests are optional locally and require Docker:

```bash
(cd integration && docker compose up -d)
bun run test:integration
```

## Source-of-truth docs (DRY policy)

Keep documentation synchronized without duplication:

1. API schema source of truth: [`docs/OPENAPI.yaml`](docs/OPENAPI.yaml)
2. Agent behavior contract: [`docs/AGENT-CONTRACT.md`](docs/AGENT-CONTRACT.md)
3. Human summaries should link to these files instead of repeating schemas.

## PR checklist

1. Behavior change covered by tests.
2. `docs/OPENAPI.yaml` updated if API contract changed.
3. `docs/AGENT-CONTRACT.md` updated if retry/error/readiness behavior changed.
4. Backward compatibility impact noted in PR description.
5. Logs/metrics updated when adding new critical paths.

