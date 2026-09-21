import { describe, expect, test } from "bun:test";
import {
  isPrivateHostname,
  isPrivateIpv4,
  isPrivateIPv6,
  isPrivateAddress,
  assertUrlAllowed,
  createSecurityPolicyError,
  isSecurityPolicyError,
} from "../src/security.js";
import { SimpleCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";

describe("isPrivateHostname", () => {
  test("detects localhost and *.localhost", () => {
    expect(isPrivateHostname("localhost")).toBe(true);
    expect(isPrivateHostname("foo.localhost")).toBe(true);
    expect(isPrivateHostname("LOCALHOST")).toBe(true);
    expect(isPrivateHostname("example.com")).toBe(false);
    expect(isPrivateHostname("notlocalhost.com")).toBe(false);
  });
});

describe("isPrivateIpv4", () => {
  test("blocks RFC1918 and special ranges", () => {
    expect(isPrivateIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateIpv4("172.16.0.1")).toBe(true);
    expect(isPrivateIpv4("192.168.1.1")).toBe(true);
    expect(isPrivateIpv4("127.0.0.1")).toBe(true);
    expect(isPrivateIpv4("169.254.169.254")).toBe(true);
    expect(isPrivateIpv4("100.64.0.1")).toBe(true);
    expect(isPrivateIpv4("0.0.0.0")).toBe(true);
  });
  test("treats the 172.16/12 boundary correctly", () => {
    // 172.16.0.0 - 172.31.255.255 are private; 172.32.0.0+ are public.
    expect(isPrivateIpv4("172.31.255.255")).toBe(true); // last private in /12
    expect(isPrivateIpv4("172.32.0.0")).toBe(false); // first public after /12
    expect(isPrivateIpv4("172.15.255.255")).toBe(false); // just below the range
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
    expect(isPrivateIpv4("1.1.1.1")).toBe(false);
  });
});

describe("isPrivateIPv6", () => {
  test("blocks loopback, ULA, link-local, multicast, and IPv4-embedded", () => {
    expect(isPrivateIPv6("::1")).toBe(true);
    expect(isPrivateIPv6("[::1]")).toBe(true);
    expect(isPrivateIPv6("fc00::1")).toBe(true);
    expect(isPrivateIPv6("fd12:3456::1")).toBe(true);
    expect(isPrivateIPv6("fe80::1")).toBe(true);
    expect(isPrivateIPv6("ff02::1")).toBe(true);
    expect(isPrivateIPv6("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIPv6("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateIPv6("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIPv6("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateIPv6("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateIPv6("2002:169.254.169.254::1")).toBe(true);
  });
  test("allows public IPv6", () => {
    expect(isPrivateIPv6("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateIPv6("2606:4700:4700::1111")).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  test("combines hostname, IPv4 and IPv6 checks", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });
});

describe("assertUrlAllowed", () => {
  test("throws a tagged security-policy error for private URLs", () => {
    expect(() =>
      assertUrlAllowed(new URL("http://169.254.169.254/"), false),
    ).toThrow();
    expect(() =>
      assertUrlAllowed(new URL("http://192.168.0.1/"), false),
    ).toThrow();
    expect(() =>
      assertUrlAllowed(new URL("http://localhost/"), false),
    ).toThrow();
  });
  test("allows public URLs", () => {
    expect(() =>
      assertUrlAllowed(new URL("https://example.com/"), false),
    ).not.toThrow();
  });
  test("allows everything when allowPrivateUrls is true", () => {
    expect(() =>
      assertUrlAllowed(new URL("http://127.0.0.1/"), true),
    ).not.toThrow();
  });
  test("createSecurityPolicyError is tagged for mapFetchError", () => {
    const err = createSecurityPolicyError("http://10.0.0.1/");
    expect(isSecurityPolicyError(err)).toBe(true);
    expect(isSecurityPolicyError(new Error("boom"))).toBe(false);
  });
});

describe("SimpleCache", () => {
  test("stores and retrieves a document by key", () => {
    const cache = new SimpleCache(60_000, 100);
    cache.set("k", { full: "v", title: "t" });
    expect(cache.get("k")?.full).toBe("v");
    expect(cache.get("k")?.title).toBe("t");
    expect(cache.get("missing")).toBeNull();
    cache.destroy();
  });
  test("evicts expired entries on get", async () => {
    const cache = new SimpleCache(1, 100, 60_000);
    cache.set("k", { full: "v" });
    await Bun.sleep(20);
    expect(cache.get("k")).toBeNull();
    cache.destroy();
  });
  test("evicts lowest-hit entries when over maxEntries", () => {
    const cache = new SimpleCache(60_000, 2, 60_000);
    cache.set("a", { full: "1" });
    cache.set("b", { full: "2" });
    cache.set("c", { full: "3" }); // evicts "a" (lowest hits)
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")?.full).toBe("2");
    expect(cache.get("c")?.full).toBe("3");
    cache.destroy();
  });
  test("size reflects live entries", () => {
    const cache = new SimpleCache(60_000, 100);
    cache.set("a", { full: "1" });
    cache.set("b", { full: "2" });
    expect(cache.size).toBe(2);
    cache.destroy();
  });
});

describe("loadConfig", () => {
  test("applies documented defaults when env is empty", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.port).toBe(14786);
    expect(config.host).toBe("0.0.0.0");
    expect(config.apiKey).toBeUndefined();
    expect(config.maxContentLengthBytes).toBe(5 * 1024 * 1024);
    expect(config.maxPdfPages).toBe(500);
    expect(config.allowPrivateUrls).toBe(false);
    expect(config.maxBatchUrls).toBe(100);
  });
  test("reads overrides from the environment", () => {
    const config = loadConfig({
      API_PORT: "9000",
      API_KEY: "sekrit",
      ALLOW_PRIVATE_URLS: "true",
      URL_READ_MAX_CONTENT_LENGTH_BYTES: "1000",
      LOG_LEVEL: "debug",
    } as NodeJS.ProcessEnv);
    expect(config.port).toBe(9000);
    expect(config.apiKey).toBe("sekrit");
    expect(config.allowPrivateUrls).toBe(true);
    expect(config.maxContentLengthBytes).toBe(1000);
    expect(config.logLevel).toBe("debug");
  });
  test("clamps content-length to a 50 MB ceiling", () => {
    const config = loadConfig({
      URL_READ_MAX_CONTENT_LENGTH_BYTES: "999999999999",
    } as NodeJS.ProcessEnv);
    expect(config.maxContentLengthBytes).toBe(50 * 1024 * 1024);
  });
  test("falls back to default for non-numeric int overrides", () => {
    const config = loadConfig({
      URL_READ_MAX_CONTENT_LENGTH_BYTES: "abc",
    } as NodeJS.ProcessEnv);
    expect(config.maxContentLengthBytes).toBe(5 * 1024 * 1024);
  });
});
