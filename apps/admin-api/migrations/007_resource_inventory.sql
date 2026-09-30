ALTER TABLE projects ADD COLUMN inventory_result jsonb;
ALTER TABLE projects ADD COLUMN inventory_checked_at timestamptz;
ALTER TABLE projects ADD COLUMN inventory_next_scan timestamptz NOT NULL DEFAULT now();
ALTER TABLE projects ADD COLUMN inventory_worker_id uuid;
ALTER TABLE projects ADD COLUMN inventory_lease_until timestamptz;
CREATE INDEX projects_inventory_scan ON projects(inventory_next_scan) WHERE state='ready';
