import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve,reject) => {
  scrypt(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key));
});
const pattern = /^scrypt-v1:([a-f0-9]{32}):([a-f0-9]{64})$/;
export async function hashReviewPassword(password: string) {
  if (!password || password.length > 256) throw new Error('Password must contain 1–256 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `scrypt-v1:${salt}:${key.toString('hex')}`;
}
export async function verifyReviewPassword(password: string, encoded: string) {
  const match = pattern.exec(encoded);
  if (!match || !password || password.length > 256) return false;
  const actual = await derive(password, match[1]!);
  return timingSafeEqual(actual, Buffer.from(match[2]!, 'hex'));
}
export function reviewCredentials() {
  const email = process.env.GUARDIAN_REVIEW_EMAIL?.trim().toLowerCase();
  const passwordHash = process.env.GUARDIAN_REVIEW_PASSWORD_HASH;
  if (!email || !passwordHash || !pattern.test(passwordHash)) return undefined;
  return { email, passwordHash };
}
