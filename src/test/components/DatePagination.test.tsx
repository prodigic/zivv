/**
 * Test suite for the DatePagination date-range slider.
 *
 * The control models a "today + N days" range with labelled checkpoints
 * (Today, Tomorrow, 1 wk, 1 mon, 3 mon, All), dual draggable handles and a
 * track that snaps clicks to the nearest checkpoint. Selecting the full
 * range clears the dateRange filter instead of storing it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DatePagination } from "@/components/ui/DatePagination";

// Mock the filter store
const mockUpdateFilter = vi.fn();
const mockClearFilter = vi.fn();

const mockStoreState = {
  filters: {
    dateRange: undefined as
      | { startDate?: string; endDate?: string }
      | undefined,
  },
  updateFilter: mockUpdateFilter,
  clearFilter: mockClearFilter,
};

vi.mock("@/stores/filterStore", () => ({
  useFilterStore: () => mockStoreState,
}));

// jsdom has no layout, so give the track a deterministic geometry:
// width 100 starting at x=0 (one checkpoint every 100/5 = 20% of the track).
function mockTrackGeometry(width = 100): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    width,
  } as DOMRect);
}

describe("DatePagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.filters.dateRange = undefined;
    // Freeze "today" at 2024-01-15 for deterministic ISO dates
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("rendering", () => {
    it("should render all checkpoint labels", () => {
      render(<DatePagination />);

      for (const label of [
        "Today",
        "Tomorrow",
        "1 wk",
        "1 mon",
        "3 mon",
        "All",
      ]) {
        // "Today" and "All" appear both in the header and as checkpoint labels
        expect(screen.getAllByText(label).length).toBeGreaterThan(0);
      }
    });

    it("should render the full range by default", () => {
      render(<DatePagination />);

      // Default header shows "Today → All" (each label appears twice:
      // once in the header and once as a checkpoint label)
      expect(screen.getAllByText("Today").length).toBe(2);
      expect(screen.getAllByText("All").length).toBe(2);
      // No clear affordance when no range is stored
      expect(
        screen.queryByLabelText("Clear date range")
      ).not.toBeInTheDocument();
    });

    it("should render with custom className", () => {
      const { container } = render(<DatePagination className="custom-class" />);

      const component = container.firstChild as Element;
      expect(component.classList.contains("select-none")).toBe(true);
      expect(component.classList.contains("custom-class")).toBe(true);
    });

    it("should render both dual handles on the track", () => {
      const { container } = render(<DatePagination />);

      // The draggable handles are the only cursor-grab elements
      const handles = container.querySelectorAll(".cursor-grab");
      expect(handles.length).toBe(2);
    });
  });

  describe("active range", () => {
    it("should show the active range with a clear affordance", () => {
      mockStoreState.filters.dateRange = {
        startDate: "2024-01-15",
        endDate: "2024-01-25",
      };

      render(<DatePagination />);

      // Start equal to today renders as the "Today" label
      expect(screen.getAllByText("Today").length).toBeGreaterThan(0);
      expect(screen.getByText("01/25")).toBeInTheDocument();
      expect(screen.getByLabelText("Clear date range")).toBeInTheDocument();
    });

    it("should clear the stored range when the clear affordance is used", () => {
      mockStoreState.filters.dateRange = {
        startDate: "2024-01-15",
        endDate: "2024-01-25",
      };

      render(<DatePagination />);

      fireEvent.click(screen.getByLabelText("Clear date range"));

      expect(mockClearFilter).toHaveBeenCalledWith("dateRange");
    });

    it("should treat a stored start-only range as the full range", () => {
      // Full range is represented by no stored endDate; a start date equal to
      // today with no end date must still render the full "Today → All" state
      mockStoreState.filters.dateRange = { startDate: "2024-01-15" };

      render(<DatePagination />);

      expect(screen.getAllByText("Today").length).toBeGreaterThan(0);
      expect(screen.getAllByText("All").length).toBeGreaterThan(0);
    });
  });

  describe("track interaction", () => {
    it("should clear the filter when the track is used at its far end", () => {
      mockTrackGeometry();

      const { container } = render(<DatePagination />);
      const track = container.querySelector(".cursor-pointer") as HTMLElement;

      // Click at the far right (x=100 → "All" checkpoint). The end handle is
      // already at the final checkpoint, but the start handle is further from
      // the click, so the start expands instead — resolving the full range,
      // which clears the stored filter.
      fireEvent.click(track, { clientX: 100 });

      expect(mockClearFilter).toHaveBeenCalledWith("dateRange");
    });

    it("should snap a track click to the nearest checkpoint and update the range", () => {
      mockTrackGeometry();

      const { container } = render(<DatePagination />);
      const track = container.querySelector(".cursor-pointer") as HTMLElement;

      // x=40 resolves to the "1 wk" checkpoint (today + 7 days) while the end
      // handle stays at the "All" checkpoint (today + 365 days)
      fireEvent.click(track, { clientX: 40 });

      expect(mockUpdateFilter).toHaveBeenCalledWith("dateRange", {
        startDate: "2024-01-22",
        endDate: "2025-01-14",
      });
    });

    it("should update the range start when the start handle is dragged", () => {
      mockTrackGeometry();

      const { container } = render(<DatePagination />);

      const [startHandle] = container.querySelectorAll(".cursor-grab");

      // Press the start handle, drag to x=40 ("1 wk") and release
      fireEvent.mouseDown(startHandle as HTMLElement);
      fireEvent.mouseMove(window, { clientX: 40 });
      fireEvent.mouseUp(window);

      expect(mockUpdateFilter).toHaveBeenCalledWith("dateRange", {
        startDate: "2024-01-22",
        endDate: "2025-01-14",
      });
      expect(mockClearFilter).not.toHaveBeenCalled();
    });
  });

  describe("date calculations", () => {
    it("should render condensed MM/DD labels for the stored range", () => {
      mockStoreState.filters.dateRange = {
        startDate: "2024-02-01",
        endDate: "2024-02-14",
      };

      render(<DatePagination />);

      expect(screen.getByText("02/01")).toBeInTheDocument();
      expect(screen.getByText("02/14")).toBeInTheDocument();
    });
  });

  describe("data integrity", () => {
    it("should only touch the dateRange filter", () => {
      mockTrackGeometry();

      const { container } = render(<DatePagination />);
      const track = container.querySelector(".cursor-pointer") as HTMLElement;
      fireEvent.click(track, { clientX: 40 });

      expect(mockUpdateFilter).toHaveBeenCalled();
      for (const call of mockUpdateFilter.mock.calls) {
        expect(call[0]).toBe("dateRange");
      }
      expect(mockClearFilter).not.toHaveBeenCalled();
    });
  });
});
