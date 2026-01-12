/**
 * IndexedDB-based caching service for efficient data storage and retrieval
 * Handles version-based cache invalidation and LRU eviction
 */

import type {
  CacheEntry,
  CacheStats,
  DataError,
  DataErrorType,
} from "@/types/frontend.js";

export interface CacheServiceConfig {
  dbName: string;
  dbVersion: number;
  storeName: string;
  maxSize: number; // Max cache size in bytes
  maxAge: number; // Max age in milliseconds
}

export class CacheService {
  private db: IDBDatabase | null = null;
  private config: CacheServiceConfig;
  private stats: CacheStats;

  constructor(config: Partial<CacheServiceConfig> = {}) {
    this.config = {
      dbName: "zivv-cache",
      dbVersion: 1,
      storeName: "data",
      maxSize: 50 * 1024 * 1024, // 50MB default
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days default
      ...config,
    };

    this.stats = {
      totalSize: 0,
      entryCount: 0,
      hitRate: 0,
      lastCleanup: 0,
    };
  }

  /**
   * Initialize the IndexedDB database
   */
  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.config.dbName, this.config.dbVersion);

      request.onerror = () => {
        reject(this.createError("CACHE_ERROR", "Failed to open IndexedDB", {
          error: request.error,
        }));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // Delete existing store if it exists
        if (db.objectStoreNames.contains(this.config.storeName)) {
          db.deleteObjectStore(this.config.storeName);
        }

        // Create new store
        const store = db.createObjectStore(this.config.storeName, {
          keyPath: "key",
        });

        // Create indexes
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("version", "version", { unique: false });
        store.createIndex("size", "size", { unique: false });
      };
    });
  }

  /**
   * Get data from cache
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.db) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readonly");
      const store = transaction.objectStore(this.config.storeName);
      const request = store.get(key);

      request.onerror = () => {
        reject(this.createError("CACHE_ERROR", "Failed to read from cache", {
          key,
          error: request.error,
        }));
      };

      request.onsuccess = () => {
        const result = request.result as (CacheEntry<T> & { key: string }) | undefined;
        
        if (!result) {
          resolve(null);
          return;
        }

        // Check if entry is expired
        const now = Date.now();
        if (now - result.timestamp > this.config.maxAge) {
          // Entry is expired, delete it and return null
          this.delete(key).catch(console.error);
          resolve(null);
          return;
        }

        // Update access time for LRU
        this.touchEntry(key).catch(console.error);
        
        resolve(result.data);
      };
    });
  }

  /**
   * Store data in cache
   */
  async set<T>(
    key: string,
    data: T,
    version: string,
    checksum?: string
  ): Promise<void> {
    if (!this.db) {
      await this.initialize();
    }

    const serialized = JSON.stringify(data);
    const size = new Blob([serialized]).size;

    // Check if we need to make space
    await this.ensureSpace(size);

    const entry: CacheEntry<T> & { key: string } = {
      key,
      data,
      timestamp: Date.now(),
      size,
      version,
      checksum,
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readwrite");
      const store = transaction.objectStore(this.config.storeName);
      const request = store.put(entry);

      request.onerror = () => {
        reject(this.createError("CACHE_ERROR", "Failed to write to cache", {
          key,
          size,
          error: request.error,
        }));
      };

      request.onsuccess = () => {
        this.stats.totalSize += size;
        this.stats.entryCount++;
        resolve();
      };
    });
  }

  /**
   * Delete entry from cache
   */
  async delete(key: string): Promise<void> {
    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readwrite");
      const store = transaction.objectStore(this.config.storeName);
      
      // First get the entry to update stats
      const getRequest = store.get(key);
      
      getRequest.onsuccess = () => {
        const result = getRequest.result;
        if (result) {
          this.stats.totalSize -= result.size;
          this.stats.entryCount--;
        }

        // Now delete the entry
        const deleteRequest = store.delete(key);
        
        deleteRequest.onerror = () => {
          reject(this.createError("CACHE_ERROR", "Failed to delete from cache", {
            key,
            error: deleteRequest.error,
          }));
        };

        deleteRequest.onsuccess = () => {
          resolve();
        };
      };

      getRequest.onerror = () => {
        reject(this.createError("CACHE_ERROR", "Failed to read before delete", {
          key,
          error: getRequest.error,
        }));
      };
    });
  }

  /**
   * Clear all entries for a specific version
   */
  async clearVersion(version: string): Promise<void> {
    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readwrite");
      const store = transaction.objectStore(this.config.storeName);
      const index = store.index("version");
      const request = index.openCursor(IDBKeyRange.only(version));

      request.onerror = () => {
        reject(this.createError("CACHE_ERROR", "Failed to clear version", {
          version,
          error: request.error,
        }));
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const entry = cursor.value;
          this.stats.totalSize -= entry.size;
          this.stats.entryCount--;
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  }

  /**
   * Clear all cache data
   */
  async clear(): Promise<void> {
    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readwrite");
      const store = transaction.objectStore(this.config.storeName);
      const request = store.clear();

      request.onerror = () => {
        reject(this.createError("CACHE_ERROR", "Failed to clear cache", {
          error: request.error,
        }));
      };

      request.onsuccess = () => {
        this.stats = {
          totalSize: 0,
          entryCount: 0,
          hitRate: 0,
          lastCleanup: Date.now(),
        };
        resolve();
      };
    });
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    // Recalculate stats from database
    await this.recalculateStats();
    return { ...this.stats };
  }

  /**
   * Cleanup expired entries and enforce size limits
   */
  async cleanup(): Promise<void> {
    if (!this.db) {
      return;
    }

    const now = Date.now();
    const maxAge = this.config.maxAge;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readwrite");
      const store = transaction.objectStore(this.config.storeName);
      const index = store.index("timestamp");
      const request = index.openCursor();

      const entriesToDelete: string[] = [];

      request.onerror = () => {
        reject(this.createError("CACHE_ERROR", "Failed during cleanup", {
          error: request.error,
        }));
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const entry = cursor.value;
          
          // Check if entry is expired
          if (now - entry.timestamp > maxAge) {
            entriesToDelete.push(entry.key);
          }
          
          cursor.continue();
        } else {
          // Delete expired entries
          Promise.all(entriesToDelete.map(key => this.delete(key)))
            .then(() => {
              this.stats.lastCleanup = now;
              resolve();
            })
            .catch(reject);
        }
      };
    });
  }

  /**
   * Ensure there's enough space for a new entry
   */
  private async ensureSpace(newEntrySize: number): Promise<void> {
    if (this.stats.totalSize + newEntrySize <= this.config.maxSize) {
      return;
    }

    // Need to free up space - use LRU eviction
    await this.evictLRU(newEntrySize);
  }

  /**
   * Evict least recently used entries to make space
   */
  private async evictLRU(spaceNeeded: number): Promise<void> {
    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readwrite");
      const store = transaction.objectStore(this.config.storeName);
      const index = store.index("timestamp");
      const request = index.openCursor();

      const entries: Array<{ key: string; timestamp: number; size: number }> = [];

      request.onerror = () => {
        reject(this.createError("CACHE_ERROR", "Failed during LRU eviction", {
          error: request.error,
        }));
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const entry = cursor.value;
          entries.push({
            key: entry.key,
            timestamp: entry.timestamp,
            size: entry.size,
          });
          cursor.continue();
        } else {
          // Sort by timestamp (oldest first)
          entries.sort((a, b) => a.timestamp - b.timestamp);
          
          // Delete entries until we have enough space
          let freedSpace = 0;
          const toDelete: string[] = [];
          
          for (const entry of entries) {
            toDelete.push(entry.key);
            freedSpace += entry.size;
            
            if (freedSpace >= spaceNeeded) {
              break;
            }
          }

          // Delete the selected entries
          Promise.all(toDelete.map(key => this.delete(key)))
            .then(() => resolve())
            .catch(reject);
        }
      };
    });
  }

  /**
   * Update the timestamp of an entry (for LRU tracking)
   */
  private async touchEntry(key: string): Promise<void> {
    if (!this.db) {
      return;
    }

    return new Promise((resolve) => {
      const transaction = this.db!.transaction([this.config.storeName], "readwrite");
      const store = transaction.objectStore(this.config.storeName);
      const getRequest = store.get(key);

      getRequest.onsuccess = () => {
        const entry = getRequest.result;
        if (entry) {
          entry.timestamp = Date.now();
          store.put(entry);
        }
        resolve();
      };

      getRequest.onerror = () => {
        // Ignore touch errors
        resolve();
      };
    });
  }

  /**
   * Recalculate cache statistics from database
   */
  private async recalculateStats(): Promise<void> {
    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readonly");
      const store = transaction.objectStore(this.config.storeName);
      const request = store.openCursor();

      let totalSize = 0;
      let entryCount = 0;

      request.onerror = () => {
        reject(this.createError("CACHE_ERROR", "Failed to recalculate stats", {
          error: request.error,
        }));
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const entry = cursor.value;
          totalSize += entry.size;
          entryCount++;
          cursor.continue();
        } else {
          this.stats.totalSize = totalSize;
          this.stats.entryCount = entryCount;
          resolve();
        }
      };
    });
  }

  /**
   * Create a standardized error object
   */
  private createError(
    type: DataErrorType,
    message: string,
    details?: Record<string, unknown>
  ): DataError {
    return {
      type,
      message,
      details,
      timestamp: Date.now(),
      retryable: type !== "QUOTA_EXCEEDED",
    };
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}