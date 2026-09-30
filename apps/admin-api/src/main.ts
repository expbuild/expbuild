import { createPool } from './db.js';
import { buildApp } from './app.js';
import { KubernetesClient } from './kubernetes.js';
import { OperationWorker } from './worker.js';
import { PrometheusHistory } from './history.js';
import { encryptionKey } from './secrets.js';

const connection = process.env.DATABASE_URL;
const origin = process.env.APP_ORIGIN;
if (!connection || !origin) throw new Error('DATABASE_URL and APP_ORIGIN are required');
if (new URL(origin).origin !== origin) throw new Error('APP_ORIGIN must be an origin without a path');
const pool = createPool(connection);
const key=encryptionKey(process.env.OPERATION_ENCRYPTION_KEY??'');
const kube=new KubernetesClient();
const storageClass=process.env.STORAGE_CLASS;
if(!storageClass)throw new Error('STORAGE_CLASS is required');
const app = await buildApp(pool, { origin, secureCookies: !origin.startsWith('http://localhost:') && !origin.startsWith('http://127.0.0.1:'),kube,gatewayEnabled:process.env.GATEWAY_ENABLED === 'true',webdavEnabled:process.env.WEBDAV_ENABLED === 'true',statistics:kube,history:process.env.PROMETHEUS_URL ? new PrometheusHistory(process.env.PROMETHEUS_URL) : undefined,encryptionKey:key,storageClass });
const worker=new OperationWorker(pool,kube,key);
let closing = false;
const work=(async()=>{while(!closing){try{if(await worker.tick())continue;}catch{app.log.error('Operation worker failed; retrying');}await new Promise(resolve=>setTimeout(resolve,1000));}})();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => {
  if (closing) return; closing = true; await app.close(); await work; await pool.end();
});
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3001) });
