-- ExpBuild P0 metadata design draft, 2026-09-28.
-- NOT a production migration; NOT executed against an application database.
-- PostgreSQL 18 syntax baseline; application supplies UUIDs, no extensions required.
-- Run only in a disposable, empty database when validating this design.
BEGIN;
CREATE SCHEMA expbuild_cp;
CREATE SCHEMA expbuild_cache;

-- Minimal control-plane parent contracts, not the complete IAM schema.
CREATE TABLE expbuild_cp.tenant (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 63),
    authz_epoch bigint NOT NULL DEFAULT 1 CHECK (authz_epoch > 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleting')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE expbuild_cp.project (
    tenant_id uuid NOT NULL REFERENCES expbuild_cp.tenant(id),
    id uuid NOT NULL,
    slug text NOT NULL CHECK (length(slug) BETWEEN 1 AND 63),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleting')),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, slug)
);
CREATE TABLE expbuild_cp.principal (
    tenant_id uuid NOT NULL REFERENCES expbuild_cp.tenant(id),
    id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('user', 'service_account', 'system')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
    PRIMARY KEY (tenant_id, id)
);
CREATE TABLE expbuild_cp.credential (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    principal_id uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, principal_id, id),
    FOREIGN KEY (tenant_id, principal_id) REFERENCES expbuild_cp.principal(tenant_id, id)
    -- Secret verifier, pepper version, scopes and rotation lineage belong to IAM.
    -- No secret or verifier is distributed to the data plane.
);
CREATE TABLE expbuild_cp.policy_version (
    tenant_id uuid NOT NULL REFERENCES expbuild_cp.tenant(id),
    version bigint NOT NULL CHECK (version > 0),
    authz_epoch bigint NOT NULL CHECK (authz_epoch > 0),
    document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, version)
);
CREATE TABLE expbuild_cp.namespace (
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid NOT NULL,
    slug text NOT NULL CHECK (length(slug) BETWEEN 1 AND 63),
    protocol_id text NOT NULL CHECK (protocol_id IN ('reapi', 'gradle')),
    trust_domain text NOT NULL CHECK (trust_domain IN ('trusted-ci', 'internal-dev', 'isolated-pr')),
    current_policy_version bigint NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'read_only', 'suspended', 'deleting')),
    PRIMARY KEY (tenant_id, project_id, id),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, project_id, slug),
    FOREIGN KEY (tenant_id, project_id) REFERENCES expbuild_cp.project(tenant_id, id),
    FOREIGN KEY (tenant_id, current_policy_version) REFERENCES expbuild_cp.policy_version(tenant_id, version)
    -- P0: namespace is also the physical deduplication/isolation domain.
    -- trust_domain labels policy; matching labels DO NOT authorize sharing.
);

CREATE TABLE expbuild_cache.quota_account (
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    logical_byte_limit bigint NOT NULL CHECK (logical_byte_limit >= 0),
    logical_bytes_used bigint NOT NULL DEFAULT 0 CHECK (logical_bytes_used >= 0),
    logical_bytes_reserved bigint NOT NULL DEFAULT 0 CHECK (logical_bytes_reserved >= 0),
    blob_limit bigint NOT NULL CHECK (blob_limit >= 0),
    blobs_used bigint NOT NULL DEFAULT 0 CHECK (blobs_used >= 0),
    blobs_reserved bigint NOT NULL DEFAULT 0 CHECK (blobs_reserved >= 0),
    entry_limit bigint NOT NULL CHECK (entry_limit >= 0),
    entries_used bigint NOT NULL DEFAULT 0 CHECK (entries_used >= 0),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (tenant_id, project_id, namespace_id),
    FOREIGN KEY (tenant_id, project_id, namespace_id) REFERENCES expbuild_cp.namespace(tenant_id, project_id, id)
    -- Deliberately no used <= limit CHECK: an admin may lower limits below usage.
    -- Admission is a guarded UPDATE; existing data is not silently deleted.
);
CREATE TABLE expbuild_cache.quota_reservation (
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    id uuid NOT NULL,
    principal_id uuid NOT NULL,
    credential_id uuid NOT NULL,
    reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= 0),
    charged_bytes bigint NOT NULL DEFAULT 0 CHECK (charged_bytes >= 0 AND charged_bytes <= reserved_bytes),
    reserved_blobs bigint NOT NULL DEFAULT 1 CHECK (reserved_blobs BETWEEN 0 AND 1),
    charged_blobs bigint NOT NULL DEFAULT 0 CHECK (charged_blobs >= 0 AND charged_blobs <= reserved_blobs),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'settled', 'released', 'expired')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, project_id, namespace_id, id),
    UNIQUE (tenant_id, project_id, namespace_id, id, principal_id, credential_id),
    FOREIGN KEY (tenant_id, project_id, namespace_id) REFERENCES expbuild_cache.quota_account(tenant_id, project_id, namespace_id),
    FOREIGN KEY (tenant_id, principal_id, credential_id) REFERENCES expbuild_cp.credential(tenant_id, principal_id, id),
    CHECK (state = 'settled' OR (charged_bytes = 0 AND charged_blobs = 0))
);
CREATE INDEX reservation_expiry ON expbuild_cache.quota_reservation(expires_at) WHERE state = 'active';

