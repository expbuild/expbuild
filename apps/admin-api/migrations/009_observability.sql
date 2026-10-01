CREATE TABLE observation_snapshots (
  instance_id uuid PRIMARY KEY REFERENCES instance_bindings(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id),
  instance_uid text NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX observation_snapshots_project ON observation_snapshots(project_id);

CREATE TABLE observation_events (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  instance_id uuid NOT NULL REFERENCES instance_bindings(id),
  instance_uid text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  code text NOT NULL,
  source_uid text,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX observation_events_instance_time ON observation_events(instance_id,observed_at DESC);
CREATE UNIQUE INDEX observation_events_source ON observation_events(instance_uid,source_uid) WHERE source_uid IS NOT NULL;

CREATE TABLE observation_alerts (
  project_id uuid NOT NULL REFERENCES projects(id),
  instance_uid text NOT NULL,
  fingerprint text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL CHECK (state IN ('firing','resolved')),
  active_confirmed boolean,
  checked_at timestamptz,
  payload jsonb NOT NULL,
  PRIMARY KEY(project_id,instance_uid,fingerprint,starts_at)
);
CREATE INDEX observation_alerts_project ON observation_alerts(project_id,received_at DESC);
