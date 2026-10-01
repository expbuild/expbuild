import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, hashPassword, token, verifyPassword } from './security.js';

test('password hashing salts independently and rejects wrong passwords', async () => {
  const a = await hashPassword('long test password'), b = await hashPassword('long test password');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('long test password', a), true);
  assert.equal(await verifyPassword('different password', a), false);
  assert.equal(await verifyPassword('anything', 'bad-hash'), false);
});
test('session tokens have independent entropy and one-way storage keys', () => {
  const a = token(), b = token();
  assert.notEqual(a, b); assert.equal(digest(a).length, 64); assert.notEqual(digest(a), a);
});
