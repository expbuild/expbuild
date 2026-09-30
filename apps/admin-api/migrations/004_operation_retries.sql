CREATE TABLE operation_retries (
  project_id uuid NOT NULL REFERENCES projects(id),
  idempotency_key text NOT NULL,
  operation_id uuid NOT NULL REFERENCES operations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, idempotency_key)
);
