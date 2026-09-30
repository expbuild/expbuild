import { compareInventory, type InventoryBinding, type InventoryResources } from "./inventory.js";
import { quantityCeil } from "./quantities.js";
import { HttpError } from "./errors.js";

type Reservation = { storageGiB: number; cpuMillis: number; memoryMiB: number };

// The observed values are lower bounds for accounting. Keep historical high-water
// reservations in PostgreSQL; never infer that a missing or smaller object frees quota.
export function reservationFloor(
  projectId: string,
  binding: InventoryBinding,
  resources: InventoryResources,
): Reservation {
  if (binding.busy || !["active", "detached"].includes(binding.lifecycle))
    throw new HttpError(409, "Instance is not stable enough to reconcile");
  const result = compareInventory(projectId, [binding], resources);
  const issues = result.issues.filter((issue) => issue.instanceId === binding.id);
  if (issues.some((issue) => !["ResourceReservationUnknown", "ResourceReservationInsufficient"].includes(issue.code)))
    throw new HttpError(409, "Resolve instance identity or configuration drift first");
  const cr = resources.instances.find((item) => item.metadata.name === binding.resource_name);
  const pvc = resources.volumes.find((item) => item.metadata?.name === binding.resource_name + "-data");
  if (!pvc || (binding.lifecycle === "active" && !cr) || (binding.lifecycle === "detached" && cr))
    throw new HttpError(409, "Instance or volume is missing or unexpected");
  try {
    const storage = [pvc.spec?.resources?.requests?.storage, pvc.status?.capacity?.storage];
    if (storage.some((value) => !value)) throw new Error("Missing volume capacity");
    if (cr) storage.push(cr.spec.storage.capacity);
    const storageGiB = Math.max(...storage.map((value) => quantityCeil(value!, "1Gi")));
    if (!cr) return { storageGiB, cpuMillis: 0, memoryMiB: 0 };
    const cpu = [cr.spec.resources.requests.cpu, cr.spec.resources.limits.cpu];
    const memory = [cr.spec.resources.requests.memory, cr.spec.resources.limits.memory];
    if (cpu.some((value) => !value) || memory.some((value) => !value))
      throw new Error("Missing compute request or limit");
    return {
      storageGiB,
      cpuMillis: Math.max(...cpu.map((value) => quantityCeil(value!, "1m"))),
      memoryMiB: Math.max(...memory.map((value) => quantityCeil(value!, "1Mi"))),
    };
  } catch {
    throw new HttpError(409, "Observed resource quantity cannot be safely reconciled");
  }
}
