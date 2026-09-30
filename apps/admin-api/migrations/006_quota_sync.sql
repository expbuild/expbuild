ALTER TABLE projects ADD COLUMN quota_observed_revision bigint;
ALTER TABLE projects ADD COLUMN quota_checked_at timestamptz;
ALTER TABLE projects ADD COLUMN quota_sync_error text;
ALTER TABLE projects ADD COLUMN quota_next_sync timestamptz NOT NULL DEFAULT now();
CREATE INDEX projects_quota_sync ON projects(quota_next_sync) WHERE state='ready';
