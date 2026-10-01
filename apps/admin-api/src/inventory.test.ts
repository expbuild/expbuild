import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  compareInventory,
  ResourceInventory,
  type InventoryBinding,
  type InventoryResources,
} from "./inventory.js";
import { desiredObject, instanceInput } from "./instance-contract.js";
import { createPool, migrate } from "./db.js";
import { OperationError } from "./errors.js";

function fixture() {
  const instance = desiredObject(
    instanceInput.parse({ name: "test", storageGiB: 3, cacheGiB: 1 }),
    "project",
    "project-ns",
    "instance",
    "standard",
    "op",
    "hash",
  );
  instance.metadata.uid = "cr-uid";
  const binding: InventoryBinding = {
    id: "instance",
    resource_name: instance.metadata.name,
    kubernetes_uid: "cr-uid",
    lifecycle: "active",
    template_name: "bazel-remote",
    template_version: "0.1.0",
    reserved_storage_gib: "3",
    reserved_cpu_millis: "500",
    reserved_memory_mib: "512",
    busy: false,
    expected_spec: structuredClone(instance.spec),
    operation_stamp: "stamp",
  };
  const resources: InventoryResources = {
    instances: [instance],
    volumes: [
      {
        metadata: {
          name: instance.metadata.name + "-data",
          uid: "pvc-uid",
          labels: {
            ...instance.metadata.labels,
            "cache.expbuild.io/instance-uid": "cr-uid",
          },
        },
        status: { phase: "Bound" },
      },
    ],
  };
  return { binding, resources };
}
test("inventory detects identities, drift, missing retained volumes and unknown resources without mutation", () => {
  let { binding, resources } = fixture();
  const snapshot = structuredClone(resources);
  assert.equal(
    compareInventory("project", [binding], resources).state,
    "Healthy",
  );
  assert.deepEqual(resources, snapshot);
  resources.instances[0].spec.eviction.maxCacheGiB = 2;
  assert.equal(
    compareInventory("project", [binding], resources).issues[0].code,
    "ConfigurationDrift",
  );
  resources.instances[0].metadata.uid = "replacement";
  assert.equal(
    compareInventory("project", [binding], resources).issues[0].code,
    "InstanceIdentityConflict",
  );
  binding.busy = true;
  assert.equal(
    compareInventory("project", [binding], resources).state,
    "InProgress",
  );
  binding.busy = false;
  resources.instances = [];
  resources.volumes = [];
  assert.deepEqual(
    compareInventory("project", [binding], resources).issues.map((x) => x.code),
    ["MissingInstance", "MissingVolume"],
  );
  binding.lifecycle = "detached";
  assert.equal(
    compareInventory("project", [binding], resources).issues[0].code,
    "MissingRetainedVolume",
  );
  ({ binding, resources } = fixture());
  resources.volumes[0].metadata!.labels!["cache.expbuild.io/instance-uid"] =
    "another-owner";
  assert.equal(
    compareInventory("project", [binding], resources).issues[0].code,
    "VolumeOwnershipConflict",
  );
  const untracked = compareInventory("project", [], resources);
  assert.deepEqual(
    untracked.issues.map((x) => x.code),
    ["UntrackedInstance", "UntrackedVolume"],
  );
  assert.equal(
    JSON.stringify(untracked).includes("credentialsSecretRef"),
    false,
  );
  resources.volumes = Array.from({ length: 205 }, (_, i) => ({
    metadata: { name: "unknown-" + i },
  }));
  const bounded = compareInventory("project", [], resources);
  assert.equal(bounded.issueCount, 206);
  assert.equal(bounded.issues.length, 200);
  assert.equal(bounded.truncated, true);
});

