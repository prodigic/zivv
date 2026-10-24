/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SideNavigation } from "@/components/layout/SideNavigation";
import { BottomNavigation } from "@/components/layout/BottomNavigation";
import { FilterModalProvider } from "@/components/filters/FilterModalContext";
afterEach(cleanup);
it.each(["/newsletter", "/newsletter/bay-area"])(
  "does not select Just Added or Latest on %s",
  (path) => {
    const { container } = render(
      <MemoryRouter initialEntries={[path]}>
        <FilterModalProvider>
          <SideNavigation isOpen onClose={() => {}} />
          <BottomNavigation />
        </FilterModalProvider>
      </MemoryRouter>
    );
    const selected = [...container.querySelectorAll("aside nav a")].filter(
      (link) => link.className.includes("border-r-2")
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAttribute("href", "/newsletter");
    expect(screen.getByRole("link", { name: "Latest" })).not.toHaveClass(
      "text-blue-600"
    );
  }
);
it("still selects the Just Added page and mobile Latest tab", () => {
  render(
    <MemoryRouter initialEntries={["/new"]}>
      <FilterModalProvider>
        <SideNavigation isOpen onClose={() => {}} />
        <BottomNavigation />
      </FilterModalProvider>
    </MemoryRouter>
  );
  expect(screen.getByRole("link", { name: "Just Added" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expect(screen.getByRole("link", { name: "Latest" })).toHaveClass(
    "text-blue-600"
  );
  expect(screen.getByRole("link", { name: "Newsletter" })).not.toHaveClass(
    "border-r-2"
  );
});
