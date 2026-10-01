CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  platform_admin boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  cluster_id text NOT NULL DEFAULT 'primary',
  namespace text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','failed','deleting')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cluster_id, namespace)
);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','maintainer','viewer')),
  PRIMARY KEY (project_id,user_id)
);

CREATE TABLE instance_bindings (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  resource_name text NOT NULL,
  kubernetes_uid text,
  lifecycle text NOT NULL DEFAULT 'pending' CHECK (lifecycle IN ('pending','active','deleting','deleted','detached','failed')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,resource_name),
  UNIQUE (project_id,id)
);

CREATE TABLE operations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  instance_id uuid,
  kind text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  request jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applying','reconciling','succeeded','failed','superseded')),
  target_generation bigint,
  worker_id uuid,
  lease_until timestamptz,
  error_code text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,kind,idempotency_key),
  FOREIGN KEY (project_id,instance_id) REFERENCES instance_bindings(project_id,id)
);
CREATE UNIQUE INDEX operations_one_active ON operations(instance_id)
  WHERE state IN ('pending','applying','reconciling');
CREATE INDEX operations_work ON operations(state,lease_until,created_at);

CREATE TABLE instance_credentials (
  id uuid PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES instance_bindings(id),
  name text NOT NULL,
  secret_name text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  state text NOT NULL CHECK (state IN ('pending','active','revoking','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id,secret_name)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  project_id uuid REFERENCES projects(id),
  instance_id uuid REFERENCES instance_bindings(id),
  operation_id uuid REFERENCES operations(id),
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_project_time ON audit_events(project_id,created_at DESC);
