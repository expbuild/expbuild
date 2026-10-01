ALTER TABLE instance_bindings ADD COLUMN template_name text NOT NULL DEFAULT 'bazel-remote';
-- Recover the immutable engine for instances created before this column existed.
UPDATE instance_bindings AS b
SET template_name = o.request #>> '{desired,spec,templateRef,name}'
FROM operations AS o
WHERE o.instance_id = b.id AND o.kind = 'instance.create'
  AND o.request #>> '{desired,spec,templateRef,name}' IS NOT NULL;
