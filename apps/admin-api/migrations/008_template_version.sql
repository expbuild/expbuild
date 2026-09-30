-- Preserve version identity after the Kubernetes object has been removed.
-- Unknown or conflicting history stays unknown rather than assuming latest.
ALTER TABLE instance_bindings ADD COLUMN template_version text;
WITH versions AS (
  SELECT b.id, min(o.request #>> '{desired,spec,templateRef,version}') AS version
  FROM instance_bindings b JOIN operations o ON o.instance_id=b.id
  WHERE o.kind='instance.create'
    AND o.request #>> '{desired,spec,templateRef,name}' = b.template_name
    AND nullif(o.request #>> '{desired,spec,templateRef,version}', '') IS NOT NULL
  GROUP BY b.id
  HAVING count(DISTINCT o.request #>> '{desired,spec,templateRef,version}')=1
)
UPDATE instance_bindings b SET template_version=v.version FROM versions v WHERE b.id=v.id;
