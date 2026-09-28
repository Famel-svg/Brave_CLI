import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBridgeToken, tokensMatchByFingerprint } from '../extension/token.mjs';

test('normalizes whitespace around a bridge token', () => {
  const token = '0123456789abcdef0123456789abcdef';
  assert.equal(normalizeBridgeToken(`\r\n${token} \t`), token);
});

test('rejects missing, short, non-hex, and oversized values', () => {
  for (const value of ['', '0123', 'g'.repeat(32), 'a'.repeat(4097)]) {
    assert.throws(() => normalizeBridgeToken(value));
  }
});

test('compares normalized tokens by SHA-256 without exposing fingerprint', async () => {
  const token = '0123456789abcdef0123456789abcdef';
  assert.equal(await tokensMatchByFingerprint(` ${token}\n`, token), true);
  assert.equal(await tokensMatchByFingerprint(token, 'fedcba9876543210fedcba9876543210'), false);
  await assert.rejects(tokensMatchByFingerprint(token, 'not-a-valid-token'));
});
