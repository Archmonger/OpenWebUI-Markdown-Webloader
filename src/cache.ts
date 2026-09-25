/**
 * In-memory LRU+TTL cache for converted documents, mirroring mcp-searxng's
 * `SimpleCache` (default 24h TTL, 500 entries, least-recently-used eviction
 * weighted by hit count). A periodic sweep removes expired entries so memory
 * does not grow unbounded between requests.
 *
 * Entries are stored as a small JSON envelope `{full, title?, images?, links?}`
 * rather than the bare Markdown string so a cache hit can re-attach the same
 * metadata (page title, image/link lists) a fresh fetch would have produced.
 */
import type { ConverterKind, ImageInfo, LinkInfo } from "./types.js";

export interface CacheDocument {
  full: string;
  title?: string;
  images?: ImageInfo[];
  links?: LinkInfo[];
  /** Which converter produced `full` (HTML only); omitted for legacy entries. */
  converter?: ConverterKind;
}

interface CacheEntry {
  value: CacheDocument;
  timestamp: number;
  hitCount: number;
}

function isCacheDocument(value: unknown): value is CacheDocument {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CacheDocument>;
  return typeof candidate.full === "string";
}

export class SimpleCache {
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    ttlMs: number,
    maxEntries: number,
    private readonly cleanupIntervalMs = 60_000,
  ) {
    this.ttlMs = Math.max(1, ttlMs);
    this.maxEntries = Math.max(1, maxEntries);
    if (typeof setImmediate === "function") {
      this.cleanupTimer = setInterval(
        () => this.cleanupExpired(),
        this.cleanupIntervalMs,
      );
      // Do not keep the process alive solely for cache sweeping.
      (this.cleanupTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  get(key: string): CacheDocument | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    entry.hitCount += 1;
    return entry.value;
  }

  set(key: string, value: CacheDocument): void {
    this.cache.set(key, { value, timestamp: Date.now(), hitCount: 0 });
    this.evictIfNeeded();
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    this.cleanupExpired();
    return this.cache.size;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clear();
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  private evictIfNeeded(): void {
    this.cleanupExpired();
    // Evict lowest-hit entries first (ties broken by oldest timestamp).
    while (this.cache.size > this.maxEntries) {
      let evictionKey: string | null = null;
      let evictionEntry: CacheEntry | null = null;
      for (const [key, entry] of this.cache.entries()) {
        if (
          evictionEntry === null ||
          entry.hitCount < evictionEntry.hitCount ||
          (entry.hitCount === evictionEntry.hitCount &&
            entry.timestamp < evictionEntry.timestamp)
        ) {
          evictionKey = key;
          evictionEntry = entry;
        }
      }
      if (evictionKey === null) {
        return;
      }
      this.cache.delete(evictionKey);
    }
  }
}

/**
 * Serialize a document for storage. We intentionally do NOT JSON.stringify at
 * the Map boundary: keeping the in-memory object avoids allocation churn on
 * every set/get for the common case where the same object is reused.
 */
export function serializeCacheDocument(doc: CacheDocument): string {
  return JSON.stringify(doc);
}

export function deserializeCacheDocument(raw: string): CacheDocument | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCacheDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createCache(config: {
  cacheTtlMs: number;
  cacheMaxEntries: number;
}): SimpleCache {
  return new SimpleCache(config.cacheTtlMs, config.cacheMaxEntries);
}
