import { ResourceInventory } from './inventory.js';
import { ProjectQuotaSync } from './quota-sync.js';
import { createPool } from './db.js';
import { buildApp } from './app.js';
import { KubernetesClient } from './kubernetes.js';
import { OperationWorker } from './worker.js';
import { PrometheusHistory } from './history.js';
import { encryptionKey } from './secrets.js';
import { Telemetry } from './telemetry.js';
import { Backend, ObservationMetrics, ObservationLogs, ObservationAlerts } from './observation-backends.js';
import { ObservationCollector } from './observation-store.js';
import { AlertReconciliation } from './alert-reconciliation.js';

const connection = process.env.DATABASE_URL;
const origin = process.env.APP_ORIGIN;
if (!connection || !origin) throw new Error('DATABASE_URL and APP_ORIGIN are required');
if (new URL(origin).origin !== origin) throw new Error('APP_ORIGIN must be an origin without a path');
const pool = createPool(connection);
const key=encryptionKey(process.env.OPERATION_ENCRYPTION_KEY??'');
const kube=new KubernetesClient();
const storageClass=process.env.STORAGE_CLASS;
if(!storageClass)throw new Error('STORAGE_CLASS is required');
if (process.env.PROMETHEUS_BEARER_TOKEN !== undefined && !process.env.PROMETHEUS_URL) throw new Error('Prometheus query authentication requires PROMETHEUS_URL');
const telemetry = new Telemetry(process.env.OBSERVABILITY_CLUSTER_ID ?? 'primary');
const observability = {
  metrics: process.env.PROMETHEUS_URL ? new ObservationMetrics(new Backend(process.env.PROMETHEUS_URL, process.env.PROMETHEUS_BEARER_TOKEN), telemetry.clusterId) : undefined,
  logs: process.env.LOKI_URL ? new ObservationLogs(new Backend(process.env.LOKI_URL, process.env.LOKI_BEARER_TOKEN), telemetry.clusterId) : undefined,
  alerts: process.env.ALERTMANAGER_URL ? new ObservationAlerts(new Backend(process.env.ALERTMANAGER_URL, process.env.ALERTMANAGER_BEARER_TOKEN), telemetry.clusterId) : undefined,
  webhookToken: process.env.ALERT_WEBHOOK_TOKEN,
};
const app = await buildApp(pool, { origin, logging: true, telemetry, observability, metricsToken: process.env.METRICS_SCRAPE_TOKEN, secureCookies: !origin.startsWith('http://localhost:') && !origin.startsWith('http://127.0.0.1:'),kube,gatewayEnabled:process.env.GATEWAY_ENABLED === 'true',webdavEnabled:process.env.WEBDAV_ENABLED === 'true',gradleEnabled:process.env.GRADLE_ENABLED === 'true',turborepoEnabled:process.env.TURBOREPO_ENABLED === 'true',nxEnabled:process.env.NX_ENABLED === 'true',goCacheEnabled:process.env.GO_CACHE_ENABLED === 'true',statistics:kube,history:process.env.PROMETHEUS_URL ? new PrometheusHistory(process.env.PROMETHEUS_URL, fetch, () => Date.now(), { bearerToken: process.env.PROMETHEUS_BEARER_TOKEN }) : undefined,encryptionKey:key,storageClass });
const observations = new ObservationCollector(pool,kube,telemetry);
const alertReconciliation=observability.alerts&&observability.webhookToken?new AlertReconciliation(pool,observability.alerts):undefined;
const quotas=new ProjectQuotaSync(pool,kube);
const inventory=new ResourceInventory(pool,kube);
const worker=new OperationWorker(pool,kube,key,id=>quotas.ensure(id),telemetry);
let closing = false;
const work=(async()=>{while(!closing){try{if(await telemetry.run('operations',()=>worker.tick()))continue;}catch{app.log.error({event:'worker.failed',worker:'operations'},'Worker failed; retrying');}await new Promise(resolve=>setTimeout(resolve,1000));}})();
const quotaWork=(async()=>{while(!closing){try{if(await telemetry.run('quotas',()=>quotas.tick()))continue;}catch{app.log.error({event:'worker.failed',worker:'quotas'},'Worker failed; retrying');}await new Promise(resolve=>setTimeout(resolve,1000));}})();
const inventoryWork=(async()=>{while(!closing){try{if(await telemetry.run('inventory',()=>inventory.tick()))continue;}catch{app.log.error({event:'worker.failed',worker:'inventory'},'Worker failed; retrying');}await new Promise(resolve=>setTimeout(resolve,1000));}})();
const observationWork=(async()=>{let lastControl=0;while(!closing){try{if(Date.now()-lastControl>30_000){await telemetry.observeControlPlane(pool);lastControl=Date.now();}if(await telemetry.run('observability',()=>observations.tick()))continue;}catch{app.log.error({event:'worker.failed',worker:'observability'},'Observation collection unavailable');}for(let i=0;i<30&&!closing;i++)await new Promise(resolve=>setTimeout(resolve,1000));}})();
const alertWork=(async()=>{while(!closing&&alertReconciliation){try{await alertReconciliation.tick();}catch{app.log.error({event:'alerts.reconciliation.failed'},'Alert reconciliation unavailable');}for(let i=0;i<60&&!closing;i++)await new Promise(resolve=>setTimeout(resolve,1000));}})();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => {
  if (closing) return; closing = true; await app.close(); await Promise.all([work,quotaWork,inventoryWork,observationWork,alertWork]); await observations.close(); await pool.end();
});
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3001) });