CREATE TABLE expbuild_cache.blob_identity (
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    id uuid NOT NULL,
    digest_algorithm text NOT NULL CHECK (digest_algorithm = 'sha256'),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    logical_size bigint NOT NULL CHECK (logical_size >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, project_id, namespace_id, id),
    UNIQUE (tenant_id, project_id, namespace_id, digest_algorithm, digest, logical_size),
    FOREIGN KEY (tenant_id, project_id, namespace_id) REFERENCES expbuild_cp.namespace(tenant_id, project_id, id)
);
CREATE TABLE expbuild_cache.blob_generation (
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    blob_id uuid NOT NULL,
    id uuid NOT NULL,
    backend_id uuid NOT NULL,
    storage_key text NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 1024),
    backend_version text,
    encoding text NOT NULL DEFAULT 'identity' CHECK (encoding = 'identity'),
    physical_size bigint NOT NULL CHECK (physical_size >= 0),
    state text NOT NULL CHECK (state IN ('live', 'tombstoned', 'deleting', 'deleted', 'quarantined')),
    published_at timestamptz NOT NULL DEFAULT now(),
    tombstoned_at timestamptz,
    delete_not_before timestamptz,
    gc_epoch bigint CHECK (gc_epoch > 0),
    gc_fence bigint NOT NULL DEFAULT 0 CHECK (gc_fence >= 0),
    gc_owner uuid,
    gc_lease_until timestamptz,
    deleted_at timestamptz,
    PRIMARY KEY (tenant_id, project_id, namespace_id, blob_id, id),
    UNIQUE (backend_id, storage_key),
    FOREIGN KEY (tenant_id, project_id, namespace_id, blob_id) REFERENCES expbuild_cache.blob_identity(tenant_id, project_id, namespace_id, id),
    CHECK ((gc_owner IS NULL) = (gc_lease_until IS NULL)),
    CHECK (state NOT IN ('tombstoned', 'deleting', 'deleted') OR (tombstoned_at IS NOT NULL AND delete_not_before IS NOT NULL)),
    CHECK (state <> 'deleting' OR (gc_owner IS NOT NULL AND gc_fence > 0)),
    CHECK (state <> 'deleted' OR deleted_at IS NOT NULL)
    -- backend_id refers to administrator-controlled storage configuration.
    -- Its complete credential/configuration model is outside this minimal DDL.
    -- Every storage_key contains a random generation ID and is NEVER reused.
);
CREATE UNIQUE INDEX one_publishable_blob_generation
    ON expbuild_cache.blob_generation(tenant_id, project_id, namespace_id, blob_id)
    WHERE state IN ('live', 'tombstoned');
CREATE INDEX gc_candidates ON expbuild_cache.blob_generation(state, delete_not_before);

CREATE TABLE expbuild_cache.blob_visibility (
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    blob_id uuid NOT NULL,
    generation_id uuid NOT NULL,
    retain_until timestamptz NOT NULL,
    granted_by_principal_id uuid NOT NULL,
    granted_by_credential_id uuid NOT NULL,
    policy_version bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, project_id, namespace_id, blob_id),
    UNIQUE (tenant_id, project_id, namespace_id, blob_id, generation_id),
    FOREIGN KEY (tenant_id, project_id, namespace_id, blob_id, generation_id)
        REFERENCES expbuild_cache.blob_generation(tenant_id, project_id, namespace_id, blob_id, id),
    FOREIGN KEY (tenant_id, granted_by_principal_id, granted_by_credential_id)
        REFERENCES expbuild_cp.credential(tenant_id, principal_id, id),
    FOREIGN KEY (tenant_id, policy_version) REFERENCES expbuild_cp.policy_version(tenant_id, version)
    -- Presence means an authorized upload granted visibility; physical existence alone is insufficient.
    -- retain_until protects standalone CAS and metadata-fetch grace for this exact generation.
);

