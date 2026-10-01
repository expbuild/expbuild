import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { PrometheusHistory, type History } from "./history.js";
import { Backend, ObservationMetrics } from './observation-backends.js';

test(
  "real Prometheus scrapes authenticated counters and isolates project and CR UID history",
  { skip: !process.env.PROMETHEUS_BIN, timeout: 120000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "expbuild-prometheus-"));
    const auth =
      "Basic " + Buffer.from("fixture:isolated-only").toString("base64");
    const started = Date.now();
    const exporter = createServer((request, response) => {
      if (request.headers.authorization !== auth) {
        response.writeHead(401).end();
        return;
      }
      const multiplier =
        request.url === "/own"
          ? 2
          : request.url === "/other-project"
            ? 200
            : 2000;
      const counter = (((Date.now() - started) / 1000) * multiplier).toFixed(4);
      response.setHeader("Content-Type", "text/plain; version=0.0.4");
      response.end(
        `# TYPE bazel_remote_incoming_requests_total counter\nbazel_remote_incoming_requests_total{kind="cas",method="get",status="hit"} ${counter}\nbazel_remote_incoming_requests_total{kind="cas",method="get",status="miss"} 0\n# TYPE expbuild_cache_lookups_total counter\nexpbuild_cache_lookups_total{outcome="hit"} ${counter}\nexpbuild_cache_lookups_total{outcome="miss"} 0\nexpbuild_instance_used_bytes{source="gradle-http-status"} 0\nexpbuild_instance_statistics_timestamp_seconds{source="gradle-http-status"} ${Date.now()/1000}\n`,
      );
    });
    exporter.listen(0, "127.0.0.1");
    await once(exporter, "listening");
    const sourcePort = (exporter.address() as { port: number }).port;
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const config = join(directory, "prometheus.json");
    await writeFile(
      config,
      JSON.stringify({
        global: { scrape_interval: "1s" },
        scrape_configs: [
          ["own", "project-1", "uid-1"],
          ["other-project", "project-2", "uid-1"],
          ["other-uid", "project-1", "uid-2"],
        ].map(([job, project, uid]) => ({
          job_name: job,
          metrics_path: "/" + job,
          basic_auth: { username: "fixture", password: "isolated-only" },
          static_configs: [
            {
              targets: [`127.0.0.1:${sourcePort}`],
              labels: {
                expbuild_project_id: project,
                expbuild_instance_uid: uid,
                expbuild_cluster_id: 'primary',
              },
            },
          ],
        })),
      }),
      { mode: 0o600 },
    );
    const child = spawn(
      process.env.PROMETHEUS_BIN!,
      [
        "--config.file=" + config,
        "--storage.tsdb.path=" + join(directory, "data"),
        "--storage.tsdb.retention.time=1h",
        "--web.listen-address=127.0.0.1:" + port,
        "--log.level=error",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "",
      spawnError: Error | undefined;
    child.on("error", (e) => {
      spawnError = e;
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (b) => {
        logs = (logs + b.toString()).slice(-8192);
      });
    try {
      const base = `http://127.0.0.1:${port}`;
      let queryNow = Date.now();
      const client = new PrometheusHistory(base, fetch, () => queryNow);
      const targets = [
        { projectId: "project-1", instanceUID: "uid-1" },
        { projectId: "project-2", instanceUID: "uid-1" },
        { projectId: "project-1", instanceUID: "uid-2" },
      ];
      const hit = (h: History) =>
        h.series.find((s) => s.outcome === "hit")?.points.at(-1)?.[1];
      let result: History[] | undefined;
      const deadline = Date.now() + 95000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null)
          throw new Error("Prometheus exited: " + logs);
        try {
          queryNow = Date.now();
          const values = await Promise.all(
            targets.map((t) => client.read(t, "1h")),
          );
          if (values.every((v) => (hit(v) ?? 0) > 0)) {
            result = values;
            break;
          }
        } catch {
          /* Startup and the first aligned range point need real samples. */
        }
        await delay(1000);
      }
      assert.ok(
        result,
        "No positive range samples from real Prometheus: " + logs,
      );
      const own = hit(result[0]!)!;
      assert.ok(
        hit(result[1]!)! > own * 10,
        "other project must not be merged into this instance",
      );
      assert.ok(
        hit(result[2]!)! > own * 100,
        "other CR UID must not be merged into this instance",
      );
      assert.equal(
        result[0]!.series.find((s) => s.outcome === "miss")?.points.at(-1)?.[1],
        0,
        "observed zero stays distinct from missing data",
      );
      assert.deepEqual(
        (
          await client.read(
            { projectId: "project-1", instanceUID: "never-collected" },
            "1h",
          )
        ).series,
        [],
      );
      const observations=new ObservationMetrics(new Backend(base));
      const target={projectId:'project-1',instanceUID:'uid-1',namespace:'project-test',template:'gradle-http',version:'0.2.0'};
      const observationDeadline=Date.now()+65_000;
      while(Date.now()<observationDeadline) {
        const sample=await observations.read(target,'lookups','1h');
        if((sample.series.find(s=>s.name==='get_hit')?.points.at(-1)?.[1]??0)>0)break;
        await delay(500);
      }
      for(const group of ['capacity','lookups','performance','resources'] as const) {
        // The actual PromQL parser checks every preset, including resource joins
        // when this fixture does not have kube-state-metrics installed.
        const values=await observations.read(target,group,'1h');
        if(group==='capacity') assert.equal(values.series.find(s=>s.name==='used_bytes')?.points.at(-1)?.[1],0);
        if(group==='lookups') {
          assert.ok((values.series.find(s=>s.name==='get_hit')?.points.at(-1)?.[1]??0)>0);
          assert.equal(values.series.find(s=>s.name==='get_miss')?.points.at(-1)?.[1],0);
          assert.equal(values.series.find(s=>s.name==='get_hit_ratio')?.points.at(-1)?.[1],100);
        }
      }
      await observations.read({...target,template:'bazel-remote',version:'0.1.0'},'lookups','1h');
      assert.equal((await observations.read({...target,instanceUID:'never-collected'},'capacity','1h')).state,'no_data');
    } finally {
      if (child.exitCode === null && !spawnError) {
        const stopped = once(child, "exit");
        child.kill("SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            stopped,
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                child.kill("SIGKILL");
                void stopped.then(() => resolve());
              }, 5000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      await new Promise<void>((resolve) => exporter.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
