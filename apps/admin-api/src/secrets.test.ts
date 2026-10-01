import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptionKey, seal, unseal } from './secrets.js';

test('queued credentials are authenticated and bound to their operation', () => {
  const key = encryptionKey(randomBytes(32).toString('hex'));
  const credentials = { password: 'one-time-cache-password' };
  const encrypted = seal(key, 'operation-a', credentials);
  assert.deepEqual(unseal(key, 'operation-a', encrypted), credentials);
  assert.equal(encrypted.includes(Buffer.from(credentials.password)), false);
  assert.notDeepEqual(seal(key, 'operation-a', credentials), encrypted);
  assert.throws(() => unseal(key, 'operation-b', encrypted));
  assert.throws(() => unseal(randomBytes(32), 'operation-a', encrypted));
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => unseal(key, 'operation-a', tampered));
  assert.throws(() => unseal(key, 'operation-a', encrypted.subarray(0, 20)));
  assert.throws(() => encryptionKey('invalid-key'));
});