CREATE TABLE expbuild_cache.cache_entry (
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    id uuid NOT NULL,
    key_schema_version integer NOT NULL CHECK (key_schema_version > 0),
    opaque_tool_key bytea NOT NULL CHECK (octet_length(opaque_tool_key) BETWEEN 1 AND 512),
    generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    payload_format text NOT NULL CHECK (payload_format IN ('reapi-action-result-v2', 'opaque-archive-v1')),
    protocol_payload bytea NOT NULL,
    invocation_id text CHECK (invocation_id IS NULL OR length(invocation_id) <= 256),
    state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'invalidated')),
    writer_principal_id uuid NOT NULL,
    writer_credential_id uuid NOT NULL,
    policy_version bigint NOT NULL,
    expires_at timestamptz NOT NULL,
    pinned_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, project_id, namespace_id, id),
    UNIQUE (tenant_id, project_id, namespace_id, key_schema_version, opaque_tool_key),
    UNIQUE (tenant_id, project_id, namespace_id, id, generation),
    FOREIGN KEY (tenant_id, project_id, namespace_id) REFERENCES expbuild_cp.namespace(tenant_id, project_id, id),
    FOREIGN KEY (tenant_id, writer_principal_id, writer_credential_id) REFERENCES expbuild_cp.credential(tenant_id, principal_id, id),
    FOREIGN KEY (tenant_id, policy_version) REFERENCES expbuild_cp.policy_version(tenant_id, version)
);
CREATE INDEX entry_expiry ON expbuild_cache.cache_entry(expires_at) WHERE state = 'ready';
CREATE TABLE expbuild_cache.entry_reference (
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    entry_id uuid NOT NULL,
    entry_generation bigint NOT NULL CHECK (entry_generation > 0),
    blob_id uuid NOT NULL,
    blob_generation_id uuid NOT NULL,
    PRIMARY KEY (tenant_id, project_id, namespace_id, entry_id, entry_generation, blob_id),
    FOREIGN KEY (tenant_id, project_id, namespace_id, entry_id, entry_generation)
        REFERENCES expbuild_cache.cache_entry(tenant_id, project_id, namespace_id, id, generation),
    FOREIGN KEY (tenant_id, project_id, namespace_id, blob_id, blob_generation_id)
        REFERENCES expbuild_cache.blob_visibility(tenant_id, project_id, namespace_id, blob_id, generation_id)
    -- Flattened required closure for the selected protocol, not just direct Tree references.
);
CREATE INDEX references_by_blob ON expbuild_cache.entry_reference(tenant_id, project_id, namespace_id, blob_id, blob_generation_id);

CREATE TABLE expbuild_cache.upload_session (
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    id uuid NOT NULL,
    principal_id uuid NOT NULL,
    credential_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    policy_version_at_start bigint NOT NULL,
    authz_epoch_at_start bigint NOT NULL CHECK (authz_epoch_at_start > 0),
    policy_version_at_commit bigint,
    target_kind text NOT NULL CHECK (target_kind IN ('cas_blob', 'opaque_entry')),
    client_upload_uuid uuid,
    expected_digest bytea CHECK (expected_digest IS NULL OR octet_length(expected_digest) = 32),
    expected_size bigint CHECK (expected_size >= 0),
    key_schema_version integer CHECK (key_schema_version > 0),
    opaque_tool_key bytea CHECK (octet_length(opaque_tool_key) BETWEEN 1 AND 512),
    durable_offset bigint NOT NULL DEFAULT 0 CHECK (durable_offset >= 0),
    backend_id uuid NOT NULL,
    staging_node_id uuid NOT NULL,
    staged_locator text NOT NULL CHECK (length(staged_locator) BETWEEN 1 AND 1024),
    backend_cursor jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(backend_cursor) = 'object'),
    writer_fence bigint NOT NULL DEFAULT 1 CHECK (writer_fence > 0),
    writer_owner uuid,
    writer_lease_until timestamptz,
    state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'receiving', 'verifying', 'publishing', 'committed', 'aborted', 'expired')),
    committed_blob_id uuid,
    committed_generation_id uuid,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, project_id, namespace_id, id),
    UNIQUE (tenant_id, project_id, namespace_id, reservation_id),
    FOREIGN KEY (tenant_id, project_id, namespace_id) REFERENCES expbuild_cp.namespace(tenant_id, project_id, id),
    FOREIGN KEY (tenant_id, principal_id, credential_id) REFERENCES expbuild_cp.credential(tenant_id, principal_id, id),
    FOREIGN KEY (tenant_id, project_id, namespace_id, reservation_id, principal_id, credential_id)
        REFERENCES expbuild_cache.quota_reservation(tenant_id, project_id, namespace_id, id, principal_id, credential_id),
    FOREIGN KEY (tenant_id, policy_version_at_start) REFERENCES expbuild_cp.policy_version(tenant_id, version),
    FOREIGN KEY (tenant_id, policy_version_at_commit) REFERENCES expbuild_cp.policy_version(tenant_id, version),
    FOREIGN KEY (tenant_id, project_id, namespace_id, committed_blob_id, committed_generation_id)
        REFERENCES expbuild_cache.blob_generation(tenant_id, project_id, namespace_id, blob_id, id),
    CHECK ((writer_owner IS NULL) = (writer_lease_until IS NULL)),
    CHECK ((committed_blob_id IS NULL) = (committed_generation_id IS NULL)),
    CHECK (expected_size IS NULL OR durable_offset <= expected_size),
    CHECK (target_kind <> 'cas_blob' OR (client_upload_uuid IS NOT NULL AND expected_digest IS NOT NULL AND expected_size IS NOT NULL)),
    CHECK (target_kind <> 'opaque_entry' OR (key_schema_version IS NOT NULL AND opaque_tool_key IS NOT NULL)),
    CHECK (state <> 'committed' OR (committed_blob_id IS NOT NULL AND policy_version_at_commit IS NOT NULL))
);
CREATE UNIQUE INDEX upload_external_resource
    ON expbuild_cache.upload_session(tenant_id, project_id, namespace_id, client_upload_uuid, expected_digest, expected_size)
    WHERE target_kind = 'cas_blob';
