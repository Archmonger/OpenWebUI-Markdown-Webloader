/**
 * SSRF protection for outbound URL fetches.
 *
 * Two layers, matching mcp-searxng's `web_url_read`:
 *
 *  1. Static checks on the URL's literal hostname — reject private/loopback/
 *     link-local/other IANA special-purpose ranges (RFC 1918/6598/6890/7526)
 *     and IPv6 ULA/link-local/multicast/IPv4-embedded forms. This catches the
 *     obvious `http://169.254.169.254/` cloud-metadata case immediately.
 *
 *  2. A DNS-rebinding guard: a custom undici lookup wraps `dns.lookup` and
 *     re-checks *every* resolved address against the same block list, so a
 *     hostname that legitimately points at a public address but whose DNS
 *     record flips to a private one at connect time is also rejected.
 *
 * `ALLOW_PRIVATE_URLS=true` disables both layers (for local development
 * against a private SearXNG/test fixture; never do this on a public server).
 */
import * as dns from "node:dns";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { EngineError } from "./error-handler.js";

/** Error name attached to security-policy rejections (mirrors mcp-searxng). */
export const URL_SECURITY_POLICY_DNS_ERROR = "URLSecurityPolicyDnsError";

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

function ipv4ToInt(ip: string): number {
  // Defensively return 0 for non-IPv4 input so a caller that mis-classifies an
  // address can never feed NaN into the CIDR math and produce a false match.
  if (!isIpv4Literal(ip)) {
    return 0;
  }
  return (
    ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0
  );
}

// Blocked IPv4 ranges — RFC 1918 private space plus IANA special-purpose
// ranges (RFC 6890). Single CIDR table so the full blocklist is auditable at
// a glance. Each entry is [networkAddressAsInt, prefixBits].
const BLOCKED_V4_CIDRS: readonly (readonly [number, number])[] = [
  [ipv4ToInt("0.0.0.0"), 8], // "this" network / unspecified
  [ipv4ToInt("10.0.0.0"), 8], // RFC 1918 private
  [ipv4ToInt("100.64.0.0"), 10], // CGNAT (RFC 6598) — Tailscale overlays
  [ipv4ToInt("127.0.0.0"), 8], // loopback
  [ipv4ToInt("169.254.0.0"), 16], // link-local (cloud metadata)
  [ipv4ToInt("172.16.0.0"), 12], // RFC 1918 private
  [ipv4ToInt("192.0.0.0"), 24], // IETF protocol assignments
  [ipv4ToInt("192.0.2.0"), 24], // TEST-NET-1
  [ipv4ToInt("192.88.99.0"), 24], // 6to4 relay anycast (RFC 7526, deprecated)
  [ipv4ToInt("192.168.0.0"), 16], // RFC 1918 private
  [ipv4ToInt("198.18.0.0"), 15], // benchmarking (RFC 2544)
  [ipv4ToInt("198.51.100.0"), 24], // TEST-NET-2
  [ipv4ToInt("203.0.113.0"), 24], // TEST-NET-3
  [ipv4ToInt("224.0.0.0"), 4], // multicast
  [ipv4ToInt("240.0.0.0"), 4], // reserved / broadcast
];

const IPV6_HEX_DIGITS = "0123456789abcdef";

/**
 * Whether `s` is a dotted-quad IPv4 literal. Implemented locally because the
 * Bun type surface does not expose `dns.isIP`.
 */
function isIpv4Literal(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (Number.isNaN(n) || n < 0 || n > 255) return false;
  }
  return true;
}

export function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, "");
  return lower === "localhost" || lower.endsWith(".localhost");
}

export function isPrivateIpv4(hostname: string): boolean {
  if (!isIpv4Literal(hostname)) {
    return false;
  }
  const ip = ipv4ToInt(hostname);
  return BLOCKED_V4_CIDRS.some(
    ([net, bits]) => (ip ^ net) >>> (32 - bits) === 0,
  );
}