test(
  "inventory lease rejects stale results, detects concurrent changes and preserves bindings on failure",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = createPool(process.env.TEST_DATABASE_URL!),
      database = "inventory_" + randomUUID().replaceAll("-", "");
    await root.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = "/" + database;
    const pool = createPool(url.toString());
    try {
      await migrate(pool);
      const user = randomUUID(),
        project = randomUUID(),
        instance = randomUUID();
      await pool.query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'inventory@example.test','unused')",
        [user],
      );
      await pool.query(
        "INSERT INTO projects(id,name,namespace,state,created_by) VALUES($1,'Test','test','ready',$2)",
        [project, user],
      );
      await pool.query(
        "INSERT INTO instance_bindings(id,project_id,resource_name,kubernetes_uid,lifecycle,created_by) VALUES($1,$2,'c-existing','cr-uid','active',$3)",
        [instance, project, user],
      );
      let changed = false,
        reservationChanged = false,
        fail = false,
        expired = false,
        calls = 0;
      const inventory = new ResourceInventory(pool, {
        inspectProjectResources: async () => {
          calls++;
          assert.equal(
            await inventory.tick(),
            false,
            "second replica respects a live lease",
          );
          if (changed)
            await pool.query(
              "UPDATE instance_bindings SET lifecycle='detached' WHERE id=$1",
              [instance],
            );
          if (reservationChanged)
            await pool.query(
              "UPDATE instance_bindings SET reserved_storage_gib=4 WHERE id=$1",
              [instance],
            );
          if (expired)
            await pool.query(
              "UPDATE projects SET inventory_worker_id=$2 WHERE id=$1",
              [project, randomUUID()],
            );
          if (fail) throw new OperationError("namespace_ownership_conflict");
          return { instances: [], volumes: [] };
        },
      });
      const read = async () =>
        (
          await pool.query(
            "SELECT inventory_result FROM projects WHERE id=$1",
            [project],
          )
        ).rows[0].inventory_result;
      const due = async () => {
        await pool.query(
          "UPDATE projects SET inventory_next_scan=now(),inventory_lease_until=NULL,inventory_worker_id=NULL WHERE id=$1",
          [project],
        );
      };
      assert.equal(await inventory.tick(), true);
      assert.equal((await read()).state, "Drift");
      assert.equal((await read()).issues[0].code, "MissingInstance");
      assert.equal(
        await inventory.tick(),
        false,
        "scan interval prevents tight polling",
      );
      await due();
      changed = true;
      await inventory.tick();
      changed = false;
      assert.equal((await read()).state, "InProgress");
      assert.equal((await read()).error, "platform_changed_during_scan");
      await due();
      fail = true;
      await inventory.tick();
      fail = false;
      assert.equal((await read()).state, "Unavailable");
      assert.equal((await read()).error, "namespace_ownership_conflict");
      assert.equal(
        (
          await pool.query(
            "SELECT lifecycle FROM instance_bindings WHERE id=$1",
            [instance],
          )
        ).rows[0].lifecycle,
        "detached",
        "failure never frees reservations or erases bindings",
      );
      await due();
      reservationChanged = true;
      await inventory.tick();
      reservationChanged = false;
      assert.equal(
        (await read()).state,
        "InProgress",
        "reservation edits invalidate in-flight snapshots",
      );
      assert.equal((await read()).error, "platform_changed_during_scan");
      const previous = await read();
      await due();
      expired = true;
      await inventory.tick();
      assert.deepEqual(
        await read(),
        previous,
        "stale worker cannot publish an observation",
      );
      assert.equal(calls, 5);
    } finally {
      await pool.end();
      await root.query(`DROP DATABASE "${database}"`);
      await root.end();
    }
  },
);

test("inventory compares immutable template bindings and actual resources against reservations", () => {
  let { binding, resources } = fixture();
  binding.expected_spec = null;
  resources.instances[0].spec.templateRef.version = "9.0.0";
  assert.equal(
    compareInventory("project", [binding], resources).issues[0].code,
    "TemplateIdentityConflict",
  );
  resources.instances[0].spec.templateRef.version = "0.1.0";
  binding.template_version = null;
  assert.equal(
    compareInventory("project", [binding], resources).issues[0].code,
    "TemplateVersionUnknown",
  );
  ({ binding, resources } = fixture());
  binding.reserved_cpu_millis = "499";
  assert.ok(
    compareInventory("project", [binding], resources).issues.some(
      (i) => i.code === "ResourceReservationInsufficient",
    ),
  );
  binding.reserved_cpu_millis = "1000";
  assert.equal(
    compareInventory("project", [binding], resources).state,
    "Healthy",
    "larger historical reservations are not released or reported as insufficient",
  );
  resources.instances[0].spec.desiredState = "Suspended";
  binding.expected_spec = structuredClone(resources.instances[0].spec);
  binding.reserved_memory_mib = "511";
  assert.ok(
    compareInventory("project", [binding], resources).issues.some(
      (i) => i.code === "ResourceReservationInsufficient",
    ),
    "suspension still reserves resume capacity",
  );
  binding.reserved_memory_mib = null;
  assert.ok(
    compareInventory("project", [binding], resources).issues.some(
      (i) => i.code === "ResourceReservationUnknown",
    ),
  );
  ({ binding, resources } = fixture());
  resources.volumes[0].spec = { resources: { requests: { storage: "4Gi" } } };
  assert.ok(
    compareInventory("project", [binding], resources).issues.some(
      (i) =>
        i.code === "ResourceReservationInsufficient" &&
        i.kind === "PersistentVolumeClaim",
    ),
  );
  resources.instances = [];
  binding.lifecycle = "detached";
  binding.reserved_cpu_millis = binding.reserved_memory_mib = null;
  binding.reserved_storage_gib = "4";
  assert.equal(
    compareInventory("project", [binding], resources).state,
    "Healthy",
    "detached storage does not reserve CPU or memory",
  );
  resources.volumes[0].status = {
    phase: "Bound",
    capacity: { storage: "5Gi" },
  };
  assert.equal(
    compareInventory("project", [binding], resources).issues[0].code,
    "ResourceReservationInsufficient",
    "allocated volume capacity is checked too",
  );
  resources.volumes[0].status.capacity!.storage = "invalid";
  const saved = structuredClone({ binding, resources });
  assert.equal(
    compareInventory("project", [binding], resources).issues[0].code,
    "ResourceQuantityInvalid",
  );
  assert.deepEqual(
    { binding, resources },
    saved,
    "observation never edits resources or reservation accounting",
  );
});
