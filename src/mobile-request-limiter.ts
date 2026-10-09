type Bucket = "sign-in" | "read" | "write";
const limits: Record<Bucket, number> = { "sign-in": 60, read: 300, write: 60 };

export class MobileRequestLimiter {
  private requests = new Map<string, { count: number; until: number }>();

  check(identity: string, pathname: string, method: string, now = Date.now()) {
    const bucket: Bucket =
      pathname === "/api/mobile/auth/challenge" || pathname === "/api/mobile/auth/login" || pathname === "/api/mobile/auth/email-login"
        ? "sign-in"
        : method === "GET" || method === "HEAD" ? "read" : "write";
    for (const [key, value] of this.requests) {
      if (value.until <= now) this.requests.delete(key);
    }
    const key = JSON.stringify([identity, bucket]);
    const limit = this.requests.get(key) ?? { count: 0, until: now + 60_000 };
    limit.count++;
    this.requests.set(key, limit);
    return {
      allowed: limit.count <= limits[bucket],
      retryAfter: Math.max(1, Math.ceil((limit.until - now) / 1000)),
      error: bucket === "sign-in"
        ? "Too many sign-in requests. Try again shortly."
        : bucket === "read"
          ? "Account refresh limit reached. Try again shortly."
          : "Too many account actions. Try again shortly.",
    };
  }
}
