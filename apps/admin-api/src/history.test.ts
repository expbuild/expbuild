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

test('query bearer authentication uses the configured endpoint and never follows redirects', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const token = 'test-only.query-token_123';
  let redirected = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture');
    if (url.pathname === '/redirect/api/v1/query_range') {
      response.writeHead(302, { Location: '/sink' }); response.end(); return;
    }
    if (url.pathname === '/sink') { redirected++; response.end(); return; }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end('denied'); return; }
    assert.equal(url.pathname, '/prometheus/api/v1/query_range');
    assert.equal(request.headers.accept, 'application/json');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body([])));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const client = new PrometheusHistory(origin + '/prometheus', fetch, () => now, { bearerToken: token });
    assert.deepEqual((await client.read(target, '1h')).series, []);
    assert.equal(JSON.stringify(client).includes(token), false);
    for (const bearerToken of [undefined, 'wrong-token']) {
      await assert.rejects(new PrometheusHistory(origin + '/prometheus', fetch, () => now, { bearerToken }).read(target, '1h'), /History unavailable/);
    }
    await assert.rejects(new PrometheusHistory(origin + '/redirect', fetch, () => now, { bearerToken: token }).read(target, '1h'));
    assert.equal(redirected, 0);
    for (const bearerToken of ['', 'Bearer token', 'header\r\ninjection', 'x'.repeat(8193)]) {
      assert.throws(() => new PrometheusHistory(origin, fetch, () => now, { bearerToken }), { message: 'Invalid Prometheus bearer token' });
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
