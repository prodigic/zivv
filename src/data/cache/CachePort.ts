/**
 * Storage-independent cache boundary.
 *
 * The cache is deliberately limited to data-addressed reads and writes. It
 * has no request, user, or query telemetry API.
 */
export interface CachePort {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, version: string): Promise<void>;
  delete(key: string): Promise<void>;
  clearVersion(version: string): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}
