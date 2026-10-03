import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { buildApp } from '../../apps/admin-api/src/app.js';
import { createPool, migrate } from '../../apps/admin-api/src/db.js';
import { hashPassword } from '../../apps/admin-api/src/security.js';
import { OperationWorker } from '../../apps/admin-api/src/worker.js';
import { BrowserCluster } from './cluster.mjs';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL must point to an isolated test PostgreSQL server');
const root = createPool(process.env.TEST_DATABASE_URL);
const database = `expbuild_browser_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${database}`;
const pool = createPool(url.toString());
let created = false, closing = false;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let work: Promise<void> | undefined;
async function close() {
  if (closing) return;
  closing = true;
  try { await work; await app?.close(); }
  finally {
    await pool.end();
    try { if (created) await root.query(`DROP DATABASE "${database}" WITH (FORCE)`); }
    finally { await root.end(); }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close().catch(() => { process.exitCode = 1; }); });
try {
  await root.query(`CREATE DATABASE "${database}"`); created = true;
  await migrate(pool);
  const password = await hashPassword('browser-test-password');
  for (const [email, admin] of [['admin@browser.test', true], ['outsider@browser.test', false]] as const) {
    await pool.query('INSERT INTO users(id,email,password_hash,platform_admin) VALUES($1,$2,$3,$4)', [randomUUID(), email, password, admin]);
  }
  const kube = new BrowserCluster();
  const key = randomBytes(32);
  app = await buildApp(pool, { origin: 'http://127.0.0.1:4173', secureCookies: false, kube, encryptionKey: key, storageClass: 'browser-test', gradleEnabled: true, webdavEnabled: true });
  const worker = new OperationWorker(pool, kube, key);
  work = (async () => {
    while (!closing) {
      try { if (await worker.tick()) continue; }
      catch (error) { app?.log.error(error, 'Browser operation worker failed'); }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  })();
  // Serve the actual production build and API. The isolated Kubernetes
  // boundary makes lifecycle operations deterministic without a local cluster.
  const directory = new URL('../../apps/admin-web/dist/', import.meta.url);
  const contentTypes: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  for (const file of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const path = join(file.parentPath, file.name);
    const relative = path.slice(directory.pathname.length);
    const body = await readFile(path);
    app.get(relative === 'index.html' ? '/' : '/' + relative, async (_request, reply) => reply.type(contentTypes[extname(file.name)] ?? 'application/octet-stream').send(body));
  }
  await app.listen({ host: '127.0.0.1', port: 4173 });
} catch (error) {
  await close();
  throw error;
}
