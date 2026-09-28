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
