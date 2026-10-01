import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';

const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
});

export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt, key] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !key || !/^[a-f0-9]{128}$/.test(key)) return false;
  return timingSafeEqual(await derive(password, salt), Buffer.from(key, 'hex'));
}
