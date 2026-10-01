import { createPool, migrate } from './db.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = createPool(process.env.DATABASE_URL);
try { await migrate(pool); } finally { await pool.end(); }
