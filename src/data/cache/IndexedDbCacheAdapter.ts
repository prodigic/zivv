import { CacheService } from "@/services/CacheService.js";
import type { CacheServiceConfig } from "@/services/CacheService.js";
import type { CachePort } from "./CachePort.ts";

/** Keeps the legacy IndexedDB implementation behind the data-layer port. */
export class IndexedDbCacheAdapter implements CachePort {
  private readonly service: CacheService;

  constructor(config: Partial<CacheServiceConfig> = {}) {
    this.service = new CacheService(config);
  }

  get<T>(key: string): Promise<T | null> {
    return this.service.get<T>(key);
  }

  set<T>(key: string, value: T, version: string): Promise<void> {
    return this.service.set(key, value, version);
  }

  delete(key: string): Promise<void> {
    return this.service.delete(key);
  }

  clearVersion(version: string): Promise<void> {
    return this.service.clearVersion(version);
  }

  clear(): Promise<void> {
    return this.service.clear();
  }

  close(): void {
    this.service.close();
  }
}
