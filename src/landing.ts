import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from './db.js';

export function landingConfig(env: NodeJS.ProcessEnv = process.env) {
  const testflight = env.GUARDIAN_TESTFLIGHT_URL?.trim() ?? '';
  const affiliate = env.GUARDIAN_AFFILIATE_URL?.trim() ?? '';
  let affiliateUrl = '';
  try { const url = new URL(affiliate); if (url.protocol === 'https:' && !url.username && !url.password) affiliateUrl = url.href; } catch {}
  return {
    testflightUrl: /^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/.test(testflight) ? testflight : '',
    affiliateUrl,
  };
}

export function parseSignup(input: Record<string, unknown>) {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof input.marketingConsent !== 'boolean') throw new Error('Enter a valid email address.');
  return { email, marketingConsent: input.marketingConsent };
}

export function createLandingApi(db: Database) {
  let ready: Promise<unknown> | undefined;
  const attempts = new Map<string, { count: number; until: number }>();
  function reply(response: ServerResponse, status: number, data: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(data));
  }
  return async (request: IncomingMessage, response: ServerResponse, pathname: string) => {
    if (pathname === '/api/landing/config' && request.method === 'GET') return reply(response, 200, landingConfig());
    if (pathname !== '/api/landing/signup' || request.method !== 'POST') return reply(response, 404, { error: 'Not found.' });
    if (request.headers.origin) {
      try { if (new URL(request.headers.origin).host !== request.headers.host) return reply(response, 403, { error: 'Submit this form from the Guardian website.' }); }
      catch { return reply(response, 403, { error: 'Invalid request origin.' }); }
    }
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    // Do not trust client-supplied forwarded headers. The service-wide cap also bounds memory.
    const address = request.socket.remoteAddress ?? 'unknown';
    const attempt = attempts.get(address) ?? { count: 0, until: now + 60_000 };
    attempts.set(address, attempt);
    if (++attempt.count > 30 || attempts.size > 1000) { response.setHeader('Retry-After', '60'); return reply(response, 429, { error: 'Please try again in a minute.' }); }
    let signup;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { const b = Buffer.from(chunk); size += b.length; if (size > 2048) throw new Error('Request too large.'); chunks.push(b); }
      signup = parseSignup(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch { return reply(response, 400, { error: 'Enter a valid email address.' }); }
    try {
      ready ??= db.pool.query(`CREATE TABLE IF NOT EXISTS landing_beta_signups (
        email TEXT PRIMARY KEY,
        marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
        consent_version TEXT NOT NULL DEFAULT '2026-10-12',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`).catch(error => { ready = undefined; throw error; });
      await ready;
      await db.pool.query(`INSERT INTO landing_beta_signups (email, marketing_consent) VALUES ($1, $2)
        ON CONFLICT (email) DO UPDATE SET marketing_consent = EXCLUDED.marketing_consent, consent_version = '2026-10-12', updated_at = NOW()`, [signup.email, signup.marketingConsent]);
      return reply(response, 200, { ok: true, testflightUrl: landingConfig().testflightUrl });
    } catch { return reply(response, 503, { error: 'We could not save your email. Please try again shortly.' }); }
  };
}
