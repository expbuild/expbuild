import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function encryptionKey(value: string): Buffer {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('OPERATION_ENCRYPTION_KEY must be 32 bytes encoded as hex');
  return Buffer.from(value, 'hex');
}

export function seal(key: Buffer, operationId: string, data: object): Buffer {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(operationId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}

export function unseal<T>(key: Buffer, operationId: string, payload: Buffer): T {
  if (payload.length < 28) throw new Error('Invalid encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(operationId)); decipher.setAuthTag(payload.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8')) as T;
}
