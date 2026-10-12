import { describe, expect, it, vi } from 'vitest';
import { createLandingApi, landingConfig, parseSignup } from '../src/landing.js';
import type { Database } from '../src/db.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

describe('landing signup', () => {
  it('accepts beta access without marketing consent', () => {
    expect(parseSignup({ email: ' TEST@Example.com ', marketingConsent: false })).toEqual({ email: 'test@example.com', marketingConsent: false });
  });
  it('rejects invalid emails and implicit consent', () => {
    for (const input of [{ email: 'bad', marketingConsent: false }, { email: 'test@example.com' }, { email: 'test@example.com', marketingConsent: 'true' }]) expect(() => parseSignup(input)).toThrow();
  });
  it('rejects unsafe links and accepts the approved TestFlight format', () => {
    expect(landingConfig({ GUARDIAN_TESTFLIGHT_URL: 'https://evil.com/join/a', GUARDIAN_AFFILIATE_URL: 'javascript:alert(1)' })).toEqual({ testflightUrl: '', affiliateUrl: '' });
    expect(landingConfig({ GUARDIAN_TESTFLIGHT_URL: 'https://testflight.apple.com/join/ABC123' }).testflightUrl).toContain('ABC123');
  });
  it('stores a signup with explicit consent using query parameters', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const handle = createLandingApi({ pool: { query } } as unknown as Database);
    const request = { method: 'POST', headers: { host: 'guardian.example', origin: 'https://guardian.example' }, socket: { remoteAddress: 'local' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ email: 'tester@example.com', marketingConsent: false })); } } as unknown as IncomingMessage;
    const response = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() } as unknown as ServerResponse;
    await handle(request, response, '/api/landing/signup');
    expect(query.mock.calls[1]?.[1]).toEqual(['tester@example.com', false]);
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });
  it('does not report success when database storage fails', async () => {
    const handle = createLandingApi({ pool: { query: vi.fn().mockRejectedValue(new Error('db')) } } as unknown as Database);
    const request = { method: 'POST', headers: {}, socket: { remoteAddress: 'local' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ email: 'tester@example.com', marketingConsent: true })); } } as unknown as IncomingMessage;
    const response = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() } as unknown as ServerResponse;
    await handle(request, response, '/api/landing/signup');
    expect(response.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
  });
});
