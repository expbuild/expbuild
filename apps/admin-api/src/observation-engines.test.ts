import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Backend,
  ObservationAlerts,
  ObservationLogs,
} from "./observation-backends.js";

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}
async function ready(url: string, failed: () => string | undefined) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const error = failed();
    if (error) throw new Error(error);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error("Backend readiness timeout: " + (failed() ?? url));
}
function launch(binary: string, args: string[]) {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "",
    error: Error | undefined;
  child.on("error", (e) => {
    error = e;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (b) => {
      logs = (logs + b.toString()).slice(-8192);
    });
  return {
    failed: () =>
      error?.message ??
      (child.exitCode !== null ? logs || "Backend exited" : undefined),
    stop: async () => {
      if (error || child.exitCode !== null) return;
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await stopped;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
const project = "project-a",
  uid = "instance-a";
const labels = (projectId = project, instanceUID = uid) => ({
  expbuild_cluster_id: "primary",
  expbuild_project_id: projectId,
  expbuild_instance_uid: instanceUID,
});

test(
  "real Alertmanager filters projects, restricts silences and handles recovery",
  { skip: !process.env.ALERTMANAGER_BIN, timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "expbuild-alertmanager-")),
      listen = await port(),
      base = `http://127.0.0.1:${listen}`;
    const config = join(directory, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        route: {
          receiver: "discard",
          group_wait: "0s",
          group_interval: "1s",
          repeat_interval: "1m",
        },
        receivers: [{ name: "discard" }],
      }),
    );
    const process = launch(globalThis.process.env.ALERTMANAGER_BIN!, [
      `--config.file=${config}`,
      `--storage.path=${directory}/data`,
      `--web.listen-address=127.0.0.1:${listen}`,
      "--cluster.listen-address=",
      "--log.level=error",
    ]);
    try {
      await ready(base + "/-/ready", process.failed);
      const startsAt = new Date(Date.now() - 60_000).toISOString(),
        endsAt = new Date(Date.now() + 3600_000).toISOString();
      const alerts = [
        labels(),
        labels("foreign-project"),
        labels(project, "instance-b"),
      ].map((l) => ({
        labels: { ...l, alertname: "FixtureAlert", severity: "warning" },
        annotations: { summary: "Isolated fixture" },
        startsAt,
        endsAt,
      }));
      assert.equal(
        (
          await fetch(base + "/api/v2/alerts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(alerts),
          })
        ).status,
        200,
      );
      const client = new ObservationAlerts(new Backend(base));
      const own = await client.read(project, uid);
      assert.equal(own.length, 1);
      assert.equal((await client.read(project)).length, 2);
      const silence = await client.silence(
        project,
        uid,
        own[0]!.fingerprint,
        5,
      );
      assert.ok(silence.silenceID);
      assert.equal((await client.read(project, uid))[0]!.state, "suppressed");
      assert.equal(
        (await client.read(project, "instance-b"))[0]!.state,
        "active",
      );
      await assert.rejects(
        client.silence("foreign-project", "instance-b", own[0]!.fingerprint, 5),
      );
      const silences = (await (
        await fetch(base + "/api/v2/silences")
      ).json()) as {
        matchers: { name: string; isRegex: boolean; value: string }[];
      }[];
      assert.equal(silences.length, 1);
      assert.equal(silences[0]!.matchers.length, 4);
      assert.ok(silences[0]!.matchers.every((m) => !m.isRegex));
      assert.equal(
        (
          await fetch(base + "/api/v2/alerts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify([
              {
                ...alerts[0],
                endsAt: new Date(Date.now() - 1000).toISOString(),
              },
            ]),
          })
        ).status,
        200,
      );
      assert.equal((await client.read(project, uid)).length, 0);
    } finally {
      await process.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "real Loki stores and queries UID-scoped logs with redaction and time limits",
  { skip: !process.env.LOKI_BIN, timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "expbuild-loki-")),
      listen = await port(),
      grpc = await port(),
      base = `http://127.0.0.1:${listen}`;
    const config = join(directory, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        auth_enabled: false,
        server: {
          http_listen_address: "127.0.0.1",
          http_listen_port: listen,
          grpc_listen_address: "127.0.0.1",
          grpc_listen_port: grpc,
          log_level: "error",
        },
        common: {
          instance_addr: "127.0.0.1",
          path_prefix: directory,
          storage: {
            filesystem: {
              chunks_directory: directory + "/chunks",
              rules_directory: directory + "/rules",
            },
          },
          replication_factor: 1,
          ring: { kvstore: { store: "inmemory" } },
        },
        schema_config: {
          configs: [
            {
              from: "2024-01-01",
              store: "tsdb",
              object_store: "filesystem",
              schema: "v13",
              index: { prefix: "index_", period: "24h" },
            },
          ],
        },
        analytics: { reporting_enabled: false },
      }),
    );
    const process = launch(globalThis.process.env.LOKI_BIN!, [
      `-config.file=${config}`,
    ]);
    try {
      await ready(base + "/ready", process.failed);
      const stamp = `${Date.now() - 1000}000000`;
      const streams = [
        {
          stream: labels(),
          values: [
            [
              stamp,
              '{"level":"error","message":"owned","password":"secret with spaces"}',
            ],
          ],
        },
        {
          stream: labels("foreign-project"),
          values: [[stamp, "foreign-project-content"]],
        },
        {
          stream: labels(project, "replacement-uid"),
          values: [[stamp, "replacement-content"]],
        },
      ];
      assert.equal(
        (
          await fetch(base + "/loki/api/v1/push", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ streams }),
          })
        ).status,
        204,
      );
      const client = new ObservationLogs(new Backend(base));
      const target = {
        projectId: project,
        instanceUID: uid,
        namespace: "project-ns",
        template: "gradle-http",
        version: "0.2.0",
      };
      const result = await client.read(target, 15, "error");
      assert.equal(result.items.length, 1);
      assert.ok(result.items[0]!.text.includes("owned"));
      assert.ok(!JSON.stringify(result).includes("secret with spaces"));
      assert.ok(!JSON.stringify(result).includes("foreign-project-content"));
      assert.equal(
        (await client.read({ ...target, instanceUID: "unseen" }, 15)).state,
        "no_data",
      );
    } finally {
      await process.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
