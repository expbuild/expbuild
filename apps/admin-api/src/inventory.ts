import type pg from "pg";
import type { V1PersistentVolumeClaim } from "@kubernetes/client-node";
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { transaction } from "./db.js";
import { OperationError } from "./errors.js";
import type { CacheObject } from "./instance-contract.js";

export type InventoryResources = {
  instances: CacheObject[];
  volumes: V1PersistentVolumeClaim[];
};
export interface InventoryPort {
  inspectProjectResources(
    namespace: string,
    projectId: string,
  ): Promise<InventoryResources>;
}
export type InventoryBinding = {
  id: string;
  resource_name: string;
  kubernetes_uid: string | null;
  lifecycle: string;
  busy: boolean;
  expected_spec: CacheObject["spec"] | null;
  operation_stamp: string | null;
};
export type InventoryIssue = {
  code: string;
  kind: "CacheInstance" | "PersistentVolumeClaim";
  resourceName: string;
  instanceId: string | null;
};
const projectLabel = "cache.expbuild.io/project-id",
  instanceLabel = "cache.expbuild.io/instance-id";

export function compareInventory(
  project: string,
  bindings: InventoryBinding[],
  resources: InventoryResources,
) {
  const issues: InventoryIssue[] = [];
  let issueCount = 0,
    busyInstances = 0;
  const add = (
    code: string,
    kind: InventoryIssue["kind"],
    resourceName: string,
    instanceId: string | null,
  ) => {
    issueCount++;
    if (issues.length < 200)
      issues.push({ code, kind, resourceName, instanceId });
  };
  const instances = new Map(
    resources.instances.map((x) => [x.metadata.name, x]),
  );
  const volumes = new Map(resources.volumes.map((x) => [x.metadata?.name, x]));
  for (const binding of bindings) {
    const instance = instances.get(binding.resource_name),
      volume = volumes.get(binding.resource_name + "-data");
    instances.delete(binding.resource_name);
    volumes.delete(binding.resource_name + "-data");
    if (binding.busy) {
      busyInstances++;
      continue;
    }
    const issue = (
      code: string,
      kind: InventoryIssue["kind"] = "CacheInstance",
    ) =>
      add(
        code,
        kind,
        binding.resource_name +
          (kind === "PersistentVolumeClaim" ? "-data" : ""),
        binding.id,
      );
    const terminal = ["deleted", "detached"].includes(binding.lifecycle);
    if (instance) {
      const meta = instance.metadata;
      if (
        instance.spec.projectId !== project ||
        instance.spec.instanceId !== binding.id ||
        !binding.kubernetes_uid ||
        meta.uid !== binding.kubernetes_uid
      )
        issue("InstanceIdentityConflict");
      else if (
        meta.labels?.[projectLabel] !== project ||
        meta.labels?.[instanceLabel] !== binding.id ||
        meta.labels?.["app.kubernetes.io/managed-by"] !== "expbuild"
      )
        issue("InstanceOwnershipConflict");
      else if (terminal) issue("UnexpectedInstance");
      else if (meta.deletionTimestamp) issue("UnexpectedInstanceDeletion");
      else if (
        binding.expected_spec &&
        !isDeepStrictEqual(instance.spec, binding.expected_spec)
      )
        issue("ConfigurationDrift");
    } else if (!terminal)
      issue(
        binding.lifecycle === "active"
          ? "MissingInstance"
          : "ProvisioningIncomplete",
      );
    if (volume) {
      const meta = volume.metadata;
      const owners = meta?.ownerReferences ?? [];
      if (
        !binding.kubernetes_uid ||
        meta?.labels?.[projectLabel] !== project ||
        meta.labels?.[instanceLabel] !== binding.id ||
        meta.labels?.["cache.expbuild.io/instance-uid"] !==
          binding.kubernetes_uid ||
        meta.labels?.["app.kubernetes.io/managed-by"] !== "expbuild" ||
        owners.some(
          (owner) =>
            owner.uid !== binding.kubernetes_uid ||
            owner.kind !== "CacheInstance" ||
            owner.name !== binding.resource_name,
        ) ||
        (binding.lifecycle === "detached" && owners.length > 0)
      )
        issue("VolumeOwnershipConflict", "PersistentVolumeClaim");
      else if (binding.lifecycle === "deleted")
        issue("ResidualVolume", "PersistentVolumeClaim");
      else if (meta?.deletionTimestamp)
        issue("VolumeDeletionInProgress", "PersistentVolumeClaim");
      else if (volume.status?.phase !== "Bound")
        issue("VolumeNotBound", "PersistentVolumeClaim");
    } else if (
      binding.lifecycle === "active" ||
      binding.lifecycle === "detached"
    )
      issue(
        binding.lifecycle === "detached"
          ? "MissingRetainedVolume"
          : "MissingVolume",
        "PersistentVolumeClaim",
      );
  }
  for (const resource of instances.values())
    add("UntrackedInstance", "CacheInstance", resource.metadata.name, null);
  for (const resource of volumes.values())
    add(
      "UntrackedVolume",
      "PersistentVolumeClaim",
      resource.metadata?.name ?? "",
      null,
    );
  return {
    state: issueCount ? "Drift" : busyInstances ? "InProgress" : "Healthy",
    issues,
    issueCount,
    truncated: issueCount > issues.length,
    busyInstances,
    counts: {
      instances: resources.instances.length,
      volumes: resources.volumes.length,
    },
  };
}

