import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  Backend,
  ObservationMetrics,
  ObservationLogs,
  ObservationAlerts,
  sanitizeLog,
} from "./observation-backends.js";
import { Telemetry } from "./telemetry.js";
import { ObservationCollector } from "./observation-store.js";
import { buildApp } from "./app.js";
import { createPool, migrate } from "./db.js";
import { digest } from "./security.js";
import { desiredObject, instanceInput } from "./instance-contract.js";
import type { KubernetesPort } from "./kubernetes.js";
import { AlertReconciliation } from "./alert-reconciliation.js";

const project = randomUUID(),
  uid = randomUUID(),
  target = {
    projectId: project,
    instanceUID: uid,
    namespace: "project-test",
    template: "gradle-http",
    version: "0.2.0",
  };
test("metric queries are scoped, counter-aware, bounded and preserve no-data/zero distinctions", async () => {
  const requests: URL[] = [];
  const backend = new Backend(
    "https://metrics.example.test/prefix",
    undefined,
    async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      assert.equal(url.pathname, "/prefix/api/v1/query_range");
      const query = url.searchParams.get("query")!;
      assert.ok(query.includes(`expbuild_project_id="${project}"`));
      assert.ok(query.includes(`expbuild_instance_uid="${uid}"`));
      assert.ok(query.includes('expbuild_cluster_id="primary"'));
      const end = Number(url.searchParams.get("end"));
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              {
                metric: { series: "get_hit" },
                values: [
                  [end - 60, "0"],
                  [end, "NaN"],
                ],
              },
            ],
          },
        }),
      );
    },
  );
  const metrics = new ObservationMetrics(backend);
  const result = await metrics.read(target, "lookups", "1h");
  assert.equal(result.state, "ok");
  assert.deepEqual(
    result.series[0]?.points.slice(-2).map((p) => p[1]),
    [0, null],
  );
  assert.ok(
    requests[0]!.searchParams
      .get("query")!
      .includes("rate(expbuild_cache_lookups_total"),
  );
  const before = requests.length;
  assert.equal(
    (
      await metrics.read(
        { ...target, template: "webdav-apache" },
        "lookups",
        "1h",
      )
    ).state,
    "unsupported",
  );
  assert.equal(requests.length, before);
  await assert.rejects(
    metrics.read(
      { ...target, instanceUID: '"} or vector(1)' },
      "capacity",
      "1h",
    ),
  );
  const empty = new ObservationMetrics(
    new Backend(
      "https://metrics.test",
      undefined,
      async () =>
        new Response(
          JSON.stringify({
            status: "success",
            data: { resultType: "matrix", result: [] },
          }),
        ),
    ),
  );
  assert.equal((await empty.read(target, "capacity", "1h")).state, "no_data");
});
test("backends reject redirects, unbounded data, warnings and forged log ownership", async () => {
  assert.throws(() => new Backend("http://user:password@metrics.test"));
  assert.throws(() => new Backend("http://metrics.test?query=secret"));
  const redirects = new Backend(
    "https://metrics.test",
    undefined,
    async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return new Response("", { status: 302 });
    },
  );
  await assert.rejects(redirects.request("api/v1/query"));
  const oversized = new Backend(
    "https://metrics.test",
    undefined,
    async () => new Response("x".repeat(1024 * 1024 + 1)),
  );
  await assert.rejects(oversized.request("query"));
  const logs = new ObservationLogs(
    new Backend(
      "https://logs.test",
      undefined,
      async () =>
        new Response(
          JSON.stringify({
            status: "success",
            data: {
              resultType: "streams",
              result: [
                { stream: { expbuild_project_id: randomUUID() }, values: [] },
              ],
            },
          }),
        ),
    ),
  );
  await assert.rejects(logs.read(target, 15), /ownership/);
  assert.ok(
    !sanitizeLog(
      "Authorization=Bearer secret-value password=abc token=xyz",
    ).includes("secret-value"),
  );
  assert.ok(!sanitizeLog("password=abc token=xyz").includes("abc"));
  assert.ok(
    !sanitizeLog('{"password":"secret with spaces","token":"a b"}').includes(
      "with spaces",
    ),
  );
});

