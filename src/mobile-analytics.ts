import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from './db.js';

export function adminAuthorized(header: string | undefined, secret = process.env.GUARDIAN_ADMIN_TOKEN ?? '') {
  if (secret.length < 32 || !header?.startsWith('Bearer ')) return false;
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(header.slice(7)), hash(secret));
}
export function installationInput(input: Record<string, unknown>) {
  if (typeof input.installId !== 'string' || !/^[a-zA-Z0-9_-]{24,100}$/.test(input.installId) || !['ios','android'].includes(String(input.platform))) throw new Error('Invalid installation.');
  return { id: input.installId, platform: String(input.platform), version: typeof input.version === 'string' ? input.version.slice(0,40) : 'unknown' };
}
export class MobileAnalytics {
  private ready?: Promise<unknown>;
  private attempts = new Map<string, { until: number; count: number }>();
  constructor(private db: Database) {}
  migrate() {
    return this.ready ??= this.db.pool.query(`CREATE TABLE IF NOT EXISTS mobile_installations (
      install_id TEXT PRIMARY KEY, platform TEXT NOT NULL CHECK(platform IN ('ios','android')),
      version TEXT NOT NULL, identity_id UUID REFERENCES mobile_identities(id) ON DELETE SET NULL,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    ); CREATE INDEX IF NOT EXISTS mobile_installations_last_seen ON mobile_installations(last_seen);`).catch(error=>{this.ready=undefined;throw error;});
  }
  async track(input: Record<string,unknown>, identity?: string) {
    const value=installationInput(input);await this.migrate();
    await this.db.pool.query(`INSERT INTO mobile_installations (install_id,platform,version,identity_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT(install_id) DO UPDATE SET version=EXCLUDED.version,last_seen=NOW(),identity_id=COALESCE(EXCLUDED.identity_id,mobile_installations.identity_id)
      WHERE mobile_installations.platform=EXCLUDED.platform`,[value.id,value.platform,value.version,identity??null]);
  }
  async stats(platform: string) {
    await this.migrate();
    const selected=['ios','android'].includes(platform)?platform:'all';
    const installations=await this.db.pool.query(`SELECT platform,COUNT(*)::int AS first_launches,
      COUNT(*) FILTER(WHERE last_seen>=NOW()-INTERVAL '7 days')::int AS launched_7d,
      COUNT(DISTINCT identity_id)::int AS signed_in FROM mobile_installations GROUP BY platform`);
    // Legacy accounts are deliberately unclassified until a tracked launch identifies their platform.
    const classified=`WITH platforms AS (SELECT identity_id,CASE WHEN COUNT(DISTINCT platform)=1 THEN MIN(platform) ELSE 'multiple' END AS platform FROM mobile_installations WHERE identity_id IS NOT NULL GROUP BY identity_id)`;
    const summary=await this.db.pool.query(`${classified} SELECT
      (SELECT COUNT(*) FROM mobile_identities i LEFT JOIN platforms p ON p.identity_id=i.id WHERE $1='all' OR p.platform=$1)::int AS users,
      (SELECT COUNT(*) FROM mobile_connections c LEFT JOIN platforms p ON p.identity_id=c.identity_id WHERE $1='all' OR p.platform=$1)::int AS connections,
      COUNT(*) FILTER(WHERE t.result->>'dryRun'='false' AND LOWER(COALESCE(t.result->>'status','')) NOT IN ('rejected','failed','cancelled','canceled','not_submitted'))::int AS submitted_orders,
      COALESCE(SUM((t.payload->>'estimatedNotional')::numeric) FILTER(WHERE t.result->>'dryRun'='false' AND LOWER(COALESCE(t.result->>'status','')) NOT IN ('rejected','failed','cancelled','canceled','not_submitted')),0) AS submitted_notional,
      COALESCE(SUM((t.payload->>'estimatedNotional')::numeric) FILTER(WHERE t.result->>'dryRun'='false' AND LOWER(COALESCE(t.result->>'status','')) NOT IN ('rejected','failed','cancelled','canceled','not_submitted') AND t.submitted_at>=NOW()-INTERVAL '7 days'),0) AS notional_7d,
      COUNT(*) FILTER(WHERE t.result->>'dryRun'='true')::int AS dry_runs,
      COUNT(*) FILTER(WHERE LOWER(t.result->>'status') IN ('rejected','failed','not_submitted'))::int AS failed,
      COUNT(*) FILTER(WHERE t.submitted_at IS NOT NULL AND t.result IS NULL)::int AS unresolved
      FROM mobile_trade_tickets t LEFT JOIN platforms p ON p.identity_id=t.identity_id WHERE $1='all' OR p.platform=$1`,[selected]);
    const days=await this.db.pool.query(`${classified} SELECT t.submitted_at::date AS day,COUNT(*)::int AS orders,
      SUM((t.payload->>'estimatedNotional')::numeric) AS notional FROM mobile_trade_tickets t LEFT JOIN platforms p ON p.identity_id=t.identity_id
      WHERE t.result->>'dryRun'='false' AND LOWER(COALESCE(t.result->>'status','')) NOT IN ('rejected','failed','cancelled','canceled','not_submitted')
      AND t.submitted_at>=NOW()-INTERVAL '30 days' AND ($1='all' OR p.platform=$1) GROUP BY 1 ORDER BY 1`,[selected]);
    const markets=await this.db.pool.query(`${classified} SELECT t.payload->>'symbol' AS symbol,COUNT(*)::int AS orders,SUM((t.payload->>'estimatedNotional')::numeric) AS notional
      FROM mobile_trade_tickets t LEFT JOIN platforms p ON p.identity_id=t.identity_id WHERE t.result->>'dryRun'='false'
      AND LOWER(COALESCE(t.result->>'status','')) NOT IN ('rejected','failed','cancelled','canceled','not_submitted') AND ($1='all' OR p.platform=$1)
      GROUP BY 1 ORDER BY 3 DESC LIMIT 8`,[selected]);
    return { platform:selected,installations:installations.rows,summary:summary.rows[0],days:days.rows,markets:markets.rows,updatedAt:new Date().toISOString() };
  }
  async handle(request: IncomingMessage,response: ServerResponse,url: URL,readBody:(request:IncomingMessage)=>Promise<Record<string,unknown>>) {
    const json=(status:number,value:unknown)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));};
    const now=Date.now();for(const [key,value] of this.attempts)if(value.until<=now)this.attempts.delete(key);
    const key=request.socket.remoteAddress??'unknown';const attempt=this.attempts.get(key)??{until:now+60000,count:0};this.attempts.set(key,attempt);
    if(++attempt.count>120||this.attempts.size>1000)return json(429,{error:'Try again shortly.'});
    if(url.pathname==='/api/admin/mobile/stats'&&request.method==='GET'){
      if(!adminAuthorized(request.headers.authorization))return json(401,{error:'Admin access required.'});
      try{return json(200,await this.stats(url.searchParams.get('platform')??'all'));}catch{return json(503,{error:'Analytics are temporarily unavailable.'});}
    }
    if(url.pathname==='/api/mobile/launch'&&request.method==='POST'){
      try{await this.track(await readBody(request));return json(200,{ok:true});}catch{return json(400,{error:'Could not record launch.'});}
    }
    return json(404,{error:'Not found.'});
  }
}
