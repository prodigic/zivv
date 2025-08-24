/**
 * Loading state management utilities for consistent async operation handling
 */

import type { AsyncState, LoadingState } from "@/types/frontend.js";

/**
 * Create initial async state
 */
export function createAsyncState<T>(initialData: T | null = null): AsyncState<T> {
  return {
    data: initialData,
    loading: false,
    error: null,
    lastUpdated: null,
  };
}

/**
 * Create loading state
 */
export function createLoadingState<T>(
  previousData: T | null = null
): AsyncState<T> {
  return {
    data: previousData,
    loading: true,
    error: null,
    lastUpdated: null,
  };
}

/**
 * Create success state
 */
export function createSuccessState<T>(data: T): AsyncState<T> {
  return {
    data,
    loading: false,
    error: null,
    lastUpdated: Date.now(),
  };
}

/**
 * Create error state
 */
export function createErrorState<T>(
  error: string,
  previousData: T | null = null
): AsyncState<T> {
  return {
    data: previousData,
    loading: false,
    error,
    lastUpdated: null,
  };
}

/**
 * Check if async state is loading
 */
export function isLoading<T>(state: AsyncState<T>): boolean {
  return state.loading;
}

/**
 * Check if async state has error
 */
export function hasError<T>(state: AsyncState<T>): boolean {
  return state.error !== null;
}

/**
 * Check if async state has data
 */
export function hasData<T>(state: AsyncState<T>): boolean {
  return state.data !== null;
}

/**
 * Check if async state is successful (has data and no error)
 */
export function isSuccess<T>(state: AsyncState<T>): boolean {
  return hasData(state) && !hasError(state) && !isLoading(state);
}

/**
 * Check if async state is idle (no data, no loading, no error)
 */
export function isIdle<T>(state: AsyncState<T>): boolean {
  return !hasData(state) && !isLoading(state) && !hasError(state);
}

/**
 * Get data from async state, throwing if not available
 */
export function requireData<T>(state: AsyncState<T>): T {
  if (state.data === null) {
    throw new Error("Data is not available in async state");
  }
  return state.data;
}

/**
 * Get data from async state with fallback
 */
export function getDataOrDefault<T>(
  state: AsyncState<T>,
  defaultValue: T
): T {
  return state.data ?? defaultValue;
}

/**
 * Check if data is stale (older than specified age)
 */
export function isStale<T>(
  state: AsyncState<T>,
  maxAgeMs: number
): boolean {
  if (state.lastUpdated === null) {
    return true;
  }
  
  return Date.now() - state.lastUpdated > maxAgeMs;
}

/**
 * Utility class for managing multiple loading states
 */
export class LoadingStateManager {
  private states = new Map<string, LoadingState>();
  private subscribers = new Map<string, Set<(state: LoadingState) => void>>();

  /**
   * Set loading state for a key
   */
  setLoading(key: string): void {
    this.updateState(key, "loading");
  }

  /**
   * Set success state for a key
   */
  setSuccess(key: string): void {
    this.updateState(key, "success");
  }

  /**
   * Set error state for a key
   */
  setError(key: string): void {
    this.updateState(key, "error");
  }

  /**
   * Set idle state for a key
   */
  setIdle(key: string): void {
    this.updateState(key, "idle");
  }

  /**
   * Get current state for a key
   */
  getState(key: string): LoadingState {
    return this.states.get(key) || "idle";
  }

  /**
   * Check if any keys are loading
   */
  isAnyLoading(): boolean {
    return Array.from(this.states.values()).includes("loading");
  }

  /**
   * Check if all specified keys are successful
   */
  areAllSuccessful(keys: string[]): boolean {
    return keys.every(key => this.getState(key) === "success");
  }

  /**
   * Check if any specified keys have errors
   */
  hasAnyErrors(keys: string[]): boolean {
    return keys.some(key => this.getState(key) === "error");
  }

