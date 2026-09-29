export function normalizeBridgeToken(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Token must be text.');
  }

  const token = value.trim();
  if (!/^[a-f0-9]{32,4096}$/i.test(token)) {
    throw new Error('Token must contain at least 32 hexadecimal characters.');
  }
  return token;
}

export async function tokensMatchByFingerprint(left, right) {
  const leftToken = normalizeBridgeToken(left);
  const rightToken = normalizeBridgeToken(right);
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(leftToken)),
    crypto.subtle.digest('SHA-256', encoder.encode(rightToken)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let i = 0; i < Math.max(leftBytes.length, rightBytes.length); i += 1) {
    difference |= (leftBytes[i] || 0) ^ (rightBytes[i] || 0);
  }
  return difference === 0;
}
