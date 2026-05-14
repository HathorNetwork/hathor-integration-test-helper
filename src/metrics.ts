/**
 * Per-route HTTP metrics. Subset shipping with PR2; the fund-/split-/
 * rescan-specific counters land in their natural PRs (PR4/PR5).
 *
 * Snapshot is exposed via `getMetricsSnapshot` so future `/metrics`
 * route handlers and tests can read counters without reaching into
 * module state directly.
 */

interface RouteMetric {
  requests: number;
  errors: number;
  totalLatencyMs: number;
}

let routeMetrics = new Map<string, RouteMetric>();

function getRouteMetric(route: string): RouteMetric {
  const existing = routeMetrics.get(route);
  if (existing) return existing;
  const fresh: RouteMetric = { requests: 0, errors: 0, totalLatencyMs: 0 };
  routeMetrics.set(route, fresh);
  return fresh;
}

/** Record one HTTP request: bumps the count, adds latency, flags errors. */
export function recordHttpRequest(
  route: string,
  status: number,
  latencyMs: number,
): void {
  const m = getRouteMetric(route);
  m.requests += 1;
  m.totalLatencyMs += latencyMs;
  if (status >= 400) m.errors += 1;
}

export interface RouteSnapshot {
  requests: number;
  errors: number;
  avgLatencyMs: number;
}

export interface MetricsSnapshot {
  routes: Record<string, RouteSnapshot>;
}

/** Point-in-time view of the per-route counters. */
export function getMetricsSnapshot(): MetricsSnapshot {
  const routes: MetricsSnapshot["routes"] = {};
  for (const [route, m] of routeMetrics.entries()) {
    routes[route] = {
      requests: m.requests,
      errors: m.errors,
      avgLatencyMs:
        m.requests === 0
          ? 0
          : Number((m.totalLatencyMs / m.requests).toFixed(2)),
    };
  }
  return { routes };
}

/** Test-only: clear all per-route counters. */
export function __resetMetricsForTest(): void {
  routeMetrics = new Map();
}