  /**
   * Subscribe to state changes for a key
   */
  subscribe(key: string, callback: (state: LoadingState) => void): () => void {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    
    this.subscribers.get(key)!.add(callback);
    
    // Call immediately with current state
    callback(this.getState(key));
    
    // Return unsubscribe function
    return () => {
      const keySubscribers = this.subscribers.get(key);
      if (keySubscribers) {
        keySubscribers.delete(callback);
        if (keySubscribers.size === 0) {
          this.subscribers.delete(key);
        }
      }
    };
  }

  /**
   * Clear all states
   */
  clear(): void {
    this.states.clear();
    this.subscribers.clear();
  }

  /**
   * Get all current states
   */
  getAllStates(): Record<string, LoadingState> {
    return Object.fromEntries(this.states.entries());
  }

  private updateState(key: string, state: LoadingState): void {
    this.states.set(key, state);
    
    // Notify subscribers
    const keySubscribers = this.subscribers.get(key);
    if (keySubscribers) {
      keySubscribers.forEach(callback => callback(state));
    }
  }
}

/**
 * Utility function for async operation with state management
 */
export async function withLoadingState<T>(
  operation: () => Promise<T>,
  stateManager: LoadingStateManager,
  key: string
): Promise<T> {
  try {
    stateManager.setLoading(key);
    const result = await operation();
    stateManager.setSuccess(key);
    return result;
  } catch (error) {
    stateManager.setError(key);
    throw error;
  }
}

/**
 * Debounced loading state setter to prevent rapid state changes
 */
export class DebouncedLoadingState {
  private timeout: NodeJS.Timeout | null = null;
  private currentState: LoadingState = "idle";
  private onStateChange: (state: LoadingState) => void;

  constructor(onStateChange: (state: LoadingState) => void) {
    this.onStateChange = onStateChange;
  }

  setLoading(delay = 100): void {
    this.scheduleStateChange("loading", delay);
  }

  setSuccess(): void {
    this.scheduleStateChange("success", 0);
  }

  setError(): void {
    this.scheduleStateChange("error", 0);
  }

  setIdle(): void {
    this.scheduleStateChange("idle", 0);
  }

  getCurrentState(): LoadingState {
    return this.currentState;
  }

  private scheduleStateChange(state: LoadingState, delay: number): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }

    if (delay > 0) {
      this.timeout = setTimeout(() => {
        this.currentState = state;
        this.onStateChange(state);
        this.timeout = null;
      }, delay);
    } else {
      this.currentState = state;
      this.onStateChange(state);
    }
  }

  dispose(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
}

/**
 * Utility for managing retry logic with exponential backoff
 */
export class RetryManager {
  private maxAttempts: number;
  private baseDelay: number;
  private maxDelay: number;

  constructor(
    maxAttempts = 3,
    baseDelay = 1000,
    maxDelay = 30000
  ) {
    this.maxAttempts = maxAttempts;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
  }

  async execute<T>(
    operation: () => Promise<T>,
    shouldRetry: (error: Error, attempt: number) => boolean = () => true
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt === this.maxAttempts || !shouldRetry(lastError, attempt)) {
          throw lastError;
        }

        // Wait before retry with exponential backoff
        const delay = Math.min(
          this.baseDelay * Math.pow(2, attempt - 1),
          this.maxDelay
        );

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }
}

/**
 * Utility for batching multiple async operations
 */
export class BatchProcessor<T, R> {
  private batchSize: number;
  private processor: (batch: T[]) => Promise<R[]>;
  private delay: number;

  constructor(
    processor: (batch: T[]) => Promise<R[]>,
    batchSize = 10,
    delay = 100
  ) {
    this.processor = processor;
    this.batchSize = batchSize;
    this.delay = delay;
  }

  async processAll(
    items: T[],
    onProgress?: (completed: number, total: number) => void
  ): Promise<R[]> {
    const results: R[] = [];
    
    for (let i = 0; i < items.length; i += this.batchSize) {
      const batch = items.slice(i, i + this.batchSize);
      const batchResults = await this.processor(batch);
      results.push(...batchResults);

      if (onProgress) {
        onProgress(Math.min(i + this.batchSize, items.length), items.length);
      }

      // Add delay between batches to prevent overwhelming
      if (i + this.batchSize < items.length && this.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, this.delay));
      }
    }

    return results;
  }
}