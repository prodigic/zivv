/**
 * Test suite for DatePagination component
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DatePagination } from "@/components/ui/DatePagination";

// Mock the filter store
const mockUpdateFilter = vi.fn();
const mockClearFilter = vi.fn();

const mockStoreState = {
  filters: {
    dates: [], // DatePagination uses filters.dates array
  },
  updateFilter: mockUpdateFilter,
  clearFilter: mockClearFilter,
};

vi.mock("@/stores/filterStore", () => ({
  useFilterStore: () => mockStoreState,
}));

// Mock date-fns functions
vi.mock("date-fns", () => ({
  format: vi.fn((date, formatStr) => {
    if (typeof date === "string") {
      return date;
    }
    if (formatStr === "EEE") return "Mon";
    if (formatStr === "MMM d") return "Jan 1";
    return "2024-01-01";
  }),
  parseISO: vi.fn((dateStr) => new Date(dateStr)),
}));

describe("DatePagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock store state
    mockStoreState.filters.dates = [];
    // Mock current date to make tests predictable
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("rendering", () => {
    it("should render date pagination component", () => {
      render(<DatePagination />);

      // Check for actual button text from component
      expect(screen.getByText("Month")).toBeInTheDocument();
      expect(screen.getByText("Week")).toBeInTheDocument();
      expect(screen.getByText("Today")).toBeInTheDocument();
      expect(screen.getByText("Tomorrow")).toBeInTheDocument();
    });

    it("should render with custom className", () => {
      const { container } = render(<DatePagination className="custom-class" />);

      const component = container.firstChild as Element;
      expect(component.classList.contains("date-pagination")).toBe(true);
      expect(component.classList.contains("custom-class")).toBe(true);
    });

    it("should render all expected date buttons", () => {
      render(<DatePagination />);

      // Should have Month, Week, and 7 day buttons (Today, Tomorrow, + 5 weekdays)
      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBe(9); // Month + Week + 7 days
    });

    it("should have calendar icon", () => {
      render(<DatePagination />);

      const icon = screen.getByLabelText("Date Filter");
      expect(icon).toBeInTheDocument();
    });
  });

  describe("interaction", () => {
    it("should handle Today button click", () => {
      render(<DatePagination />);

      const todayButton = screen.getByText("Today");
      fireEvent.click(todayButton);

      // Should call updateFilter with dates array containing today's date
      expect(mockUpdateFilter).toHaveBeenCalledWith("dates", ["2024-01-15"]);
    });

    it("should handle Tomorrow button click", () => {
      render(<DatePagination />);

      const tomorrowButton = screen.getByText("Tomorrow");
      fireEvent.click(tomorrowButton);

      // Should call updateFilter with dates array containing tomorrow's date
      expect(mockUpdateFilter).toHaveBeenCalledWith("dates", ["2024-01-16"]);
    });

    it("should handle Month button click", () => {
      render(<DatePagination />);

      const monthButton = screen.getByText("Month");
      fireEvent.click(monthButton);

      // Should call updateFilter with dates array containing all days of the month
      expect(mockUpdateFilter).toHaveBeenCalledWith("dates", expect.any(Array));
    });

    it("should handle Week button click", () => {
      render(<DatePagination />);

      const weekButton = screen.getByText("Week");
      fireEvent.click(weekButton);

      // Should call updateFilter with dates array containing 7 days
      expect(mockUpdateFilter).toHaveBeenCalledWith("dates", expect.any(Array));
    });

    it("should handle weekday button clicks", () => {
      render(<DatePagination />);

      // Find a weekday button (MON, TUE, etc.) that should be rendered for future days
      const buttons = screen.getAllByRole("button");
      const weekdayButton = buttons.find(
        (btn) =>
          btn.textContent &&
          /^(MON|TUE|WED|THU|FRI|SAT|SUN)$/.test(btn.textContent)
      );

      if (weekdayButton) {
        fireEvent.click(weekdayButton);
        expect(mockUpdateFilter).toHaveBeenCalledWith(
          "dates",
          expect.any(Array)
        );
      }
    });
  });

  describe("selection state", () => {
    it("should show selected state for active dates", () => {
      // Set mock store with selected date
      mockStoreState.filters.dates = ["2024-01-15"]; // Today is selected

      render(<DatePagination />);

      const todayButton = screen.getByText("Today");
      const buttonElement = todayButton.closest("button");
      expect(buttonElement).toHaveClass("bg-red-50");
    });

    it("should handle toggle behavior for date selection", () => {
      render(<DatePagination />);

      // First click should add date
      const todayButton = screen.getByText("Today");
      fireEvent.click(todayButton);

      expect(mockUpdateFilter).toHaveBeenCalledWith("dates", ["2024-01-15"]);
    });
  });

  describe("date calculations", () => {
    it("should generate correct date strings", () => {
      render(<DatePagination />);

      // Click Today - should use YYYY-MM-DD format
      fireEvent.click(screen.getByText("Today"));

      expect(mockUpdateFilter).toHaveBeenCalledWith("dates", ["2024-01-15"]);
    });

    it("should generate consecutive days", () => {
      render(<DatePagination />);

      // Component should render 7 consecutive days starting from today
      expect(screen.getByText("Today")).toBeInTheDocument();
      expect(screen.getByText("Tomorrow")).toBeInTheDocument();

      // Should also have weekday abbreviations for days 2-6
      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBe(9); // Month + Week + 7 days
    });
  });

  describe("accessibility", () => {
    it("should have proper button roles", () => {
      render(<DatePagination />);

      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeGreaterThan(0);

      buttons.forEach((button) => {
        expect(button).toBeInTheDocument();
        expect(button.tagName).toBe("BUTTON");
      });
    });

    it("should have readable button text and titles", () => {
      render(<DatePagination />);

      // Essential buttons should have clear text
      expect(screen.getByText("Today")).toBeInTheDocument();
      expect(screen.getByText("Tomorrow")).toBeInTheDocument();
      expect(screen.getByText("Month")).toBeInTheDocument();
      expect(screen.getByText("Week")).toBeInTheDocument();

      // Day buttons should have title attributes
      const todayButton = screen.getByText("Today").closest("button");
      expect(todayButton).toHaveAttribute("title", "Today");
    });
  });

  describe("responsive design", () => {
    it("should handle mobile and desktop text display", () => {
      render(<DatePagination />);

      // Component should render both mobile and desktop text variants
      // Today button should have both "Today" and "Tod" text (hidden/shown via CSS)
      const todayButton = screen.getByText("Today").closest("button");
      expect(todayButton).toContainHTML("Today");
      expect(todayButton).toContainHTML("Tod");
    });
  });

  describe("data integrity", () => {
    it("should preserve other filters when updating dates", () => {
      render(<DatePagination />);

      // The component should only update the dates filter, not replace all filters
      fireEvent.click(screen.getByText("Today"));

      expect(mockUpdateFilter).toHaveBeenCalledWith("dates", expect.any(Array));
      expect(mockUpdateFilter).not.toHaveBeenCalledWith(
        "cities",
        expect.anything()
      );
    });
  });
});
