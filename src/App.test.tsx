import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders without crashing", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: /vite \+ react/i })
    ).toBeInTheDocument();
  });

  it("has a counter button", () => {
    render(<App />);
    expect(
      screen.getByRole("button", { name: /count is/i })
    ).toBeInTheDocument();
  });
});
