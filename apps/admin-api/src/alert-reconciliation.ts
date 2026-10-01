import type pg from "pg";
import type { ObservationAlerts } from "./observation-backends.js";

// Polling cannot reconstruct missed episodes or infer an exact recovery time.
export class AlertReconciliation {
  private cursor = "00000000-0000-0000-0000-000000000000";
  constructor(
    private readonly pool: pg.Pool,
    private readonly alerts: ObservationAlerts,
  ) {}
  async tick() {
    const client = await this.pool.connect();
    try {
      const lock = await client.query(
        "SELECT pg_try_advisory_lock(73942107) AS acquired",
      );
      if (!lock.rows[0].acquired) return;
      try {
        const projects = await client.query(
          "SELECT DISTINCT project_id FROM observation_alerts WHERE state='firing' AND project_id>$1 ORDER BY project_id LIMIT 10",
          [this.cursor],
        );
        for (const { project_id: project } of projects.rows) {
          try {
            const active = await this.alerts.read(project);
            const keys = active.map(
              (a) =>
                `${a.instanceUID}/${a.fingerprint}/${new Date(a.startsAt).toISOString()}`,
            );
            await client.query(
              `UPDATE observation_alerts SET active_confirmed=(instance_uid||'/'||fingerprint||'/'||to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))=ANY($2::text[]),checked_at=now() WHERE project_id=$1 AND state='firing'`,
              [project, keys],
            );
          } catch {
            /* Retain and expose the last successful check timestamp. */
          }
        }
        this.cursor =
          projects.rows.length === 10
            ? projects.rows.at(-1)!.project_id
            : "00000000-0000-0000-0000-000000000000";
      } finally {
        await client.query("SELECT pg_advisory_unlock(73942107)");
      }
    } finally {
      client.release();
    }
  }
}
