import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool, migrate, transaction } from "./db.js";
import { ProjectQuotaSync } from "./quota-sync.js";
import { quotaSnapshot } from "./quotas.js";
import { OperationError } from "./errors.js";
import { OperationWorker } from "./worker.js";
import type { KubernetesPort } from "./kubernetes.js";

test(
  "quota reconciliation serializes replicas, reports failures and gates writes without blocking deletion",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = createPool(process.env.TEST_DATABASE_URL!),
      database = "quota_sync_" + randomUUID().replaceAll("-", "");
    await root.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = "/" + database;
    const pool = createPool(url.toString());
    try {
      await migrate(pool);
      const user = randomUUID(),
        project = randomUUID(),
        instance = randomUUID(),
        op = randomUUID();
      await pool.query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'sync@example.test','unused')",
        [user],
      );
      await pool.query(
        "INSERT INTO projects(id,name,namespace,state,created_by) VALUES($1,'Sync','sync-test','ready',$2)",
        [project, user],
      );
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
          enter = resolve;
        }),
        released = new Promise<void>((resolve) => {
          release = resolve;
        });
      let calls = 0,
        mode: "wait" | "pending" | "ready" | "error" = "wait";
      const revisions: string[] = [];
      const sync = new ProjectQuotaSync(pool, {
        ensureProjectQuota: async (_ns, _id, revision) => {
          calls++;
          revisions.push(revision);
          if (mode === "wait") {
            enter();
            await released;
          }
          if (mode === "error")
            throw new OperationError("quota_ownership_conflict");
          return mode === "ready";
        },
      });
      const first = sync.tick();
      await entered;
      assert.equal(
        await sync.tick(),
        false,
        "another replica skips the locked project",
      );
      assert.equal(calls, 1);
      release();
      assert.equal(await first, true);
      const state = async () =>
        transaction(pool, (client) => quotaSnapshot(client, project));
      assert.equal((await state()).synchronization.state, "Pending");
      mode = "ready";
      assert.equal(await sync.ensure(project), true);
      assert.equal((await state()).synchronization.state, "Applied");
      assert.equal(
        await sync.tick(),
        false,
        "successful observations are scheduled for later",
      );
      await pool.query(
        "UPDATE projects SET quota_revision=quota_revision+1,quota_next_sync=now() WHERE id=$1",
        [project],
      );
      assert.equal(
        (await state()).synchronization.state,
        "Pending",
        "old observation cannot certify a new revision",
      );
      mode = "error";
      assert.equal(await sync.ensure(project), false);
      assert.equal((await state()).synchronization.state, "Failed");
      assert.equal(
        (await state()).synchronization.error,
        "quota_ownership_conflict",
      );
      mode = "ready";
      assert.equal(await sync.ensure(project), true);
      assert.equal(revisions.at(-1), "2");
      assert.equal((await state()).synchronization.error, null);
      await pool.query(
        "INSERT INTO instance_bindings(id,project_id,resource_name,created_by) VALUES($1,$2,'c-test',$3)",
        [instance, project, user],
      );
      await pool.query(
        "INSERT INTO operations(id,project_id,instance_id,kind,idempotency_key,request_hash,request,created_by) VALUES($1,$2,$3,'instance.create','sync-create','hash','{}',$4)",
        [op, project, instance, user],
      );
      let observed = false;
      const kube = {
        getInstance: async () => {
          observed = true;
          return null;
        },
      } as unknown as KubernetesPort;
      const worker = new OperationWorker(pool, kube, Buffer.alloc(32), (id) =>
        sync.ensure(id),
      );
      mode = "pending";
      assert.equal(await worker.tick(), true);
      let operation = (
        await pool.query("SELECT * FROM operations WHERE id=$1", [op])
      ).rows[0];
      assert.equal(operation.error_code, "project_quota_not_ready");
      assert.equal(operation.state, "applying");
      assert.equal(
        observed,
        false,
        "pending quota cannot touch instance resources",
      );
      await pool.query(
        "UPDATE operations SET kind='instance.delete',request=$2,next_attempt_at=now() WHERE id=$1",
        [
          op,
          JSON.stringify({
            namespace: "sync-test",
            name: "c-test",
            uid: "old-uid",
            deletionPolicy: "Delete",
          }),
        ],
      );
      const before = calls;
      assert.equal(await worker.tick(), true);
      assert.equal(calls, before, "cleanup bypasses the quota gate");
      assert.equal(observed, true);
      operation = (
        await pool.query("SELECT * FROM operations WHERE id=$1", [op])
      ).rows[0];
      assert.equal(operation.state, "succeeded");
    } finally {
      await pool.end();
      await root.query(`DROP DATABASE "${database}"`);
      await root.end();
    }
  },
);
