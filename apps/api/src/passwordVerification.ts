import { scrypt, timingSafeEqual } from 'node:crypto';

// Match registration's persisted format and work factor exactly. Do the same
// work for absent/malformed hashes to avoid an account-existence timing oracle.
const format = /^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const fallbackSalt = Buffer.alloc(16);
const fallbackKey = Buffer.alloc(64);

export async function verifyPassword(password: string, stored?: string): Promise<boolean> {
  const match = stored?.match(format);
  const salt = match ? Buffer.from(match[1]!, 'hex') : fallbackSalt;
  const expected = match ? Buffer.from(match[2]!, 'hex') : fallbackKey;
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
  return timingSafeEqual(actual, expected) && !!match;
}