test(
  "real PostgreSQL observations, role checks, original UID history, webhook and silences",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = createPool(process.env.TEST_DATABASE_URL!),
      database = `expbuild_obs_${randomUUID().replaceAll("-", "")}`;
    await root.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${database}`;
    const pool = createPool(url.toString());
    const connectionsEnded: Promise<void>[] = [];
    pool.on("connect", (client) => {
      connectionsEnded.push(
        new Promise((resolve) => client.once("end", resolve)),
      );
    });
    const projectId = randomUUID(),
      instanceId = randomUUID(),
      instanceUID = randomUUID(),
      admin = randomUUID(),
      viewer = randomUUID(),
      stranger = randomUUID();
    const origin = "http://localhost:5173",
      scrape = "scrape-secret-".repeat(4),
      webhook = "webhook-secret-".repeat(4);
    const telemetry = new Telemetry();
    let backendCalls = 0,
      readFailure = false;
    const external = new Backend(
      "https://monitor.example.test",
      undefined,
      async (input, init) => {
        backendCalls++;
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/silences")) {
          const body = JSON.parse(String(init?.body));
          assert.deepEqual(
            body.matchers.map((m: { name: string }) => m.name),
            [
              "expbuild_cluster_id",
              "expbuild_project_id",
              "expbuild_instance_uid",
              "alertname",
            ],
          );
          assert.ok(
            body.matchers.every((m: { isRegex: boolean }) => !m.isRegex),
          );
          return new Response(JSON.stringify({ silenceID: randomUUID() }));
        }
        if (path.endsWith("/alerts"))
          return new Response(
            JSON.stringify([
              {
                fingerprint: "aa11",
                labels: {
                  expbuild_cluster_id: "primary",
                  expbuild_project_id: projectId,
                  expbuild_instance_uid: instanceUID,
                  alertname: "ExpbuildInstanceNotReady",
                  severity: "warning",
                },
                annotations: { summary: "Check the operation timeline" },
                startsAt: new Date().toISOString(),
                endsAt: new Date(Date.now() + 3600000).toISOString(),
                status: { state: "active" },
              },
            ]),
          );
        if (path.includes("loki"))
          return new Response(
            JSON.stringify({
              status: "success",
              data: { resultType: "streams", result: [] },
            }),
          );
        return new Response(
          JSON.stringify({
            status: "success",
            data: { resultType: "matrix", result: [] },
          }),
        );
      },
    );
    const object = desiredObject(
      instanceInput.parse({
        name: "Cache",
        template: "gradle-http",
        storageGiB: 3,
        cacheGiB: 1,
      }),
      projectId,
      "project-test",
      instanceId,
      "standard",
      randomUUID(),
      "hash",
    );
    object.metadata.uid = instanceUID;
    object.metadata.generation = 1;
    object.status = {
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "ProtocolReady",
          observedGeneration: 1,
        },
      ],
    };
    const kube = {
      getInstance: async () => object,
      readStatistics: async () => {
        if (readFailure) throw new Error("private backend failure");
        return {
          source: "gradle-http-status" as const,
          observedAt: new Date().toISOString(),
          usedBytes: 0,
          capacityBytes: 1024,
          itemCount: 0,
          reservedBytes: null,
          uncompressedBytes: null,
        };
      },
    } as KubernetesPort & { readStatistics: () => Promise<any> };
    const app = await buildApp(pool, {
      origin,
      secureCookies: false,
      telemetry,
      metricsToken: scrape,
      observability: {
        metrics: new ObservationMetrics(external),
        logs: new ObservationLogs(external),
        alerts: new ObservationAlerts(external),
        webhookToken: webhook,
      },
    });
    const collector = new ObservationCollector(pool, kube, telemetry);
    try {
      await migrate(pool);
      await migrate(pool);
      for (const [id, elevated] of [
        [admin, true],
        [viewer, false],
        [stranger, false],
      ] as const)
        await pool.query(
          "INSERT INTO users(id,email,password_hash,platform_admin) VALUES($1,$2,$3,$4)",
          [id, `${id}@example.test`, "unused", elevated],
        );
      await pool.query(
        "INSERT INTO projects(id,name,namespace,state,created_by) VALUES($1,'Project','project-test','ready',$2)",
        [projectId, admin],
      );
      await pool.query(
        "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')",
        [projectId, viewer],
      );
      await pool.query(
        "INSERT INTO instance_bindings(id,project_id,resource_name,kubernetes_uid,lifecycle,created_by,template_name,template_version,display_name) VALUES($1,$2,$3,$4,'active',$5,'gradle-http','0.2.0','Cache')",
        [instanceId, projectId, object.metadata.name, instanceUID, admin],
      );
      const headers = async (id: string) => {
        const token = randomUUID();
        await pool.query(
          "INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
          [digest(token), id, digest("csrf")],
        );
        return {
          origin,
          cookie: `expbuild_session=${token}`,
          "x-csrf-token": "csrf",
        };
      };
      const ah = await headers(admin),
        vh = await headers(viewer),
        sh = await headers(stranger),
        base = `/v1/projects/${projectId}`,
        ip = `${base}/instances/${instanceId}/observability`;
      assert.equal(
        (await app.inject({ url: "/internal/metrics" })).statusCode,
        401,
      );
      assert.equal(
        (await app.inject({ url: "/v1/platform/observability", headers: vh }))
          .statusCode,
        403,
      );
      assert.equal(
        (await app.inject({ url: "/v1/platform/observability", headers: ah }))
          .statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ url: `${ip}/metrics`, headers: sh })).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url: `${ip}/logs`, headers: vh })).statusCode,
        403,
      );
      assert.equal(backendCalls, 0, "denied queries cannot touch data sources");
      assert.equal(
        (
          await app.inject({
            url: `${ip}/metrics?query=vector(1)`,
            headers: vh,
          })
        ).statusCode,
        400,
      );
      await collector.tick();
      let response = await app.inject({
        url: `${base}/observability`,
        headers: vh,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().covered, 1);
      assert.equal(response.json().items[0].payload.phase, "ready");
      assert.equal(response.json().items[0].payload.statistics.usedBytes, 0);
      await collector.tick();
      await collector.tick();
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM observation_events"))
          .rows[0].n,
        1,
        "unchanged conditions do not flood the timeline",
      );
      const followerTelemetry = new Telemetry(),
        follower = new ObservationCollector(pool, kube, followerTelemetry);
      try {
        assert.equal(await follower.tick(), false);
        assert.match(
          await followerTelemetry.registry.metrics(),
          /expbuild_observation_collector_leader\{[^\n]*\} 0/,
        );
        assert.ok(
          !(await followerTelemetry.registry.metrics()).includes(
            "expbuild_instance_ready{",
          ),
        );
        await collector.close();
        await follower.tick();
        assert.match(
          await followerTelemetry.registry.metrics(),
          /expbuild_observation_collector_leader\{[^\n]*\} 1/,
        );
        assert.ok(
          !(await telemetry.registry.metrics()).includes(
            "expbuild_instance_ready{",
          ),
          "former leader drops its scrape view",
        );
        await follower.close();
        await collector.tick();
        await collector.tick();
      } finally {
        await follower.close();
        followerTelemetry.registry.clear();
      }
      readFailure = true;
      await collector.tick();
      await collector.tick();
      response = await app.inject({
        url: `${base}/observability`,
        headers: vh,
      });
      assert.equal(response.json().items[0].payload.phase, "ready");
      assert.equal(response.json().items[0].dataState, "error");
      response = await app.inject({
        url: "/internal/metrics",
        headers: { authorization: `Bearer ${scrape}` },
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /expbuild_instance_ready\{[^\n]*\} 1/);
      assert.ok(!response.body.includes("private backend failure"));
      await pool.query(
        "UPDATE observation_snapshots SET observed_at=now()-interval '3 minutes'",
      );
      response = await app.inject({
        url: `${base}/observability`,
        headers: vh,
      });
      assert.equal(response.json().items[0].dataState, "stale");
      response = await app.inject({
        url: `${base}/observability/alerts`,
        headers: vh,
      });
      assert.equal(response.json().items[0].instanceId, instanceId);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `${ip}/silences`,
            headers: vh,
            payload: { fingerprint: "aa11", minutes: 60 },
          })
        ).statusCode,
        403,
      );
      response = await app.inject({
        method: "POST",
        url: `${ip}/silences`,
        headers: ah,
        payload: { fingerprint: "aa11", minutes: 60 },
      });
      assert.equal(response.statusCode, 201, response.body);
      const alert = {
        status: "firing",
        fingerprint: "aa11",
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 3600000).toISOString(),
        labels: {
          expbuild_cluster_id: "primary",
          expbuild_project_id: projectId,
          expbuild_instance_uid: instanceUID,
          alertname: "TestAlert",
        },
        annotations: { summary: "password=secret" },
      };
      assert.notEqual(
        (
          await app.inject({
            method: "POST",
            url: "/internal/alerts",
            payload: { alerts: [alert] },
          })
        ).statusCode,
        200,
      );
      for (const status of ["firing", "resolved", "firing"]) {
        response = await app.inject({
          method: "POST",
          url: "/internal/alerts",
          headers: { authorization: `Bearer ${webhook}` },
          payload: { alerts: [{ ...alert, status }] },
        });
        assert.equal(response.statusCode, 200, response.body);
      }
      response = await app.inject({
        url: `${base}/observability/alert-history`,
        headers: vh,
      });
      assert.equal(response.json().items.length, 1);
      assert.equal(response.json().items[0].state, "resolved");
      assert.ok(!response.body.includes("password=secret"));
      await pool.query(
        "UPDATE observation_alerts SET state='firing',ends_at=NULL",
      );
      const missing = new ObservationAlerts(
        new Backend(
          "https://monitor.test",
          undefined,
          async () => new Response("[]"),
        ),
      );
      await new AlertReconciliation(pool, missing).tick();
      const checked = (
        await pool.query(
          "SELECT state,ends_at,active_confirmed,checked_at FROM observation_alerts",
        )
      ).rows[0];
      assert.equal(checked.active_confirmed, false);
      assert.equal(checked.state, "firing");
      assert.equal(checked.ends_at, null);
      assert.ok(
        checked.checked_at,
        "absence is recorded without inventing a resolution time",
      );
      await pool.query(
        "UPDATE instance_bindings SET lifecycle='deleted' WHERE id=$1",
        [instanceId],
      );
      assert.equal(
        (await app.inject({ url: `${ip}/events`, headers: vh })).statusCode,
        200,
        "bound history remains available after deletion",
      );
      await pool.query(
        "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
        [projectId, viewer],
      );
      assert.equal(
        (await app.inject({ url: `${ip}/events`, headers: vh })).statusCode,
        404,
      );
    } finally {
      await collector.close();
      await app.close();
      await pool.end();
      await Promise.all(connectionsEnded);
      await root.query(`DROP DATABASE "${database}"`);
      await root.end();
    }
  },
);
