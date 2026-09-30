import type pg from "pg";
import { transaction } from "./db.js";
import { quotaInput, type Quota } from "./quotas.js";
import { OperationError } from "./errors.js";

export interface QuotaPort {
  ensureProjectQuota(
    namespace: string,
    projectId: string,
    revision: string,
    limits: Quota,
  ): Promise<boolean>;
}
type Project = {
  id: string;
  namespace: string;
  state: string;
  quota_revision: string;
  quota_limits: Quota;
};
export class ProjectQuotaSync {
  constructor(
    private pool: pg.Pool,
    private kube: QuotaPort,
  ) {}
  private async apply(client: pg.PoolClient, project: Project) {
    let ready = false,
      error: string | null = null;
    try {
      ready = await this.kube.ensureProjectQuota(
        project.namespace,
        project.id,
        String(project.quota_revision),
        quotaInput.parse(project.quota_limits),
      );
    } catch (failure) {
      error =
        failure instanceof OperationError
          ? failure.code
          : "kubernetes_unavailable";
    }
    await client.query(
      `UPDATE projects SET quota_observed_revision=$2,quota_checked_at=now(),quota_sync_error=$3,
      quota_next_sync=now()+$4::interval WHERE id=$1`,
      [
        project.id,
        ready ? project.quota_revision : null,
        error,
        ready ? "30 seconds" : "2 seconds",
      ],
    );
    return ready;
  }
  // Keep the project row locked across the bounded Kubernetes call so another
  // replica or quota edit cannot apply an older desired revision concurrently.
  async ensure(projectId: string) {
    return transaction(this.pool, async (client) => {
      const project = (
        await client.query("SELECT * FROM projects WHERE id=$1 FOR UPDATE", [
          projectId,
        ])
      ).rows[0] as Project | undefined;
      if (!project || project.state !== "ready") return false;
      return this.apply(client, project);
    });
  }
  async tick() {
    return transaction(this.pool, async (client) => {
      const project = (
        await client.query(
          "SELECT * FROM projects WHERE state='ready' AND quota_next_sync<=now() ORDER BY quota_next_sync FOR UPDATE SKIP LOCKED LIMIT 1",
        )
      ).rows[0] as Project | undefined;
      if (!project) return false;
      await this.apply(client, project);
      return true;
    });
  }
}
