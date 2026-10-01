ALTER TABLE operations ADD COLUMN secret_payload bytea;
ALTER TABLE operations ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE operations ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN deadline_at timestamptz NOT NULL DEFAULT now() + interval '20 minutes';
ALTER TABLE instance_bindings ADD COLUMN display_name text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX operations_one_project_init ON operations(project_id)
  WHERE kind='project.create' AND state IN ('pending','applying','reconciling');