const bindingSQL = `SELECT i.id,i.resource_name,i.kubernetes_uid,i.lifecycle,
  EXISTS(SELECT 1 FROM operations o WHERE o.instance_id=i.id AND o.state IN ('pending','applying','reconciling')) AS busy,
  last.request #> '{desired,spec}' AS expected_spec,
  (SELECT string_agg(o.id::text||':'||o.state||':'||o.updated_at::text,',' ORDER BY o.created_at,o.id) FROM operations o WHERE o.instance_id=i.id) AS operation_stamp
  FROM instance_bindings i LEFT JOIN LATERAL (SELECT request FROM operations WHERE instance_id=i.id AND request ? 'desired' ORDER BY created_at DESC,id DESC LIMIT 1) last ON true
  WHERE i.project_id=$1 ORDER BY i.id LIMIT 1001`;
const fingerprint = (rows: InventoryBinding[]) =>
  createHash("sha256").update(JSON.stringify(rows)).digest("hex");
export class ResourceInventory {
  constructor(
    private pool: pg.Pool,
    private kube: InventoryPort,
  ) {}
  async tick() {
    const worker = randomUUID();
    const project = await transaction(this.pool, async (client) => {
      const found = (
        await client.query(
          "SELECT id,namespace FROM projects WHERE state='ready' AND inventory_next_scan<=now() AND (inventory_lease_until IS NULL OR inventory_lease_until<now()) ORDER BY inventory_next_scan FOR UPDATE SKIP LOCKED LIMIT 1",
        )
      ).rows[0];
      if (!found) return null;
      await client.query(
        "UPDATE projects SET inventory_worker_id=$2,inventory_lease_until=now()+interval '3 minutes' WHERE id=$1",
        [found.id, worker],
      );
      return found as { id: string; namespace: string };
    });
    if (!project) return false;
    let result: Record<string, unknown>,
      before: string | null = null;
    try {
      const bindings = (await this.pool.query(bindingSQL, [project.id]))
        .rows as InventoryBinding[];
      if (bindings.length > 1000)
        throw new OperationError("inventory_limit_exceeded");
      before = fingerprint(bindings);
      result = compareInventory(
        project.id,
        bindings,
        await this.kube.inspectProjectResources(project.namespace, project.id),
      );
    } catch (error) {
      result = {
        state: "Unavailable",
        error:
          error instanceof OperationError
            ? error.code
            : "kubernetes_unavailable",
        issues: [],
        issueCount: 0,
        truncated: false,
        busyInstances: 0,
        counts: null,
      };
    }
    await transaction(this.pool, async (client) => {
      const held = (
        await client.query(
          "SELECT id FROM projects WHERE id=$1 AND inventory_worker_id=$2 AND inventory_lease_until>now() FOR UPDATE",
          [project.id, worker],
        )
      ).rowCount;
      if (!held) return;
      if (
        before &&
        before !==
          fingerprint((await client.query(bindingSQL, [project.id])).rows)
      ) {
        result = {
          state: "InProgress",
          error: "platform_changed_during_scan",
          issues: [],
          issueCount: 0,
          truncated: false,
          busyInstances: 0,
          counts: null,
        };
      }
      await client.query(
        "UPDATE projects SET inventory_result=$3,inventory_checked_at=now(),inventory_next_scan=now()+$4::interval,inventory_worker_id=NULL,inventory_lease_until=NULL WHERE id=$1 AND inventory_worker_id=$2",
        [
          project.id,
          worker,
          JSON.stringify(result),
          result.state === "InProgress" ? "5 seconds" : "60 seconds",
        ],
      );
    });
    return true;
  }
}
