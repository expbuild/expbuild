import type pg from "pg";
import { randomUUID } from "node:crypto";
import { transaction } from "./db.js";
import { unseal } from "./secrets.js";
import { OperationError } from "./errors.js";
import type { CacheObject } from "./instance-contract.js";
import {
  statusCode,
  type CredentialData,
  type KubernetesPort,
} from "./kubernetes.js";

type Operation = {
  id: string;
  project_id: string;
  instance_id: string | null;
  kind: string;
  state: string;
  worker_id: string;
  target_generation: string | null;
  deadline_at: Date;
  secret_payload: Buffer | null;
  request: {
    namespace?: string;
    desired?: CacheObject;
    expectedRevision?: string;
    uid?: string;
    name?: string;
    deletionPolicy?: string;
  };
};

export class OperationWorker {
  constructor(
    private pool: pg.Pool,
    private kube: KubernetesPort,
    private key: Buffer,
  ) {}

  async tick(): Promise<boolean> {
    const claim = randomUUID();
    const operation = await transaction(this.pool, async (client) => {
      const selected = await client.query(
        "SELECT id FROM operations WHERE state IN ('pending','applying','reconciling') AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
      );
      if (!selected.rows[0]) return null;
      const row = await client.query(
        "UPDATE operations SET worker_id=$2,lease_until=now()+interval '30 seconds',attempts=attempts+1,state=CASE WHEN state='pending' THEN 'applying' ELSE state END,updated_at=now() WHERE id=$1 RETURNING *",
        [selected.rows[0].id, claim],
      );
      return row.rows[0] as Operation;
    });
    if (!operation) return false;
    try {
      if (new Date(operation.deadline_at).getTime() < Date.now())
        throw new OperationError("operation_deadline_exceeded");
      await this.execute(operation);
    } catch (error) {
      if (error instanceof OperationError)
        await this.finish(
          operation,
          error.superseded ? "superseded" : "failed",
          error.code,
        );
      else if ([400, 403, 422].includes(statusCode(error) ?? 0))
        await this.finish(
          operation,
          "failed",
          `kubernetes_${statusCode(error)}`,
        );
      else await this.defer(operation, "kubernetes_unavailable");
    }
    return true;
  }

