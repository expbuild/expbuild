import { test } from "node:test";
import assert from "node:assert/strict";
import { PrometheusHistory } from "./history.js";
const now = 1700000000000,
  end = Math.floor(now / 60000) * 60;
const target = { projectId: "project-1", instanceUID: "uid-1" };
const metric = { kind: "cas", method: "get", status: "hit" };
const body = (result: unknown[]) => ({
  status: "success",
  data: { resultType: "matrix", result },
});
const reader = (value: unknown) =>
  new PrometheusHistory(
    "https://metrics.example.test/prometheus",
    async () => new Response(JSON.stringify(value)),
    () => now,
  );
test("history fixes query scope and preserves missing samples without inventing hit ratios", async () => {
  let called = false;
  const client = new PrometheusHistory(
    "https://metrics.example.test/prometheus",
    async (input, options) => {
      called = true;
      const url = new URL(String(input));
      assert.equal(url.pathname, "/prometheus/api/v1/query_range");
      assert.equal(url.searchParams.get("step"), "60");
      assert.match(
        url.searchParams.get("query")!,
        /expbuild_project_id="project-1",expbuild_instance_uid="uid-1"/,
      );
      assert.match(
        url.searchParams.get("query")!,
        /sum by \(kind, method, status\).*rate\(/,
      );
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal);
      return new Response(
        JSON.stringify(
          body([
            {
              metric,
              values: [
                [end - 60, "2.5"],
                [end, "NaN"],
              ],
            },
          ]),
        ),
      );
    },
    () => now,
  );
  const result = await client.read(target, "1h");
  assert.equal(called, true);
  assert.deepEqual(result.series[0]?.points, [
    [end - 60, 2.5],
    [end, null],
  ]);
  assert.deepEqual((await reader(body([])).read(target, "1h")).series, []);
  await assert.rejects(
    client.read({ ...target, instanceUID: 'x"} or vector(1)' }, "1h"),
  );
});
test("history rejects partial, oversized, duplicate and malformed upstream results", async () => {
  for (const value of [
    { ...body([]), warnings: ["partial response"] },
    body([{ metric: { ...metric, kind: "raw" }, values: [] }]),
    body([{ metric, values: [[end, "-1"]] }]),
    body([{ metric, values: [[end + 1, "1"]] }]),
    body([
      {
        metric,
        values: [
          [end, "1"],
          [end - 60, "1"],
        ],
      },
    ]),
    body([
      { metric, values: [] },
      { metric, values: [] },
    ]),
  ])
    await assert.rejects(reader(value).read(target, "1h"));
  const oversized = new PrometheusHistory(
    "http://localhost",
    async () => new Response("x".repeat(1024 * 1024 + 1)),
  );
  await assert.rejects(oversized.read(target, "1h"), /too large/);
  for (const address of [
    "file:///tmp/data",
    "https://user:password@example.test",
    "https://example.test?query=x",
  ])
    assert.throws(() => new PrometheusHistory(address));
});
