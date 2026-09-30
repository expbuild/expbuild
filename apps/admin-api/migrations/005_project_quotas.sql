ALTER TABLE projects ADD COLUMN quota_limits jsonb NOT NULL DEFAULT '{"instances":null,"storageGiB":null,"cpuMillis":null,"memoryMiB":null}';
ALTER TABLE projects ADD COLUMN quota_revision bigint NOT NULL DEFAULT 1;
ALTER TABLE instance_bindings ADD COLUMN reserved_storage_gib bigint CHECK (reserved_storage_gib >= 0);
ALTER TABLE instance_bindings ADD COLUMN reserved_cpu_millis bigint CHECK (reserved_cpu_millis >= 0);
ALTER TABLE instance_bindings ADD COLUMN reserved_memory_mib bigint CHECK (reserved_memory_mib >= 0);

-- Existing operations contain the API-rendered desired resources. Use the
-- historical high-water mark: a failed expansion may already have applied.
-- Unrecoverable legacy reservations stay NULL and prevent enabling limits.
WITH reservations AS (
 SELECT instance_id,
 max(CASE WHEN request #>> '{desired,spec,storage,capacity}' ~ '^[0-9]+Gi$'
     THEN replace(request #>> '{desired,spec,storage,capacity}', 'Gi', '')::bigint END) AS storage,
 max(CASE WHEN request #>> '{desired,spec,resources,requests,cpu}' ~ '^[0-9]+m$'
     THEN replace(request #>> '{desired,spec,resources,requests,cpu}', 'm', '')::bigint END) AS cpu,
 max(CASE WHEN request #>> '{desired,spec,resources,requests,memory}' ~ '^[0-9]+Mi$'
     THEN replace(request #>> '{desired,spec,resources,requests,memory}', 'Mi', '')::bigint END) AS memory
 FROM operations GROUP BY instance_id
)
UPDATE instance_bindings i SET reserved_storage_gib=r.storage,
 reserved_cpu_millis=r.cpu, reserved_memory_mib=r.memory
FROM reservations r WHERE i.id=r.instance_id;