  private async held(client: pg.PoolClient, operation: Operation) {
    const row = await client.query(
      "SELECT id FROM operations WHERE id=$1 AND worker_id=$2 AND lease_until>now() AND state IN ('applying','reconciling') FOR UPDATE",
      [operation.id, operation.worker_id],
    );
    return row.rows.length === 1;
  }
  private async finish(
    operation: Operation,
    state: string,
    code: string | null = null,
    apply?: (client: pg.PoolClient) => Promise<void>,
  ) {
    await transaction(this.pool, async (client) => {
      if (!(await this.held(client, operation))) return;
      if (apply) await apply(client);
      await client.query(
        "UPDATE operations SET state=$3,error_code=$4,secret_payload=NULL,worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND worker_id=$2",
        [operation.id, operation.worker_id, state, code],
      );
      if (state === "failed" && operation.kind === "project.create")
        await client.query("UPDATE projects SET state='failed' WHERE id=$1", [
          operation.project_id,
        ]);
      if (state === "failed" && operation.kind === "instance.create")
        await client.query(
          "UPDATE instance_bindings SET lifecycle='failed' WHERE id=$1",
          [operation.instance_id],
        );
      await client.query(
        "INSERT INTO audit_events(id,project_id,instance_id,operation_id,action,details) VALUES($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          operation.project_id,
          operation.instance_id,
          operation.id,
          `operation.${state}`,
          JSON.stringify({ code }),
        ],
      );
    });
  }
  private async defer(operation: Operation, code: string | null = null) {
    await this.pool.query(
      "UPDATE operations SET lease_until=NULL,worker_id=NULL,next_attempt_at=now()+interval '2 seconds',error_code=$3,updated_at=now() WHERE id=$1 AND worker_id=$2 AND lease_until>now()",
      [operation.id, operation.worker_id, code],
    );
  }
  private async bind(operation: Operation, object: CacheObject) {
    if (!object.metadata.uid || object.metadata.generation === undefined)
      throw new OperationError("missing_kubernetes_identity");
    await transaction(this.pool, async (client) => {
      if (!(await this.held(client, operation))) return;
      const changed = await client.query(
        "UPDATE instance_bindings SET kubernetes_uid=$2 WHERE id=$1 AND (kubernetes_uid IS NULL OR kubernetes_uid=$2) RETURNING id",
        [operation.instance_id, object.metadata.uid],
      );
      if (!changed.rows.length)
        throw new OperationError("instance_identity_conflict");
      await client.query(
        "UPDATE operations SET state='reconciling',target_generation=$3,updated_at=now() WHERE id=$1 AND worker_id=$2",
        [operation.id, operation.worker_id, object.metadata.generation],
      );
    });
    operation.state = "reconciling";
    operation.target_generation = String(object.metadata.generation);
  }
  private async execute(operation: Operation) {
    if (operation.kind === "project.create") {
      if (!operation.request.namespace)
        throw new OperationError("invalid_operation");
      await this.kube.ensureProject(
        operation.request.namespace,
        operation.project_id,
      );
      await this.finish(operation, "succeeded", null, async (client) => {
        await client.query("UPDATE projects SET state='ready' WHERE id=$1", [
          operation.project_id,
        ]);
      });
      return;
    }
    if (operation.kind === "instance.delete") {
      const { namespace, name, uid } = operation.request;
      if (!namespace || !name || !uid)
        throw new OperationError("invalid_operation");
      const current = await this.kube.getInstance(namespace, name);
      if (current) {
        if (current.metadata.uid !== uid)
          throw new OperationError("instance_identity_conflict");
        // Persist deletion policy before submitting a delete; after CR removal
        // its spec is no longer available. Replays may observe deletion in flight.
        const policy = current.spec.storage.deletionPolicy;
        await this.pool.query(
          "UPDATE operations SET request=jsonb_set(request,'{deletionPolicy}',to_jsonb($3::text)) WHERE id=$1 AND worker_id=$2 AND lease_until>now()",
          [operation.id, operation.worker_id, policy],
        );
        await this.kube.deleteInstance(namespace, name, uid);
        await this.defer(operation);
        return;
      }
      // If the CR was externally removed before policy was captured, retain is
      // conservative and avoids claiming that physical storage was deleted.
      const policy = operation.request.deletionPolicy ?? "Retain";
      const credentials = await this.pool.query(
        "SELECT secret_name FROM instance_credentials WHERE instance_id=$1",
        [operation.instance_id],
      );
      for (const credential of credentials.rows)
        await this.kube.deleteCredentials(
          namespace,
          credential.secret_name,
          operation.project_id,
          operation.instance_id!,
        );
      await this.finish(operation, "succeeded", null, async (client) => {
        await client.query(
          "UPDATE instance_bindings SET lifecycle=$2 WHERE id=$1",
          [operation.instance_id, policy === "Delete" ? "deleted" : "detached"],
        );
        await client.query(
          "UPDATE instance_credentials SET state='revoked' WHERE instance_id=$1",
          [operation.instance_id],
        );
      });
      return;
    }
    if (
      !["instance.create", "instance.update", "instance.rotate"].includes(
        operation.kind,
      )
    )
      throw new OperationError("unsupported_operation");
    const desired = operation.request.desired;
    if (!desired) throw new OperationError("invalid_operation");
    let object: CacheObject;
    if (operation.state !== "reconciling") {
      if (["instance.create", "instance.rotate"].includes(operation.kind)) {
        if (!operation.secret_payload)
          throw new OperationError("credentials_unavailable");
        const data = unseal<CredentialData>(
          this.key,
          operation.id,
          operation.secret_payload,
        );
        await this.kube.ensureCredentials(
          desired.metadata.namespace,
          desired.spec.access.credentialsSecretRef,
          operation.project_id,
          operation.instance_id!,
          operation.id,
          data,
        );
      }
      if (operation.kind === "instance.create") {
        object = await this.kube.createInstance(desired);
      } else {
        if (!operation.request.expectedRevision)
          throw new OperationError("invalid_operation");
        object = await this.kube.updateInstance(
          desired,
          operation.request.expectedRevision,
        );
      }
      await this.bind(operation, object);
    } else {
      const current = await this.kube.getInstance(
        desired.metadata.namespace,
        desired.metadata.name,
      );
      if (!current) throw new OperationError("instance_disappeared");
      object = current;
    }
    const binding = await this.pool.query(
      "SELECT kubernetes_uid FROM instance_bindings WHERE id=$1",
      [operation.instance_id],
    );
    if (
      object.metadata.uid !== binding.rows[0]?.kubernetes_uid ||
      object.spec.instanceId !== operation.instance_id ||
      object.spec.projectId !== operation.project_id
    )
      throw new OperationError("instance_identity_conflict");
    if (
      object.metadata.generation !== Number(operation.target_generation) ||
      object.metadata.annotations?.["cache.expbuild.io/operation-id"] !==
        operation.id
    )
      throw new OperationError("instance_configuration_superseded", true);
    const condition = object.status?.conditions?.find(
      (x) =>
        x.type === "Ready" &&
        x.observedGeneration === object.metadata.generation,
    );
    const done =
      object.status?.observedGeneration === object.metadata.generation &&
      (object.spec.desiredState === "Suspended"
        ? condition?.reason === "Suspended"
        : condition?.status === "True");
    if (done) {
      if (operation.kind === "instance.rotate") {
        const old = await this.pool.query(
          "SELECT secret_name FROM instance_credentials WHERE instance_id=$1 AND revision < (SELECT revision FROM instance_credentials WHERE instance_id=$1 AND secret_name=$2)",
          [operation.instance_id, desired.spec.access.credentialsSecretRef],
        );
        for (const credential of old.rows)
          await this.kube.deleteCredentials(
            desired.metadata.namespace,
            credential.secret_name,
            operation.project_id,
            operation.instance_id!,
          );
      }
      await this.finish(operation, "succeeded", null, async (client) => {
        await client.query(
          "UPDATE instance_bindings SET lifecycle='active',display_name=$2 WHERE id=$1",
          [
            operation.instance_id,
            desired.metadata.annotations?.["cache.expbuild.io/display-name"] ??
              "",
          ],
        );
        await client.query(
          "UPDATE instance_credentials SET state=CASE WHEN secret_name=$2 THEN 'active' ELSE 'revoked' END WHERE instance_id=$1",
          [operation.instance_id, desired.spec.access.credentialsSecretRef],
        );
      });
    } else if (
      condition &&
      ["InvalidConfiguration", "CredentialsRejected"].includes(condition.reason)
    )
      throw new OperationError(`controller_${condition.reason}`);
    else await this.defer(operation);
  }
}
