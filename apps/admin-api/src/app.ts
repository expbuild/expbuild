import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { digest, hashPassword, token, verifyPassword } from './security.js';
import { quotaInput, quotaSnapshot, checkQuota } from './quotas.js';
import { transaction } from './db.js';
import { HttpError } from './errors.js';
import { openapi } from './openapi.js';
import { registerInstanceRoutes, type InstanceOptions } from './instance-routes.js';

type User = { id: string; email: string; platform_admin: boolean };
type Role = 'admin' | 'maintainer' | 'viewer';
const uuid = z.string().uuid();
const loginBody = z.object({ email: z.string().email().max(254).transform(x => x.toLowerCase()), password: z.string().min(1).max(1024) }).strict();

export async function buildApp(pool: pg.Pool, options: { origin: string; secureCookies: boolean } & InstanceOptions) {
  const app = Fastify({ bodyLimit: 64 * 1024, logger: false });
  await app.register(cookie);
  const dummyHash = await hashPassword(token());
  // Bounded process-local login throttle; deployment-wide throttling comes at ingress.
  const loginAttempts = new Map<string, { count: number; until: number }>();
  app.addHook('onRequest', async request => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== options.origin) {
      throw new HttpError(403, 'Invalid origin');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', issues: error.issues.map(x => ({ path: x.path, message: x.message })) });
    const e = error as Error & { code?: string; statusCode?: number };
    if (e.code === '23505') return reply.code(409).send({ error: 'Resource already exists' });
    const status = error instanceof HttpError ? error.statusCode : e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500;
    return reply.code(status).send({ error: status === 500 ? 'Internal server error' : e.message });
  });

  async function user(request: FastifyRequest): Promise<User> {
    const sessionToken = request.cookies.expbuild_session;
    if (!sessionToken || sessionToken.length > 128) throw new HttpError(401, 'Authentication required');
    const result = await pool.query(
      'SELECT u.id,u.email,u.platform_admin,s.csrf_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true', [digest(sessionToken)]);
    const found = result.rows[0];
    if (!found) throw new HttpError(401, 'Authentication required');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || csrf.length > 128 || digest(csrf) !== found.csrf_hash) throw new HttpError(403, 'Invalid CSRF token');
    }
    return { id: found.id, email: found.email, platform_admin: found.platform_admin };
  }

  async function projectAccess(request: FastifyRequest, projectId: string, allowed: Role[]) {
    const actor = await user(request);
    const result = await pool.query('SELECT p.id,m.role FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=$2 WHERE p.id=$1', [projectId, actor.id]);
    const project = result.rows[0];
    if (!project || (!actor.platform_admin && !project.role)) throw new HttpError(404, 'Project not found');
    if (!actor.platform_admin && !allowed.includes(project.role)) throw new HttpError(403, 'Permission denied');
    return actor;
  }

  app.get('/v1/openapi.json',async request=>{await user(request);return openapi;});
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => { await pool.query('SELECT 1'); return { ok: true }; });
  app.post('/v1/auth/login', async (request, reply) => {
    const body = loginBody.parse(request.body);
    const now = Date.now();
    for (const [key, value] of loginAttempts) if (value.until < now) loginAttempts.delete(key);
    const key = request.ip;
    const attempt = loginAttempts.get(key) ?? { count: 0, until: now + 60_000 };
    if (attempt.count >= 10 || (!loginAttempts.has(key) && loginAttempts.size >= 10000)) throw new HttpError(429, 'Too many login attempts');
    attempt.count++; loginAttempts.set(key, attempt);
    const result = await pool.query('SELECT id,password_hash,active FROM users WHERE email=$1', [body.email]);
    const found = result.rows[0];
    const valid = await verifyPassword(body.password, found?.password_hash ?? dummyHash);
    if (!found?.active || !valid) throw new HttpError(401, 'Invalid credentials');
    const sessionToken = token(), csrf = token();
    await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(73942102)');
      const fresh = await client.query('SELECT active,password_hash FROM users WHERE id=$1', [found.id]);
      if (!fresh.rows[0]?.active || fresh.rows[0].password_hash !== found.password_hash) throw new HttpError(401, 'Credentials changed; sign in again');
      if (request.cookies.expbuild_session) await client.query('DELETE FROM sessions WHERE token_hash=$1', [digest(request.cookies.expbuild_session)]);
      await client.query("INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')", [digest(sessionToken), found.id, digest(csrf)]);
      await client.query("INSERT INTO audit_events(id,actor_id,action) VALUES($1,$2,'auth.login')", [randomUUID(), found.id]);
    });
    reply.setCookie('expbuild_session', sessionToken, { path: '/', httpOnly: true, secure: options.secureCookies, sameSite: 'strict', maxAge: 86400 });
    return { csrfToken: csrf };
  });
  app.get('/v1/auth/me', async request => ({ user: await user(request) }));
  app.post('/v1/auth/logout', async (request, reply) => {
    await user(request);
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [digest(request.cookies.expbuild_session!)]);
    reply.clearCookie('expbuild_session', { path: '/', secure: options.secureCookies, sameSite: 'strict', httpOnly: true });
    return { ok: true };
  });

  async function updatePassword(request: FastifyRequest, targetId: string, password: string, currentPassword?: string) {
    const actor = await user(request);
    const self = targetId === actor.id;
    if (!self && !actor.platform_admin) throw new HttpError(403, 'Platform administrator required');
    const passwordHash = await hashPassword(password);
    await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(73942102)');
      const fresh = await client.query('SELECT u.active,u.platform_admin FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.token_hash=$2 AND s.expires_at>now()', [actor.id,digest(request.cookies.expbuild_session!)]);
      if (!fresh.rows[0]?.active || (!self && !fresh.rows[0].platform_admin)) throw new HttpError(403, 'Permission denied');
      const target = await client.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [targetId]);
      if (!target.rows[0]) throw new HttpError(404, 'User not found');
      if (self && (!currentPassword || !await verifyPassword(currentPassword,target.rows[0].password_hash))) throw new HttpError(403,'Current password is incorrect');
      await client.query('UPDATE users SET password_hash=$2 WHERE id=$1',[targetId,passwordHash]);
      await client.query('DELETE FROM sessions WHERE user_id=$1',[targetId]);
      await client.query('INSERT INTO audit_events(id,actor_id,action,details) VALUES($1,$2,$3,$4)',[randomUUID(),actor.id,self?'auth.password.change':'user.password.reset',JSON.stringify({userId:targetId})]);
    });
  }
  app.post('/v1/auth/password',async(request,reply)=>{
    const actor=await user(request);
    const body=z.object({currentPassword:z.string().min(1).max(1024),password:z.string().min(12).max(1024)}).strict().parse(request.body);
    await updatePassword(request,actor.id,body.password,body.currentPassword);
    reply.clearCookie('expbuild_session',{path:'/',secure:options.secureCookies,sameSite:'strict',httpOnly:true});
    return {ok:true,reauthenticate:true};
  });
  app.post('/v1/users/:userId/password',async request=>{
    const actor=await user(request);
    if(!actor.platform_admin)throw new HttpError(403,'Platform administrator required');
    const targetId=uuid.parse((request.params as {userId:string}).userId);
    if(targetId===actor.id)throw new HttpError(400,'Use the account password change endpoint');
    const body=z.object({password:z.string().min(12).max(1024)}).strict().parse(request.body);
    await updatePassword(request,targetId,body.password);
    return {ok:true};
  });

  app.get('/v1/users', async request => {
    const actor = await user(request);
    if (!actor.platform_admin) throw new HttpError(403, 'Platform administrator required');
    const result = await pool.query('SELECT id,email,active,platform_admin,created_at FROM users ORDER BY created_at DESC LIMIT 200');
    return { items: result.rows };
  });
  app.post('/v1/users', async (request, reply) => {
    const actor = await user(request);
    if (!actor.platform_admin) throw new HttpError(403, 'Platform administrator required');
    const body = z.object({ email: z.string().email().max(254).transform(x => x.toLowerCase()), password: z.string().min(12).max(1024) }).strict().parse(request.body);
    const id = randomUUID(), passwordHash = await hashPassword(body.password);
    await transaction(pool, async client => {
      await client.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [id, body.email, passwordHash]);
      await client.query("INSERT INTO audit_events(id,actor_id,action,details) VALUES($1,$2,'user.create',$3)", [randomUUID(), actor.id, JSON.stringify({ userId: id })]);
    });
    return reply.code(201).send({ id, email: body.email });
  });
  app.patch('/v1/users/:userId', async request => {
    const actor = await user(request);
    if (!actor.platform_admin) throw new HttpError(403, 'Platform administrator required');
    const targetId = uuid.parse((request.params as { userId: string }).userId);
    const body = z.object({ active: z.boolean() }).strict().parse(request.body);
    if (targetId === actor.id && !body.active) throw new HttpError(409, 'Cannot disable your own account');
    await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(73942102)');
      const target = await client.query('SELECT id,platform_admin FROM users WHERE id=$1 FOR UPDATE', [targetId]);
      if (!target.rows.length) throw new HttpError(404, 'User not found');
      if (!body.active) {
        // Disabling a project administrator must not leave a project unmanaged.
        const orphaned = await client.query("SELECT m.project_id FROM project_members m WHERE m.user_id=$1 AND m.role='admin' AND NOT EXISTS (SELECT 1 FROM project_members other JOIN users u ON u.id=other.user_id WHERE other.project_id=m.project_id AND other.role='admin' AND other.user_id<>$1 AND u.active)", [targetId]);
        if (orphaned.rows.length) throw new HttpError(409, 'Transfer project administration before disabling this account');
        const admins = await client.query('SELECT id FROM users WHERE platform_admin AND active AND id<>$1', [targetId]);
        if (target.rows[0].platform_admin && !admins.rows.length) throw new HttpError(409, 'Platform must retain an administrator');
        await client.query('DELETE FROM sessions WHERE user_id=$1', [targetId]);
      }
      await client.query('UPDATE users SET active=$2 WHERE id=$1', [targetId, body.active]);
      await client.query("INSERT INTO audit_events(id,actor_id,action,details) VALUES($1,$2,'user.update',$3)", [randomUUID(), actor.id, JSON.stringify({ userId: targetId, active: body.active })]);
    });
    return { ok: true };
  });

  app.get('/v1/projects', async request => {
    const actor = await user(request);
    const result = actor.platform_admin
      ? await pool.query('SELECT id,name,namespace,state FROM projects ORDER BY created_at DESC LIMIT 200')
      : await pool.query('SELECT p.id,p.name,p.namespace,p.state,m.role FROM projects p JOIN project_members m ON m.project_id=p.id WHERE m.user_id=$1 ORDER BY p.created_at DESC LIMIT 200', [actor.id]);
    return { items: result.rows };
  });
  app.post('/v1/projects', async (request, reply) => {
    const actor = await user(request); if (!actor.platform_admin) throw new HttpError(403, 'Platform administrator required');
    const body = z.object({ name: z.string().trim().min(1).max(100) }).strict().parse(request.body);
    const id = randomUUID(), namespace = `expbuild-${id}`;
    await transaction(pool, async client => {
      await client.query('INSERT INTO projects(id,name,namespace,created_by) VALUES($1,$2,$3,$4)', [id, body.name, namespace, actor.id]);
      await client.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')", [id, actor.id]);
      await client.query("INSERT INTO operations(id,project_id,kind,idempotency_key,request_hash,request,created_by) VALUES($1,$2,'project.create',$6,$3,$4,$5)", [randomUUID(),id,digest(namespace),JSON.stringify({namespace}),actor.id,id]);
      await client.query("INSERT INTO audit_events(id,actor_id,project_id,action) VALUES($1,$2,$3,'project.create')", [randomUUID(), actor.id, id]);
    });
    return reply.code(202).send({ id, namespace, state: 'pending' });
  });
  app.get('/v1/projects/:projectId/quota', async (request, reply) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    await projectAccess(request, projectId, ['admin', 'maintainer', 'viewer']);
    const snapshot = await transaction(pool, async client => {
      await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
      return quotaSnapshot(client, projectId);
    });
    return reply.header('Cache-Control', 'no-store').header('ETag', `"${snapshot.revision}"`).send(snapshot);
  });
  app.put('/v1/projects/:projectId/quota', async (request, reply) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    const actor = await projectAccess(request, projectId, ['admin']);
    if (!actor.platform_admin) throw new HttpError(403, 'Platform administrator required');
    const limits = quotaInput.parse(request.body);
    const expected = z.string().regex(/^"?[1-9][0-9]*"?$/).parse(request.headers['if-match']).replaceAll('"', '');
    const snapshot = await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(73942102)');
      await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
      const fresh = (await client.query('SELECT active,platform_admin FROM users WHERE id=$1', [actor.id])).rows[0];
      if (!fresh?.active || !fresh.platform_admin) throw new HttpError(403, 'Platform administrator required');
      const current = await quotaSnapshot(client, projectId);
      if (current.revision !== expected) throw new HttpError(409, 'Project quota changed');
      checkQuota(limits, current.reserved, current.unknownReservations);
      await client.query('UPDATE projects SET quota_limits=$2,quota_revision=quota_revision+1 WHERE id=$1', [projectId, JSON.stringify(limits)]);
      await client.query("INSERT INTO audit_events(id,actor_id,project_id,action,details) VALUES($1,$2,$3,'quota.update',$4)", [randomUUID(), actor.id, projectId, JSON.stringify({ before: current.limits, after: limits })]);
      return quotaSnapshot(client, projectId);
    });
    return reply.header('Cache-Control', 'no-store').header('ETag', `"${snapshot.revision}"`).send(snapshot);
  });
  app.post('/v1/projects/:projectId/retry',async(request,reply)=>{
    const projectId=uuid.parse((request.params as {projectId:string}).projectId);
    const actor=await projectAccess(request,projectId,['admin']);
    const key=z.string().min(8).max(128).regex(/^[a-zA-Z0-9._:-]+$/).parse(request.headers['idempotency-key']);
    const operation=await transaction(pool,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(73942102)');
      const project=(await client.query('SELECT namespace,state FROM projects WHERE id=$1 FOR UPDATE',[projectId])).rows[0];
      const fresh=(await client.query('SELECT u.active,u.platform_admin,m.role FROM users u LEFT JOIN project_members m ON m.user_id=u.id AND m.project_id=$2 WHERE u.id=$1',[actor.id,projectId])).rows[0];
      if(!fresh?.active || (!fresh.platform_admin && fresh.role!=='admin'))throw new HttpError(403,'Permission denied');
      if(!project)throw new HttpError(404,'Project not found');
      const previous=await client.query("SELECT id,state,error_code FROM operations WHERE project_id=$1 AND kind='project.create' AND idempotency_key=$2",[projectId,key]);
      if(previous.rows[0])return previous.rows[0];
      if(project.state!=='failed')throw new HttpError(409,'Only failed project initialization can be retried');
      const id=randomUUID();
      const row=await client.query("INSERT INTO operations(id,project_id,kind,idempotency_key,request_hash,request,created_by) VALUES($1,$2,'project.create',$3,$4,$5,$6) RETURNING id,state,error_code",[id,projectId,key,digest(project.namespace),JSON.stringify({namespace:project.namespace}),actor.id]);
      await client.query("UPDATE projects SET state='pending' WHERE id=$1",[projectId]);
      await client.query("INSERT INTO audit_events(id,actor_id,project_id,operation_id,action) VALUES($1,$2,$3,$4,'project.retry')",[randomUUID(),actor.id,projectId,id]);
      return row.rows[0];
    });
    return reply.code(202).send({operation});
  });
  app.get('/v1/projects/:projectId/members', async request => {
    const projectId = uuid.parse((request.params as { projectId: string }).projectId);
    await projectAccess(request, projectId, ['admin']);
    const result = await pool.query('SELECT u.id,u.email,m.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 ORDER BY u.email', [projectId]);
    return { items: result.rows };
  });
  async function changeMember(request: FastifyRequest, projectId: string, target: {id?: string; email?: string}, role: Role | null) {
    const actor = await projectAccess(request, projectId, ['admin']);
    return transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(73942102)');
      await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
      const fresh = await client.query('SELECT u.platform_admin,u.active,m.role FROM users u LEFT JOIN project_members m ON m.user_id=u.id AND m.project_id=$2 WHERE u.id=$1', [actor.id, projectId]);
      if (!fresh.rows[0]?.active || (!fresh.rows[0].platform_admin && fresh.rows[0].role !== 'admin')) throw new HttpError(403, 'Permission denied');
      const found = target.id
        ? await client.query('SELECT id,active FROM users WHERE id=$1', [target.id])
        : await client.query('SELECT id,active FROM users WHERE email=$1', [target.email]);
      const member = found.rows[0];
      if (!member || (role !== null && !member.active)) throw new HttpError(404, 'Active user not found');
      const admins = await client.query("SELECT m.user_id FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.role='admin' AND u.active", [projectId]);
      if (role !== 'admin' && admins.rows.length === 1 && admins.rows[0].user_id === member.id) throw new HttpError(409, 'Project must retain an administrator');
      if (role === null) await client.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, member.id]);
      else await client.query('INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role', [projectId, member.id, role]);
      await client.query('INSERT INTO audit_events(id,actor_id,project_id,action,details) VALUES($1,$2,$3,$4,$5)', [randomUUID(), actor.id, projectId, role === null ? 'member.remove' : 'member.update', JSON.stringify({userId:member.id,role})]);
      return {ok:true};
    });
  }
  app.post('/v1/projects/:projectId/members', async request => {
    const projectId = uuid.parse((request.params as {projectId:string}).projectId);
    const body = z.object({email:z.string().email().max(254).transform(x=>x.toLowerCase()),role:z.enum(['admin','maintainer','viewer'])}).strict().parse(request.body);
    return changeMember(request, projectId, {email:body.email}, body.role);
  });
  app.put('/v1/projects/:projectId/members/:userId', async request => {
    const params = z.object({projectId:uuid,userId:uuid}).parse(request.params);
    const body = z.object({role:z.enum(['admin','maintainer','viewer'])}).strict().parse(request.body);
    return changeMember(request, params.projectId, {id:params.userId}, body.role);
  });
  app.delete('/v1/projects/:projectId/members/:userId', async request => {
    const params = z.object({projectId:uuid,userId:uuid}).parse(request.params);
    return changeMember(request, params.projectId, {id:params.userId}, null);
  });
  app.get('/v1/projects/:projectId/audit', async request => {
    const projectId = uuid.parse((request.params as { projectId: string }).projectId);
    await projectAccess(request, projectId, ['admin']);
    const result = await pool.query('SELECT id,actor_id,action,details,created_at FROM audit_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100', [projectId]);
    return { items: result.rows };
  });
  await registerInstanceRoutes(app,pool,options,{user,projectAccess});
  return app;
}
