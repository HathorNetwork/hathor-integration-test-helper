import { describe, test, expect, beforeEach } from "bun:test";
import {
  recordHttpRequest,
  recordFundSuccess,
  recordSplit,
  recordRescan,
  getMetricsSnapshot,
  __resetMetricsForTest,
} from "../../src/metrics";

beforeEach(() => __resetMetricsForTest());

describe("metrics", () => {
  test("empty snapshot has empty routes map and zeroed counters", () => {
    expect(getMetricsSnapshot()).toEqual({
      routes: {},
      fundCount: 0,
      staleUtxoRescans: 0,
      splitCount: 0,
      splitFailures: 0,
    });
  });

  test("fund/split/rescan counters appear in the snapshot", () => {
    recordFundSuccess();
    recordSplit(true);
    recordSplit(false);
    recordRescan();
    const snap = getMetricsSnapshot();
    expect(snap.fundCount).toBe(1);
    expect(snap.splitCount).toBe(1);
    expect(snap.splitFailures).toBe(1);
    expect(snap.staleUtxoRescans).toBe(1);
  });

  test("__resetMetricsForTest zeroes the fund counters", () => {
    recordFundSuccess();
    __resetMetricsForTest();
    expect(getMetricsSnapshot().fundCount).toBe(0);
  });

  test("counts requests and averages latency to 2 decimals", () => {
    recordHttpRequest("/x", 200, 10);
    recordHttpRequest("/x", 200, 20);
    expect(getMetricsSnapshot().routes["/x"]).toEqual({
      requests: 2,
      errors: 0,
      avgLatencyMs: 15,
    });
  });

  test("counts errors when status >= 400 (incl. 5xx)", () => {
    recordHttpRequest("/y", 400, 5);
    recordHttpRequest("/y", 500, 5);
    recordHttpRequest("/y", 200, 5);
    expect(getMetricsSnapshot().routes["/y"]?.errors).toBe(2);
    expect(getMetricsSnapshot().routes["/y"]?.requests).toBe(3);
  });

  test("rounds avgLatencyMs to 2 decimals", () => {
    recordHttpRequest("/z", 200, 1);
    recordHttpRequest("/z", 200, 2);
    recordHttpRequest("/z", 200, 4);
    expect(getMetricsSnapshot().routes["/z"]?.avgLatencyMs).toBe(2.33);
  });

  test("tracks multiple routes independently", () => {
    recordHttpRequest("/a", 200, 1);
    recordHttpRequest("/b", 500, 2);
    const snap = getMetricsSnapshot();
    expect(snap.routes["/a"]?.errors).toBe(0);
    expect(snap.routes["/b"]?.errors).toBe(1);
  });
});