CREATE INDEX upload_expiry ON expbuild_cache.upload_session(expires_at) WHERE state NOT IN ('committed', 'aborted', 'expired');

CREATE TABLE expbuild_cache.blob_lease (
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    id uuid NOT NULL,
    blob_id uuid NOT NULL,
    generation_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    credential_id uuid NOT NULL,
    policy_version bigint NOT NULL,
    authz_epoch bigint NOT NULL CHECK (authz_epoch > 0),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, project_id, namespace_id, id),
    FOREIGN KEY (tenant_id, project_id, namespace_id, blob_id, generation_id)
        REFERENCES expbuild_cache.blob_generation(tenant_id, project_id, namespace_id, blob_id, id),
    FOREIGN KEY (tenant_id, principal_id, credential_id) REFERENCES expbuild_cp.credential(tenant_id, principal_id, id),
    FOREIGN KEY (tenant_id, policy_version) REFERENCES expbuild_cp.policy_version(tenant_id, version)
    -- Storage protection only; this row never grants data access or renews authorization.
);
CREATE INDEX leases_by_generation ON expbuild_cache.blob_lease(tenant_id, project_id, namespace_id, blob_id, generation_id, expires_at);

CREATE TABLE expbuild_cp.audit_outbox (
    tenant_id uuid NOT NULL REFERENCES expbuild_cp.tenant(id),
    id uuid NOT NULL,
    project_id uuid,
    namespace_id uuid,
    actor_principal_id uuid,
    actor_credential_id uuid,
    policy_version bigint,
    authz_epoch bigint CHECK (authz_epoch > 0),
    producer_id text NOT NULL,
    producer_sequence bigint NOT NULL CHECK (producer_sequence > 0),
    event_type text NOT NULL,
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    request_id uuid,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    delivery_state text NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'delivering', 'delivered')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    delivery_owner uuid,
    delivery_lease_until timestamptz,
    delivered_at timestamptz,
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, producer_id, producer_sequence),
    FOREIGN KEY (tenant_id, project_id) REFERENCES expbuild_cp.project(tenant_id, id),
    FOREIGN KEY (tenant_id, project_id, namespace_id) REFERENCES expbuild_cp.namespace(tenant_id, project_id, id),
    FOREIGN KEY (tenant_id, actor_principal_id) REFERENCES expbuild_cp.principal(tenant_id, id),
    FOREIGN KEY (tenant_id, actor_principal_id, actor_credential_id) REFERENCES expbuild_cp.credential(tenant_id, principal_id, id),
    FOREIGN KEY (tenant_id, policy_version) REFERENCES expbuild_cp.policy_version(tenant_id, version),
    CHECK (namespace_id IS NULL OR project_id IS NOT NULL),
    CHECK (actor_credential_id IS NULL OR actor_principal_id IS NOT NULL),
    CHECK ((delivery_owner IS NULL) = (delivery_lease_until IS NULL)),
    CHECK (delivery_state <> 'delivered' OR delivered_at IS NOT NULL)
);
CREATE INDEX outbox_pending ON expbuild_cp.audit_outbox(next_attempt_at) WHERE delivery_state <> 'delivered';

