import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createPool } from './db.js';
import { hashPassword } from './security.js';

const env = z.object({ DATABASE_URL: z.string().min(1), ADMIN_EMAIL: z.string().email(), ADMIN_PASSWORD: z.string().min(12).max(1024) }).parse(process.env);
const pool = createPool(env.DATABASE_URL);
try {
  await pool.query('INSERT INTO users(id,email,password_hash,platform_admin) VALUES($1,$2,$3,true)', [randomUUID(), env.ADMIN_EMAIL.toLowerCase(), await hashPassword(env.ADMIN_PASSWORD)]);
  console.log('Administrator created. Existing accounts are never overwritten.');
} finally { await pool.end(); }