function splitIpv6Parts(address: string): {
  hasCompression: boolean;
  leftParts: string[];
  rightParts: string[];
} {
  const compressionAt = address.indexOf("::");
  const hasCompression = compressionAt !== -1;
  if (hasCompression && address.indexOf("::", compressionAt + 1) !== -1) {
    throw new Error("invalid IPv6 compression");
  }
  return {
    hasCompression,
    leftParts: hasCompression
      ? address.slice(0, compressionAt).split(":").filter(Boolean)
      : address.split(":"),
    rightParts: hasCompression
      ? address
          .slice(compressionAt + 2)
          .split(":")
          .filter(Boolean)
      : [],
  };
}

function parseIpv6Part(part: string, isLast: boolean): number[] {
  if (part.includes(".")) {
    if (!isLast || !isIpv4Literal(part)) {
      throw new Error("invalid embedded IPv4");
    }
    return part.split(".").map(Number);
  }
  if (
    part.length < 1 ||
    part.length > 4 ||
    ![...part.toLowerCase()].every((c) => IPV6_HEX_DIGITS.includes(c))
  ) {
    throw new Error("invalid IPv6 hextet");
  }
  const value = Number.parseInt(part, 16);
  return [value >> 8, value & 0xff];
}

function parseIpv6Parts(parts: string[]): number[] {
  return parts.flatMap((part, index) =>
    parseIpv6Part(part, index === parts.length - 1),
  );
}

function expandIpv6Bytes(
  octets: number[],
  hasCompression: boolean,
  leftOctetLength: number,
): Uint8Array {
  if (!hasCompression) {
    if (octets.length !== 16) throw new Error("invalid IPv6 length");
    return Uint8Array.from(octets);
  }
  if (octets.length >= 16) throw new Error("invalid IPv6 compression length");
  const bytes = new Uint8Array(16);
  bytes.set(octets.slice(0, leftOctetLength));
  bytes.set(
    octets.slice(leftOctetLength),
    16 - (octets.length - leftOctetLength),
  );
  return bytes;
}

function parseIpv6Bytes(address: string): Uint8Array {
  const { hasCompression, leftParts, rightParts } = splitIpv6Parts(address);
  const parts = [...leftParts, ...rightParts];
  const octets = parseIpv6Parts(parts);
  const leftOctetLength = parseIpv6Parts(leftParts).length;
  return expandIpv6Bytes(octets, hasCompression, leftOctetLength);
}

function ipv4FromBytes(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

export function isPrivateIPv6(hostname: string): boolean {
  // url.hostname wraps IPv6 in brackets (e.g. "[::1]") — strip them first.
  const addr = (
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname
  ).toLowerCase();
  // IPv6 literals always contain a colon. 6to4 / RFC 6052 / IPv4-mapped forms
  // legitimately contain dots for the embedded IPv4, so we only reject on the
  // *absence* of a colon (which is what distinguishes an IPv4 dotted quad).
  if (!addr.includes(":")) return false;

  let bytes: Uint8Array;
  try {
    bytes = parseIpv6Bytes(addr);
  } catch {
    return true;
  }
  if (bytes.length !== 16) return true;

  if (bytes.every((value) => value === 0)) return true; // unspecified ::
  if (bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1) {
    return true; // loopback ::1
  }
  if ((bytes[0] & 0xfe) === 0xfc) return true; // ULA fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // site-local fec0::/10
  if (bytes[0] === 0xff) return true; // multicast ff00::/8
  if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) return true; // RFC 8215 local-use
  // IPv4-embedded forms. Each prefix array is the full 96-bit (12-byte)
  // prefix so the embedded IPv4 at bytes 12-15 is exactly the tail. The
  // IPv4-mapped case shares the 80-bit zero prefix, then ff:ff; IPv4-mapped
  // and IPv4-translated differ in where the ff:ff marker sits.
  if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) {
    return isPrivateIpv4(ipv4FromBytes(bytes, 12)); // IPv4-compatible ::/96
  }
  if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])) {
    return isPrivateIpv4(ipv4FromBytes(bytes, 12)); // IPv4-mapped ::ffff:0:0/96
  }
  if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0])) {
    return isPrivateIpv4(ipv4FromBytes(bytes, 12)); // IPv4-translated /96
  }
  if (hasPrefix(bytes, [0x20, 0x02])) {
    return isPrivateIpv4(ipv4FromBytes(bytes, 2)); // 6to4 2002::/16
  }
  if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) {
    return isPrivateIpv4(ipv4FromBytes(bytes, 12)); // RFC 6052 64:ff9b::/96
  }
  return false;
}

