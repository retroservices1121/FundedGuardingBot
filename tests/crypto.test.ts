import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretBox } from "../src/crypto.js";

describe("SecretBox", () => {
  it("encrypts without exposing plaintext and decrypts correctly", () => {
    const box = new SecretBox(randomBytes(32).toString("base64"));
    const encrypted = box.encrypt("fp_test_secret-value");
    expect(encrypted).not.toContain("fp_test_secret-value");
    expect(box.decrypt(encrypted)).toBe("fp_test_secret-value");
  });

  it("rejects an invalid key length", () => {
    expect(() => new SecretBox(Buffer.from("short").toString("base64"))).toThrow();
  });
});
