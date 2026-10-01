import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool, migrate, transaction } from "./db.js";
import { buildApp } from "./app.js";
import { hashPassword } from "./security.js";
import { settleResources, reserveResources } from "./quotas.js";
import { desiredObject } from "./instance-contract.js";
import type { KubernetesPort } from "./kubernetes.js";

test(
  "project quotas serialize admission, preserve failed/retained reservations and fence edits",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = createPool(process.env.TEST_DATABASE_URL!);
    const database = `quota_${randomUUID().replaceAll("-", "")}`;
    await root.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = "/" + database;
    const pool = createPool(url.toString());
    const origin = "http://localhost:5173";
    const app = await buildApp(pool, {
      origin,
      secureCookies: false,
      kube: {} as KubernetesPort,
      encryptionKey: Buffer.alloc(32, 1),
      storageClass: "fixture",
    });
    try {
      await migrate(pool);
      const admin = randomUUID(),
        viewer = randomUUID(),
        outsider = randomUUID(),
        project = randomUUID();
      const password = "quota-test-password",
        passwordHash = await hashPassword(password);
      for (const [id, elevated] of [
        [admin, true],
        [viewer, false],
        [outsider, false],
      ])
        await pool.query(
          "INSERT INTO users(id,email,password_hash,platform_admin) VALUES($1,$2,$3,$4)",
          [id, `${id}@example.test`, passwordHash, elevated],
        );
      await pool.query(
        "INSERT INTO projects(id,name,namespace,state,created_by) VALUES($1,'Quota','quota-test','ready',$2)",
        [project, admin],
      );
      await pool.query(
        "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')",
        [project, viewer],
      );
      const login = async (id: string) => {
        const response = await app.inject({
          method: "POST",
          url: "/v1/auth/login",
          headers: { origin },
          payload: { email: `${id}@example.test`, password },
        });
        assert.equal(response.statusCode, 200, response.body);
        return {
          origin,
          cookie: `expbuild_session=${response.cookies[0]!.value}`,
          "x-csrf-token": response.json().csrfToken as string,
        };
      };
      const headers = await login(admin),
        viewHeaders = await login(viewer),
        foreign = await login(outsider);
      const path = `/v1/projects/${project}/quota`,
        instances = `/v1/projects/${project}/instances`;
      const limits = {
        instances: 1,
        storageGiB: 5,
        cpuMillis: 1000,
        memoryMiB: 1024,
      };
      const read = async () =>
        (await app.inject({ url: path, headers })).json();
      const put = async (
        value: typeof limits | Record<string, number | null>,
        revision: string,
      ) =>
        app.inject({
          method: "PUT",
          url: path,
          headers: { ...headers, "if-match": revision },
          payload: value,
        });
      assert.equal(
        (await app.inject({ url: path, headers: foreign })).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url: path, headers: viewHeaders })).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: path,
            headers: { ...viewHeaders, "if-match": "1" },
            payload: limits,
          })
        ).statusCode,
        403,
      );
      assert.equal((await put(limits, "1")).statusCode, 200);
      assert.equal(
        (await put(limits, "1")).statusCode,
        409,
        "stale quota edit rejected",
      );
      const input = {
        name: "cache",
        template: "bazel-remote" as const,
        storageGiB: 3,
        cacheGiB: 1,
        cpuMillis: 500,
        memoryMiB: 512,
        desiredState: "Running" as const,
        deletionPolicy: "Retain" as const,
        exposure: "ClusterInternal" as const,
      };
      const create = (key: string) =>
        app.inject({
          method: "POST",
          url: instances,
          headers: { ...headers, "idempotency-key": key },
          payload: input,
        });
      const concurrent = await Promise.all([
        create("quota-create-a"),
        create("quota-create-b"),
      ]);
      assert.deepEqual(concurrent.map((x) => x.statusCode).sort(), [202, 409]);
      const success = concurrent.findIndex((x) => x.statusCode === 202),
        id = concurrent[success].json().operation.instance_id;
      assert.equal(
        (await create(success === 0 ? "quota-create-a" : "quota-create-b"))
          .statusCode,
        202,
        "idempotency replay is not charged again",
      );
      assert.deepEqual((await read()).reserved, {
        instances: 1,
        storageGiB: 3,
        cpuMillis: 500,
        memoryMiB: 512,
      });
      assert.equal(
        Number(
          (await pool.query("SELECT count(*) FROM instance_bindings")).rows[0]
            .count,
        ),
        1,
        "rejected admission rolls back binding",
      );
      assert.equal(
        (await put({ ...limits, storageGiB: 2 }, "2")).statusCode,
        409,
        "cannot lower limits below usage",
      );
      await pool.query(
        "UPDATE instance_bindings SET lifecycle='failed' WHERE id=$1",
        [id],
      );
      assert.equal(
        (await create("quota-create-c")).statusCode,
        409,
        "failed provision may still own resources",
      );
      // Update reservations use the high-water mark until confirmed settlement.
      await transaction(pool, async (client) => {
        await client.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
          project,
        ]);
        await reserveResources(client, project, id, {
          storageGiB: 4,
          cpuMillis: 900,
          memoryMiB: 900,
        });
      });
      assert.equal((await read()).reserved.cpuMillis, 900);
      for (const changes of [
        { cpuMillis: 1001, memoryMiB: 900 },
        { cpuMillis: 900, memoryMiB: 1025 },
      ]) {
        await assert.rejects(
          transaction(pool, async (client) => {
            await client.query(
              "SELECT id FROM projects WHERE id=$1 FOR UPDATE",
              [project],
            );
            await reserveResources(client, project, id, {
              storageGiB: 4,
              ...changes,
            });
          }),
          /quota exceeded/,
        );
      }
      await transaction(pool, async (client) => {
        await client.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
          project,
        ]);
        await reserveResources(client, project, id, {
          storageGiB: 4,
          cpuMillis: 500,
          memoryMiB: 512,
        });
      });
      assert.equal(
        (await read()).reserved.cpuMillis,
        900,
        "pending CPU reduction does not release reservations",
      );

      await assert.rejects(
        transaction(pool, async (client) => {
          await client.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
            project,
          ]);
          await reserveResources(client, project, id, {
            storageGiB: 6,
            cpuMillis: 900,
            memoryMiB: 900,
          });
        }),
        /quota exceeded: storageGiB/,
      );
      assert.equal(
        (await read()).reserved.storageGiB,
        4,
        "failed expansion rolls back",
      );
      await transaction(pool, async (client) => {
        await client.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
          project,
        ]);
        await settleResources(
          client,
          id,
          desiredObject(
            input,
            project,
            "quota-test",
            id,
            "fixture",
            randomUUID(),
            "hash",
          ),
        );
      });
      assert.deepEqual(
        (await read()).reserved,
        { instances: 1, storageGiB: 4, cpuMillis: 500, memoryMiB: 512 },
        "successful CPU reduction releases CPU but storage stays reserved",
      );
      await pool.query(
        "UPDATE instance_bindings SET lifecycle='detached' WHERE id=$1",
        [id],
      );
      assert.deepEqual((await read()).reserved, {
        instances: 0,
        storageGiB: 4,
        cpuMillis: 0,
        memoryMiB: 0,
      });
      assert.equal(
        (await create("quota-create-d")).statusCode,
        409,
        "retained volume still uses storage quota",
      );
      await pool.query(
        "UPDATE instance_bindings SET lifecycle='deleted' WHERE id=$1",
        [id],
      );
      assert.equal(
        (await create("quota-create-e")).statusCode,
        202,
        "confirmed cleanup releases storage",
      );
      const before = await read();
      assert.equal(
        (await put({ ...limits, instances: 0 }, before.revision)).statusCode,
        409,
      );
      await pool.query(
        "UPDATE instance_bindings SET reserved_storage_gib=NULL WHERE lifecycle<>'deleted'",
      );
      assert.equal((await read()).unknownReservations, 1);
      assert.equal(
        (await put(limits, before.revision)).statusCode,
        409,
        "unknown usage is never presented as zero",
      );
      assert.equal(
        (
          await put(
            {
              instances: null,
              storageGiB: null,
              cpuMillis: null,
              memoryMiB: null,
            },
            before.revision,
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM audit_events WHERE action='quota.update'",
          )
        ).rows[0].count,
        "2",
      );
      // Simulate an upgrade of the existing schema with historical desired specs.
      const retainedId = (
        await pool.query(
          "SELECT id FROM instance_bindings WHERE lifecycle <> 'deleted'",
        )
      ).rows[0].id;
      await pool.query(
        "UPDATE operations SET state='failed' WHERE instance_id=$1",
        [retainedId],
      );
      const expanded = desiredObject(
        { ...input, storageGiB: 8, cpuMillis: 1500 },
        project,
        "quota-test",
        retainedId,
        "fixture",
        randomUUID(),
        "history",
      );
      await pool.query(
        "INSERT INTO operations(id,project_id,instance_id,kind,idempotency_key,request_hash,request,state,created_by) VALUES($1,$2,$3,'instance.update','historical-update','history',$4,'failed',$5)",
        [
          randomUUID(),
          project,
          retainedId,
          JSON.stringify({ desired: expanded }),
          admin,
        ],
      );
      await pool.query(
        "ALTER TABLE projects DROP COLUMN quota_limits, DROP COLUMN quota_revision",
      );
      await pool.query(
        "ALTER TABLE instance_bindings DROP COLUMN reserved_storage_gib, DROP COLUMN reserved_cpu_millis, DROP COLUMN reserved_memory_mib",
      );
      await pool.query(
        "DELETE FROM schema_migrations WHERE name='005_project_quotas.sql'",
      );
      await migrate(pool);
      await migrate(pool);
      assert.deepEqual(
        (await read()).reserved,
        { instances: 1, storageGiB: 8, cpuMillis: 1500, memoryMiB: 512 },
        "migration reserves the historical maximum including failed operations",
      );
    } finally {
      await app.close();
      await pool.end();
      await root.query(`DROP DATABASE "${database}"`);
      await root.end();
    }
  },
);
