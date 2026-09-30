import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, migrate } from './db.js';
import { instanceCapabilities } from './template-catalog.js';

test('template migration preserves exact historical versions and leaves missing/conflicting history unknown', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const root = createPool(process.env.TEST_DATABASE_URL!), database = `expbuild_test_${randomUUID().replaceAll('-', '')}`;
  await root.query(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${database}`;
  const pool = createPool(url.toString());
  try {
    await migrate(pool);
    await pool.query('ALTER TABLE instance_bindings DROP COLUMN template_version');
    await pool.query("DELETE FROM schema_migrations WHERE name='008_template_version.sql'");
    const user = randomUUID(), project = randomUUID();
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'migration@test.local','unused')", [user]);
    await pool.query("INSERT INTO projects(id,name,namespace,created_by) VALUES($1,'migration','migration',$2)", [project,user]);
    const cases = [
      { name:'known', versions:['0.1.0'], expected:'0.1.0' },
      { name:'future', versions:['9.0.0'], expected:'9.0.0' },
      { name:'missing', versions:[], expected:null },
      { name:'conflict', versions:['0.1.0','9.0.0'], expected:null },
    ];
    for (const entry of cases) {
      const id = randomUUID();
      await pool.query("INSERT INTO instance_bindings(id,project_id,resource_name,created_by,lifecycle) VALUES($1,$2,$3,$4,'deleted')", [id,project,entry.name,user]);
      for (const version of entry.versions) {
        await pool.query("INSERT INTO operations(id,project_id,instance_id,kind,idempotency_key,request_hash,request,state,created_by) VALUES($1,$2,$3,'instance.create',$4,'hash',$5,'succeeded',$6)", [randomUUID(),project,id,randomUUID(),{desired:{spec:{templateRef:{name:'bazel-remote',version}}}},user]);
      }
    }
    await migrate(pool);
    await migrate(pool);
    const rows = (await pool.query('SELECT resource_name,template_version FROM instance_bindings')).rows;
    for (const entry of cases) assert.equal(rows.find(r => r.resource_name===entry.name)?.template_version, entry.expected);
    assert.equal(instanceCapabilities('bazel-remote',null), null);
    assert.equal(instanceCapabilities('bazel-remote','9.0.0'), null);
    assert.equal(instanceCapabilities('bazel-remote','0.1.0')?.lookupHistory, true);
  } finally {
    await pool.end(); await root.query(`DROP DATABASE "${database}" WITH (FORCE)`); await root.end();
  }
});