export function isPrivateAddress(address: string): boolean {
  // Hostnames (no dot, no colon, and not an IPv4 literal) are handled by the
  // caller's hostname check; here we only classify IP literals.
  if (
    !isIpv4Literal(address) &&
    !(address.includes(":") && !address.includes("."))
  ) {
    return false;
  }
  return isPrivateIpv4(address) || isPrivateIPv6(address);
}

/**
 * Reject a URL whose literal hostname is private. Throws a tagged error so
 * callers can map it to a stable 403/400 response. No-op when
 * `allowPrivateUrls` is true.
 */
export function assertUrlAllowed(url: URL, allowPrivateUrls: boolean): void {
  if (allowPrivateUrls) {
    return;
  }
  if (
    isPrivateHostname(url.hostname) ||
    isPrivateIpv4(url.hostname) ||
    isPrivateIPv6(url.hostname)
  ) {
    throw createSecurityPolicyError(url.toString());
  }
}

/** Tagged error so the fetch layer can distinguish policy blocks from DNS failure. */
export function createSecurityPolicyError(url: string): EngineError {
  const error = new EngineError(
    "url_security",
    `Blocked: target resolves to a private or otherwise disallowed address (${url}).`,
    403,
  ) as EngineError & { code?: string };
  error.name = URL_SECURITY_POLICY_DNS_ERROR;
  error.code = URL_SECURITY_POLICY_DNS_ERROR;
  return error;
}

export function isSecurityPolicyError(error: unknown): boolean {
  let current: unknown = error;
  while (current) {
    if (
      (current as { name?: string }).name === URL_SECURITY_POLICY_DNS_ERROR ||
      (current as { code?: string }).code === URL_SECURITY_POLICY_DNS_ERROR
    ) {
      return true;
    }
    current = (current as { cause?: unknown })?.cause;
  }
  return false;
}

/**
 * Build a `dns.lookup` replacement that re-validates every resolved address
 * against the private-range block list before letting the connection proceed.
 * When `allowPrivateUrls` is set, it is a transparent passthrough.
 */
export function createSafeLookup(
  allowPrivateUrls: boolean,
): (
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback,
) => void {
  return (hostname, options, callback) => {
    if (allowPrivateUrls) {
      (dns.lookup as any)(hostname, options, callback);
      return;
    }
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, options.all ? [] : "");
        return;
      }
      if (Array.isArray(addresses) && addresses.length === 0) {
        const notFound = new Error(
          `No DNS records found for ${hostname}`,
        ) as NodeJS.ErrnoException;
        notFound.code = "ENOTFOUND";
        callback(notFound, options.all ? [] : "");
        return;
      }
      if (
        Array.isArray(addresses) &&
        addresses.some(({ address }) => isPrivateAddress(address))
      ) {
        callback(createSecurityPolicyError(hostname), options.all ? [] : "");
        return;
      }
      const selected = Array.isArray(addresses) ? addresses[0] : undefined;
      if (options.all) {
        callback(null, selected ? [selected] : []);
      } else {
        callback(null, selected?.address ?? "", selected?.family);
      }
    });
  };
}

/**
 * Create the undici dispatcher (Agent or ProxyAgent) used for URL reads.
 * The lookup passed here enforces the DNS-rebinding policy even when traffic
 * is routed through an egress proxy.
 */
export function createUrlReaderAgent(
  allowPrivateUrls: boolean,
  proxyUrl: string | undefined,
): Dispatcher {
  // undici's Agent/ProxyAgent option types in the current version do not
  // declare a `lookup` property (it exists at runtime). Cast to `any` to
  // satisfy the type checker while still passing the guard through.
  const opts = { lookup: createSafeLookup(allowPrivateUrls) } as any;
  if (proxyUrl) {
    return new ProxyAgent({ uri: proxyUrl, ...opts });
  }
  return new Agent(opts);
}
