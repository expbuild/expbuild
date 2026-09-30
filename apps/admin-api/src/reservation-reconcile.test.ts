import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { reservationFloor } from "./reservation-reconcile.js";
import { desiredObject, instanceInput } from "./instance-contract.js";
import type { InventoryBinding, InventoryResources } from "./inventory.js";
import type { KubernetesPort } from "./kubernetes.js";
import { createPool, migrate } from "./db.js";
import { buildApp } from "./app.js";
import { hashPassword } from "./security.js";

function fixture(projectId: string, instanceId: string): {binding: InventoryBinding; resources: InventoryResources} {
  const cr=desiredObject(instanceInput.parse({name:"cache",storageGiB:3,cacheGiB:1}),projectId,"project-ns",instanceId,"standard","operation","hash");
  cr.metadata.uid="cr-uid";
  const binding: InventoryBinding={id:instanceId,resource_name:cr.metadata.name,kubernetes_uid:"cr-uid",lifecycle:"active",template_name:"bazel-remote",template_version:"0.1.0",reserved_storage_gib:null,reserved_cpu_millis:null,reserved_memory_mib:null,busy:false,expected_spec:structuredClone(cr.spec),operation_stamp:null};
  const resources: InventoryResources={instances:[cr],volumes:[{metadata:{name:cr.metadata.name+"-data",uid:"pvc-uid",labels:{...cr.metadata.labels,"cache.expbuild.io/instance-uid":"cr-uid"}},spec:{resources:{requests:{storage:"3500Mi"}}},status:{phase:"Bound",capacity:{storage:"3500Mi"}}}]};
  return {binding,resources};
}

test("reservation floor rounds upward and rejects uncertain identity or quantity",()=>{
  const {binding,resources}=fixture("project","instance");
  resources.instances[0].spec.resources.limits.cpu="500.1m";
  binding.expected_spec=structuredClone(resources.instances[0].spec);
  assert.deepEqual(reservationFloor("project",binding,resources),{storageGiB:4,cpuMillis:501,memoryMiB:512});
  resources.volumes[0].metadata!.labels!["cache.expbuild.io/instance-uid"]="foreign";
  assert.throws(()=>reservationFloor("project",binding,resources),/identity or configuration drift/);
  resources.volumes[0].metadata!.labels!["cache.expbuild.io/instance-uid"]="cr-uid";
  resources.volumes[0].status!.capacity!.storage="broken";
  assert.throws(()=>reservationFloor("project",binding,resources),/quantity/);
  resources.volumes[0].status!.capacity!.storage="3500Mi";
  binding.busy=true;
  assert.throws(()=>reservationFloor("project",binding,resources),/not stable/);
  binding.busy=false;
  binding.lifecycle="detached";
  assert.throws(()=>reservationFloor("project",binding,resources),/identity or configuration drift/);
  resources.instances=[];
  assert.deepEqual(reservationFloor("project",binding,resources),{storageGiB:4,cpuMillis:0,memoryMiB:0});
});

test("platform administrator reconciles only high-water reservations after fresh scan",{skip:!process.env.TEST_DATABASE_URL},async()=>{
  const root=createPool(process.env.TEST_DATABASE_URL!),database="reservation_"+randomUUID().replaceAll("-","");
  await root.query(`CREATE DATABASE "${database}"`);
  const url=new URL(process.env.TEST_DATABASE_URL!);url.pathname="/"+database;
  const pool=createPool(url.toString());
  const origin="http://localhost:5173",projectId=randomUUID(),instanceId=randomUUID(),adminId=randomUUID(),memberId=randomUUID();
  const {binding,resources}=fixture(projectId,instanceId);
  let onScan=async()=>{};
  const kube={inspectProjectResources:async()=>{await onScan();return resources;}} as unknown as KubernetesPort;
  const app=await buildApp(pool,{origin,secureCookies:false,kube});
  try {
    await migrate(pool);
    const password="test-password-with-enough-length",passwordHash=await hashPassword(password);
    await pool.query("INSERT INTO users(id,email,password_hash,platform_admin) VALUES($1,'platform@example.test',$3,true),($2,'member@example.test',$3,false)",[adminId,memberId,passwordHash]);
    await pool.query("INSERT INTO projects(id,name,namespace,state,created_by) VALUES($1,'Test','project-ns','ready',$2)",[projectId,adminId]);
    await pool.query("UPDATE projects SET quota_limits=$2 WHERE id=$1",[projectId,JSON.stringify({instances:null,storageGiB:3,cpuMillis:null,memoryMiB:null})]);
    await pool.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')",[projectId,memberId]);
    await pool.query("INSERT INTO instance_bindings(id,project_id,resource_name,kubernetes_uid,lifecycle,created_by,template_name,template_version) VALUES($1,$2,$3,'cr-uid','active',$4,'bazel-remote','0.1.0')",[instanceId,projectId,binding.resource_name,adminId]);
    const login=async(email:string)=>{
      const response=await app.inject({method:"POST",url:"/v1/auth/login",headers:{origin},payload:{email,password}});
      assert.equal(response.statusCode,200,response.body);
      return {origin,cookie:`expbuild_session=${response.cookies[0]!.value}`,"x-csrf-token":response.json().csrfToken as string};
    };
    const admin=await login("platform@example.test"),member=await login("member@example.test");
    const path=`/v1/projects/${projectId}/instances/${instanceId}/reservations/reconcile`;
    assert.equal((await app.inject({method:"POST",url:path,headers:member})).statusCode,403);
    let response=await app.inject({method:"POST",url:path,headers:admin});
    assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(response.json().reserved,{storageGiB:"4",cpuMillis:"500",memoryMiB:"512"});
    const quota=await app.inject({url:`/v1/projects/${projectId}/quota`,headers:admin});
    assert.equal(quota.statusCode,200,quota.body);
    assert.equal(quota.json().reserved.storageGiB,4,"actual over-quota usage is accounted for instead of hidden");
    let audit=await pool.query("SELECT action,details FROM audit_events WHERE action='reservation.reconcile'");
    assert.equal(audit.rowCount,1);
    assert.equal(audit.rows[0].details.before.storageGiB,null);
    resources.volumes[0].status!.capacity!.storage="3Gi";
    response=await app.inject({method:"POST",url:path,headers:admin});
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().reserved.storageGiB,"4","reconciliation never releases high-water storage");
    onScan=async()=>{await pool.query("UPDATE instance_bindings SET reserved_cpu_millis=700 WHERE id=$1",[instanceId]);};
    response=await app.inject({method:"POST",url:path,headers:admin});
    assert.equal(response.statusCode,409,"concurrent platform changes invalidate the scan");
    audit=await pool.query("SELECT action FROM audit_events WHERE action='reservation.reconcile'");
    assert.equal(audit.rowCount,2);
    assert.equal((await pool.query("SELECT reserved_cpu_millis FROM instance_bindings WHERE id=$1",[instanceId])).rows[0].reserved_cpu_millis,"700");
  } finally {
    await app.close();await pool.end();
    await root.query(`DROP DATABASE "${database}"`);await root.end();
  }
});
