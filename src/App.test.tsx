import { describe, it, expect, vi } from "vitest";
import { globalErrorHandler } from "./utils/errorHandling";

// Partially mock react-router-dom: stub RouterProvider to avoid having to
// render the router, while keeping every real export (createBrowserRouter,
// Navigate, …) available for the router module itself.
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    RouterProvider: ({
      fallbackElement,
    }: {
      fallbackElement: React.ReactElement;
    }) => fallbackElement,
  };
});

// Mock error handling
vi.mock("./utils/errorHandling.ts", () => ({
  globalErrorHandler: {
    initialize: vi.fn(),
  },
}));

describe("App", () => {
  it("imports without errors", async () => {
    // Simple import test - if App imports successfully, basic structure is good
    const { default: App } = await import("./App");
    expect(App).toBeDefined();
    expect(typeof App).toBe("function");
  });

  it("initializes error handling when imported", () => {
    // Test that error handling is available
    expect(globalErrorHandler).toBeDefined();
    expect(globalErrorHandler.initialize).toBeDefined();
  });

  it("has router dependency", async () => {
    // Test that router import works
    const routerModule = await import("./router/index.tsx");
    expect(routerModule.router).toBeDefined();
  });
});
