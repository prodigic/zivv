/**
 * Test suite for loading state helpers in src/utils/loadingState.ts
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createAsyncState,
  createLoadingState,
  createSuccessState,
  createErrorState,
  isLoading,
  hasError,
  hasData,
  isSuccess,
  isIdle,
  requireData,
  getDataOrDefault,
  isStale,
  LoadingStateManager,
  withLoadingState,
  DebouncedLoadingState,
  RetryManager,
  BatchProcessor,
} from "@/utils/loadingState";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("async state factories", () => {
  it("createAsyncState produces an idle state", () => {
    expect(createAsyncState<string>("data")).toEqual({
      data: "data",
      loading: false,
      error: null,
      lastUpdated: null,
    });
    expect(createAsyncState()).toEqual({
      data: null,
      loading: false,
      error: null,
      lastUpdated: null,
    });
  });

  it("createLoadingState marks loading and keeps previous data", () => {
    expect(createLoadingState<string>("old")).toEqual({
      data: "old",
      loading: true,
      error: null,
      lastUpdated: null,
    });
  });

  it("createSuccessState stores data and a fresh lastUpdated", () => {
    const result = createSuccessState("done");

    expect(result).toEqual({
      data: "done",
      loading: false,
      error: null,
      lastUpdated: result.lastUpdated,
    });
    expect(result.lastUpdated).not.toBeNull();
  });

  it("createErrorState stores the error and previous data", () => {
    expect(createErrorState<string>("boom", "old")).toEqual({
      data: "old",
      loading: false,
      error: "boom",
      lastUpdated: null,
    });
  });
});

describe("async state predicates", () => {
  it("isLoading / hasError / hasData reflect their fields", () => {
    expect(isLoading(createLoadingState())).toBe(true);
    expect(hasError(createErrorState("oops"))).toBe(true);
    expect(hasData(createSuccessState("x"))).toBe(true);
    expect(hasData(createAsyncState())).toBe(false);
  });

  it("isSuccess requires data without error or loading", () => {
    expect(isSuccess(createSuccessState("x"))).toBe(true);
    expect(isSuccess(createErrorState("oops", "old"))).toBe(false);
    expect(isSuccess(createLoadingState("old"))).toBe(false);
  });

  it("isIdle matches untouched state only", () => {
    expect(isIdle(createAsyncState())).toBe(true);
    expect(isIdle(createLoadingState())).toBe(false);
    expect(isIdle(createSuccessState("x"))).toBe(false);
  });

  it("requireData returns data or throws", () => {
    expect(requireData(createSuccessState("payload"))).toBe("payload");
    expect(() => requireData(createAsyncState<string>())).toThrow(
      "Data is not available in async state"
    );
    expect(() => requireData(createErrorState<string>("oops"))).toThrow();
  });

  it("getDataOrDefault falls back when data is null", () => {
    expect(getDataOrDefault(createAsyncState<string>(), "fallback")).toBe(
      "fallback"
    );
    expect(getDataOrDefault(createSuccessState("real"), "fallback")).toBe(
      "real"
    );
  });

  it("isStale treats un-timestamped states as stale and ages old updates", () => {
    expect(isStale(createAsyncState<string>(), 1000)).toBe(true);

    const fresh = createSuccessState("x");
    expect(isStale(fresh, 1000)).toBe(false);

    const old = { ...fresh, lastUpdated: Date.now() - 5000 };
    expect(isStale(old, 1000)).toBe(true);
  });
});

describe("LoadingStateManager", () => {
  it("transitions per-key states", () => {
    const manager = new LoadingStateManager();

    expect(manager.getState("events")).toBe("idle");

    manager.setLoading("events");
    expect(manager.getState("events")).toBe("loading");
    expect(manager.isAnyLoading()).toBe(true);

    manager.setSuccess("events");
    expect(manager.getState("events")).toBe("success");

    manager.setError("events");
    expect(manager.hasAnyErrors(["events"])).toBe(true);

    manager.setIdle("events");
    expect(manager.getState("events")).toBe("idle");
  });

  it("tracks aggregate flags", () => {
    const manager = new LoadingStateManager();
    manager.setSuccess("a");
    manager.setLoading("b");
    manager.setError("c");

    expect(manager.isAnyLoading()).toBe(true);
    expect(manager.areAllSuccessful(["a"])).toBe(true);
    expect(manager.areAllSuccessful(["a", "b"])).toBe(false);
    expect(manager.hasAnyErrors(["a", "b"])).toBe(false);
    expect(manager.hasAnyErrors(["a", "c"])).toBe(true);
  });

  it("notifies subscribers on transitions and supports unsubscribe", () => {
    const manager = new LoadingStateManager();
    const seen: string[] = [];

    const unsubscribe = manager.subscribe("events", (state) =>
      seen.push(state)
    );

    // Subscribing reports the current state immediately
    expect(seen).toEqual(["idle"]);

    manager.setLoading("events");
    manager.setSuccess("events");
    expect(seen).toEqual(["idle", "loading", "success"]);

    unsubscribe();
    manager.setError("events");
    expect(seen).toEqual(["idle", "loading", "success"]);
  });

  it("clears all states and subscribers", () => {
    const manager = new LoadingStateManager();
    manager.setLoading("a");

    const calls: string[] = [];
    const unsubscribe = manager.subscribe("a", (state) => calls.push(state));

    // Subscription reports the state as of now
    expect(calls).toEqual(["loading"]);

    manager.clear();

    expect(manager.getState("a")).toBe("idle");
    expect(manager.getAllStates()).toEqual({});

    // The subscription is dropped with the manager's cleanup, so further
    // state changes do not reach the callback
    manager.setSuccess("a");
    expect(calls).toEqual(["loading"]);

    unsubscribe();
  });

  it("getAllStates exposes the full snapshot", () => {
    const manager = new LoadingStateManager();
    manager.setLoading("a");
    manager.setSuccess("b");

    expect(manager.getAllStates()).toEqual({ a: "loading", b: "success" });
  });
});

describe("withLoadingState", () => {
  it("marks the operation loading then successful", async () => {
    const manager = new LoadingStateManager();
    const result = await withLoadingState(
      async () => "payload",
      manager,
      "search"
    );

    expect(result).toBe("payload");
    expect(manager.getState("search")).toBe("success");
  });

  it("marks the operation errored and rethrows", async () => {
    const manager = new LoadingStateManager();

    const operation = async (): Promise<string> => {
      throw new Error("network down");
    };

    await expect(
      withLoadingState(operation, manager, "search")
    ).rejects.toThrow("network down");
    expect(manager.getState("search")).toBe("error");
  });
});

describe("DebouncedLoadingState", () => {
  it("debounces rapid changes and skips the pending delayed state", () => {
    vi.useFakeTimers();

    const states: string[] = [];
    const debounced = new DebouncedLoadingState((state) => states.push(state));

    debounced.setLoading(100); // scheduled in 100ms
    expect(debounced.getCurrentState()).toBe("idle");

    debounced.setSuccess(); // flushes immediately, cancels the pending change
    expect(debounced.getCurrentState()).toBe("success");
    expect(states).toEqual(["success"]);

    vi.advanceTimersByTime(200);
    expect(states).toEqual(["success"]);
    expect(debounced.getCurrentState()).toBe("success");
  });

  it("applies the delayed state after the delay elapses", () => {
    vi.useFakeTimers();

    const states: string[] = [];
    const debounced = new DebouncedLoadingState((state) => states.push(state));

    debounced.setLoading(100);
    vi.advanceTimersByTime(100);

    expect(debounced.getCurrentState()).toBe("loading");
    expect(states).toEqual(["loading"]);
  });

  it("applies immediate terminal states synchronously", () => {
    const states: string[] = [];
    const debounced = new DebouncedLoadingState((state) => states.push(state));

    debounced.setIdle();
    debounced.setError();

    expect(states).toEqual(["idle", "error"]);
    expect(debounced.getCurrentState()).toBe("error");
  });

  it("dispose cancels a pending state change", () => {
    vi.useFakeTimers();

    const states: string[] = [];
    const debounced = new DebouncedLoadingState((state) => states.push(state));

    debounced.setLoading(100);
    debounced.dispose();
    vi.advanceTimersByTime(200);

    expect(states).toEqual([]);
    expect(debounced.getCurrentState()).toBe("idle");
  });
});

describe("RetryManager", () => {
  it("returns immediately when the operation succeeds", async () => {
    const retry = new RetryManager(3, 10, 100);
    const operation = vi.fn().mockResolvedValue("payload");

    await expect(retry.execute(operation)).resolves.toBe("payload");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when shouldRetry returns false", async () => {
    const retry = new RetryManager(3, 10, 100);
    const operation = vi.fn().mockRejectedValue(new Error("fatal"));

    await expect(retry.execute(operation, () => false)).rejects.toThrow(
      "fatal"
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries until success", async () => {
    vi.useFakeTimers();

    const retry = new RetryManager(3, 10, 100);
    let attempts = 0;
    const operation = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient");
      return "recovered";
    });

    const execution = retry.execute(operation);

    // Two backoff waits (10ms and 20ms) happen inside the retry loop
    await vi.advanceTimersByTimeAsync(50);

    await expect(execution).resolves.toBe("recovered");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting maxAttempts", async () => {
    vi.useFakeTimers();

    const retry = new RetryManager(2, 10, 100);
    const operation = vi.fn(async () => {
      throw new Error("always failing");
    });

    const execution = retry.execute(operation);
    const expectation = expect(execution).rejects.toThrow("always failing");

    await vi.advanceTimersByTimeAsync(50);

    await expectation;
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

describe("BatchProcessor", () => {
  it("splits items into batches and preserves result order", async () => {
    const processor = vi
      .fn()
      .mockImplementation(async (batch: number[]) => batch.map((n) => n * 2));

    const processor2 = new BatchProcessor<number, number>(
      processor,
      2,
      0 // no inter-batch delay keeps the test fast and synchronous
    );

    const results = await processor2.processAll([1, 2, 3, 4, 5]);

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(processor.mock.calls.map((call) => call[0])).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });

  it("reports progress across batches", async () => {
    const progress: Array<[number, number]> = [];

    const processor = new BatchProcessor<number, number>(
      async (batch) => batch,
      2,
      0
    );

    await processor.processAll([1, 2, 3], (completed, total) =>
      progress.push([completed, total])
    );

    expect(progress).toContainEqual([2, 3]);
    expect(progress).toContainEqual([3, 3]);
  });

  it("waits between batches when a delay is configured", async () => {
    vi.useFakeTimers();

    const processor = new BatchProcessor<number, number>(
      async (batch) => batch,
      2,
      50
    );

    const execution = processor.processAll([1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(200);

    await expect(execution).resolves.toEqual([1, 2, 3, 4]);
  });
});