-- Guard immutable identity/context fields. These triggers do not implement the
-- transactional publication, quota reconciliation or GC algorithms.
CREATE FUNCTION expbuild_cp.reject_changed_fields() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE field_name text;
BEGIN
    FOREACH field_name IN ARRAY TG_ARGV LOOP
        IF (to_jsonb(NEW) -> field_name) IS DISTINCT FROM (to_jsonb(OLD) -> field_name) THEN
            RAISE EXCEPTION 'immutable field %.%.%', TG_TABLE_SCHEMA, TG_TABLE_NAME, field_name;
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;
CREATE FUNCTION expbuild_cp.reject_policy_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'policy_version is append-only';
END;
$$;
CREATE TRIGGER tenant_identity BEFORE UPDATE ON expbuild_cp.tenant FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('id');
CREATE TRIGGER project_identity BEFORE UPDATE ON expbuild_cp.project FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'id');
CREATE TRIGGER principal_identity BEFORE UPDATE ON expbuild_cp.principal FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'id', 'kind');
CREATE TRIGGER credential_identity BEFORE UPDATE ON expbuild_cp.credential FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'id', 'principal_id');
CREATE TRIGGER namespace_identity BEFORE UPDATE ON expbuild_cp.namespace FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'project_id', 'id', 'protocol_id', 'trust_domain');
CREATE TRIGGER policy_append_only BEFORE UPDATE OR DELETE ON expbuild_cp.policy_version FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_policy_change();
CREATE TRIGGER quota_account_identity BEFORE UPDATE ON expbuild_cache.quota_account FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'project_id', 'namespace_id');
CREATE TRIGGER quota_reservation_identity BEFORE UPDATE ON expbuild_cache.quota_reservation FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'project_id', 'namespace_id', 'id', 'principal_id', 'credential_id');
CREATE TRIGGER blob_identity_immutable BEFORE UPDATE ON expbuild_cache.blob_identity FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'project_id', 'namespace_id', 'id', 'digest_algorithm', 'digest', 'logical_size');
CREATE TRIGGER generation_identity BEFORE UPDATE ON expbuild_cache.blob_generation FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'project_id', 'namespace_id', 'blob_id', 'id', 'backend_id', 'storage_key', 'backend_version', 'encoding', 'physical_size', 'published_at');
CREATE TRIGGER visibility_identity BEFORE UPDATE ON expbuild_cache.blob_visibility FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'project_id', 'namespace_id', 'blob_id', 'generation_id', 'granted_by_principal_id', 'granted_by_credential_id', 'policy_version');
CREATE TRIGGER entry_identity BEFORE UPDATE ON expbuild_cache.cache_entry FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'project_id', 'namespace_id', 'id', 'key_schema_version', 'opaque_tool_key');
CREATE TRIGGER entry_reference_identity BEFORE UPDATE ON expbuild_cache.entry_reference FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'project_id', 'namespace_id', 'entry_id', 'entry_generation', 'blob_id', 'blob_generation_id');
CREATE TRIGGER upload_identity BEFORE UPDATE ON expbuild_cache.upload_session FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'project_id', 'namespace_id', 'id', 'principal_id', 'credential_id', 'reservation_id', 'policy_version_at_start', 'authz_epoch_at_start', 'target_kind', 'client_upload_uuid', 'expected_digest', 'expected_size', 'key_schema_version', 'opaque_tool_key', 'backend_id', 'staging_node_id');
CREATE TRIGGER lease_identity BEFORE UPDATE ON expbuild_cache.blob_lease FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'project_id', 'namespace_id', 'id', 'blob_id', 'generation_id', 'principal_id', 'credential_id');
CREATE TRIGGER outbox_envelope_immutable BEFORE UPDATE ON expbuild_cp.audit_outbox FOR EACH ROW
EXECUTE FUNCTION expbuild_cp.reject_changed_fields('tenant_id', 'id', 'project_id', 'namespace_id', 'actor_principal_id', 'actor_credential_id', 'policy_version', 'authz_epoch', 'producer_id', 'producer_sequence', 'event_type', 'schema_version', 'request_id', 'occurred_at', 'payload');
COMMIT;
