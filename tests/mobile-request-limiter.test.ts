import { describe, expect, it } from "vitest";
import { MobileRequestLimiter } from "../src/mobile-request-limiter.js";

describe("mobile request limits", () => {
  it("does not let normal refreshes consume sign-in or action limits", () => {
    const limiter = new MobileRequestLimiter();
    for (let i = 0; i < 120; i++) {
      expect(limiter.check("user:1", "/api/mobile/auth/dashboard", "GET", 0).allowed).toBe(true);
    }
    expect(limiter.check("user:1", "/api/mobile/auth/login", "POST", 0).allowed).toBe(true);
    expect(limiter.check("user:1", "/api/mobile/auth/trade/confirm", "POST", 0).allowed).toBe(true);
  });

  it("keeps sign-in throttling shared across challenge and login", () => {
    const limiter = new MobileRequestLimiter();
    for (let i = 0; i < 60; i++) {
      expect(limiter.check("ip:1", i % 2 ? "/api/mobile/auth/login" : "/api/mobile/auth/challenge", "POST", 0).allowed).toBe(true);
    }
    expect(limiter.check("ip:1", "/api/mobile/auth/login", "POST", 1000)).toMatchObject({
      allowed: false, retryAfter: 59, error: "Too many sign-in requests. Try again shortly.",
    });
    expect(limiter.check("ip:2", "/api/mobile/auth/login", "POST", 1000).allowed).toBe(true);
    expect(limiter.check("ip:1", "/api/mobile/auth/login", "POST", 60_000).allowed).toBe(true);
  });

  it("limits excessive reads separately from writes and other users", () => {
    const limiter = new MobileRequestLimiter();
    for (let i = 0; i < 300; i++) limiter.check("user:1", "/api/mobile/auth/dashboard", "GET", 0);
    expect(limiter.check("user:1", "/api/mobile/auth/connection", "GET", 0)).toMatchObject({
      allowed: false, error: "Account refresh limit reached. Try again shortly.",
    });
    expect(limiter.check("user:2", "/api/mobile/auth/dashboard", "GET", 0).allowed).toBe(true);
    for (let i = 0; i < 60; i++) expect(limiter.check("user:1", "/api/mobile/auth/trade/quote", "POST", 0).allowed).toBe(true);
    expect(limiter.check("user:1", "/api/mobile/auth/trade/confirm", "POST", 0)).toMatchObject({
      allowed: false, error: "Too many account actions. Try again shortly.",
    });
  });
});
