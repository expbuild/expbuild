import type pg from "pg";
import { z } from "zod";
import { HttpError } from "./errors.js";
import type { CacheObject } from "./instance-contract.js";

const limit = z.number().int().min(0).max(2147483647).nullable();
export const quotaInput = z
  .object({
    instances: limit,
    storageGiB: limit,
    cpuMillis: limit,
    memoryMiB: limit,
  })
  .strict();
export type Quota = z.infer<typeof quotaInput>;
type Resources = { storageGiB: number; cpuMillis: number; memoryMiB: number };

// Callers hold the project row lock, including worker settlement. All values
// represent reservations, not sampled usage or physical volume consumption.
export async function quotaSnapshot(client: pg.PoolClient, projectId: string) {
  const project = (
    await client.query(
      "SELECT quota_limits,quota_revision,quota_observed_revision,quota_checked_at,quota_sync_error FROM projects WHERE id=$1",
      [projectId],
    )
  ).rows[0];
  if (!project) throw new HttpError(404, "Project not found");
  const row = (
    await client.query(
      `SELECT
    count(*) FILTER (WHERE lifecycle NOT IN ('deleted','detached')) AS instances,
    coalesce(sum(reserved_storage_gib) FILTER (WHERE lifecycle <> 'deleted'),0) AS storage,
    coalesce(sum(reserved_cpu_millis) FILTER (WHERE lifecycle NOT IN ('deleted','detached')),0) AS cpu,
    coalesce(sum(reserved_memory_mib) FILTER (WHERE lifecycle NOT IN ('deleted','detached')),0) AS memory,
    count(*) FILTER (WHERE lifecycle <> 'deleted' AND (reserved_storage_gib IS NULL OR
      (lifecycle <> 'detached' AND (reserved_cpu_millis IS NULL OR reserved_memory_mib IS NULL)))) AS unknown
    FROM instance_bindings WHERE project_id=$1`,
      [projectId],
    )
  ).rows[0];
  return {
    synchronization: {
      state: project.quota_sync_error ? 'Failed' : String(project.quota_observed_revision) === String(project.quota_revision) ? 'Applied' : 'Pending',
      observedRevision: project.quota_observed_revision === null ? null : String(project.quota_observed_revision),
      checkedAt: project.quota_checked_at?.toISOString() ?? null,
      error: project.quota_sync_error,
    },
    limits: quotaInput.parse(project.quota_limits),
    revision: String(project.quota_revision),
    reserved: {
      instances: Number(row.instances),
      storageGiB: Number(row.storage),
      cpuMillis: Number(row.cpu),
      memoryMiB: Number(row.memory),
    },
    unknownReservations: Number(row.unknown),
  };
}
export function checkQuota(
  limits: Quota,
  reserved: Record<keyof Quota, number>,
  unknown: number,
) {
  if (unknown && Object.values(limits).some((value) => value !== null))
    throw new HttpError(409, "Project has unresolved resource reservations");
  for (const key of Object.keys(limits) as (keyof Quota)[]) {
    if (limits[key] !== null && reserved[key] > limits[key]!)
      throw new HttpError(409, `Project quota exceeded: ${key}`);
  }
}

export async function reserveResources(
  client: pg.PoolClient,
  projectId: string,
  instanceId: string,
  input: Resources,
  creating = false,
) {
  if (!creating) {
    const row = (
      await client.query(
        "SELECT reserved_storage_gib,reserved_cpu_millis,reserved_memory_mib FROM instance_bindings WHERE id=$1 AND project_id=$2",
        [instanceId, projectId],
      )
    ).rows[0];
    if (!row || Object.values(row).some((value) => value === null))
      throw new HttpError(409, "Instance has unresolved resource reservations");
  }
  const result = await client.query(
    `UPDATE instance_bindings SET
    reserved_storage_gib=greatest(coalesce(reserved_storage_gib,0),$3),
    reserved_cpu_millis=greatest(coalesce(reserved_cpu_millis,0),$4),
    reserved_memory_mib=greatest(coalesce(reserved_memory_mib,0),$5)
    WHERE project_id=$1 AND id=$2 AND lifecycle NOT IN ('deleted','detached') RETURNING id`,
    [projectId, instanceId, input.storageGiB, input.cpuMillis, input.memoryMiB],
  );
  if (result.rowCount !== 1)
    throw new HttpError(409, "Instance cannot reserve resources");
  const snapshot = await quotaSnapshot(client, projectId);
  checkQuota(snapshot.limits, snapshot.reserved, snapshot.unknownReservations);
}

export async function settleResources(
  client: pg.PoolClient,
  instanceId: string,
  desired: CacheObject,
) {
  // Suspension keeps the promised resources reserved so resuming is safe.
  // Storage never shrinks: an earlier expansion may already exist in the PVC.
  const storage = /^(\d+)Gi$/.exec(desired.spec.storage.capacity);
  const cpu = /^(\d+)m$/.exec(desired.spec.resources.requests.cpu ?? "");
  const memory = /^(\d+)Mi$/.exec(desired.spec.resources.requests.memory ?? "");
  if (!storage || !cpu || !memory)
    throw new Error("Unsupported reservation units");
  await client.query(
    `UPDATE instance_bindings SET reserved_storage_gib=greatest(reserved_storage_gib,$2),
    reserved_cpu_millis=$3,reserved_memory_mib=$4 WHERE id=$1`,
    [instanceId, Number(storage[1]), Number(cpu[1]), Number(memory[1])],
  );
}
