/**
 * Test suite for CityPagination component
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CityPagination } from "@/components/ui/CityPagination";

// Mock the filter store
const mockUpdateFilter = vi.fn();
const mockClearFilter = vi.fn();

const mockStoreState = {
  filters: {
    cities: [], // CityPagination uses filters.cities array
  },
  updateFilter: mockUpdateFilter,
  clearFilter: mockClearFilter,
};

vi.mock("@/stores/filterStore", () => ({
  useFilterStore: () => mockStoreState,
}));

describe("CityPagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock store state
    mockStoreState.filters.cities = [];
  });

  describe("rendering", () => {
    it("should render city pagination component", () => {
      render(<CityPagination />);

      // Check for actual city names from component
      expect(screen.getByText("San Francisco")).toBeInTheDocument();
      expect(screen.getByText("Oakland")).toBeInTheDocument();
      expect(screen.getByText("Berkeley")).toBeInTheDocument();
      expect(screen.getByText("Santa Cruz")).toBeInTheDocument();
      expect(screen.getByText("Other")).toBeInTheDocument();
    });

    it("should render with custom className", () => {
      const { container } = render(<CityPagination className="custom-class" />);

      const component = container.firstChild as Element;
      expect(component.classList.contains("city-pagination")).toBe(true);
      expect(component.classList.contains("custom-class")).toBe(true);
    });

    it("should render all expected city buttons", () => {
      render(<CityPagination />);

      // Should have 5 city buttons (SF, Oakland, Berkeley, Santa Cruz, Other)
      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBe(5);
    });

    it("should have cityscape icon", () => {
      render(<CityPagination />);

      const icon = screen.getByLabelText("City Filter");
      expect(icon).toBeInTheDocument();
    });
  });

  describe("interaction", () => {
    it("should handle San Francisco button click", () => {
      render(<CityPagination />);

      const sfButton = screen.getByText("San Francisco");
      fireEvent.click(sfButton);

      expect(mockUpdateFilter).toHaveBeenCalledWith("cities", [
        "San Francisco",
      ]);
    });

    it("should handle Oakland button click", () => {
      render(<CityPagination />);

      const oaklandButton = screen.getByText("Oakland");
      fireEvent.click(oaklandButton);

      expect(mockUpdateFilter).toHaveBeenCalledWith("cities", ["Oakland"]);
    });

    it("should handle Berkeley button click", () => {
      render(<CityPagination />);

      const berkeleyButton = screen.getByText("Berkeley");
      fireEvent.click(berkeleyButton);

      expect(mockUpdateFilter).toHaveBeenCalledWith("cities", ["Berkeley"]);
    });

    it("should handle Santa Cruz button click", () => {
      render(<CityPagination />);

      const santaCruzButton = screen.getByText("Santa Cruz");
      fireEvent.click(santaCruzButton);

      expect(mockUpdateFilter).toHaveBeenCalledWith("cities", ["Santa Cruz"]);
    });

    it("should handle Other cities button click", () => {
      render(<CityPagination />);

      const otherButton = screen.getByText("Other");
      fireEvent.click(otherButton);

      // Other should add all other cities: ["Albany", "Napa", "Novato", "140", "2045"]
      expect(mockUpdateFilter).toHaveBeenCalledWith("cities", [
        "Albany",
        "Napa",
        "Novato",
        "140",
        "2045",
      ]);
    });
  });

  describe("selection state", () => {
    it("should show selected state for active city", () => {
      // Mock store with selected city
      mockStoreState.filters.cities = ["San Francisco"];

      render(<CityPagination />);

      const sfButton = screen.getByText("San Francisco").closest("button");
      expect(sfButton).toHaveClass("bg-red-50");
    });

    it("should show selected state for Other when other cities are selected", () => {
      // Mock store with other cities selected
      mockStoreState.filters.cities = ["Albany", "Napa"];

      render(<CityPagination />);

      const otherButton = screen.getByText("Other").closest("button");
      expect(otherButton).toHaveClass("bg-red-50");
    });

    it("should handle multiple city selection", () => {
      // Mock store with multiple cities selected
      mockStoreState.filters.cities = ["San Francisco", "Oakland"];

      render(<CityPagination />);

      const sfButton = screen.getByText("San Francisco").closest("button");
      const oaklandButton = screen.getByText("Oakland").closest("button");

      expect(sfButton).toHaveClass("bg-red-50");
      expect(oaklandButton).toHaveClass("bg-red-50");
    });
  });

  describe("toggle behavior", () => {
    it("should add city to existing selection", () => {
      // Mock store with existing city selected
      mockStoreState.filters.cities = ["Oakland"];

      render(<CityPagination />);

      const sfButton = screen.getByText("San Francisco");
      fireEvent.click(sfButton);

      // Should add SF to existing selection
      expect(mockUpdateFilter).toHaveBeenCalledWith("cities", [
        "Oakland",
        "San Francisco",
      ]);
    });

    it("should remove city from selection when already selected", () => {
      // Mock store with city already selected
      mockStoreState.filters.cities = ["San Francisco"];

      render(<CityPagination />);

      const sfButton = screen.getByText("San Francisco");
      fireEvent.click(sfButton);

      // Should call clearFilter if removing last city, or updateFilter with remaining cities
      expect(mockClearFilter).toHaveBeenCalledWith("cities");
    });
  });

  describe("Other cities handling", () => {
    it("should handle Other cities toggle when none selected", () => {
      render(<CityPagination />);

      const otherButton = screen.getByText("Other");
      fireEvent.click(otherButton);

      // Should add all other cities
      expect(mockUpdateFilter).toHaveBeenCalledWith("cities", [
        "Albany",
        "Napa",
        "Novato",
        "140",
        "2045",
      ]);
    });

    it("should handle Other cities toggle when some are selected", () => {
      // Mock store with some other cities selected
      mockStoreState.filters.cities = ["San Francisco", "Albany", "Napa"];

      render(<CityPagination />);

      const otherButton = screen.getByText("Other");
      fireEvent.click(otherButton);

      // Should remove other cities, keeping main cities
      expect(mockUpdateFilter).toHaveBeenCalledWith("cities", [
        "San Francisco",
      ]);
    });
  });

  describe("accessibility", () => {
    it("should have proper button roles", () => {
      render(<CityPagination />);

      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBe(5);

      buttons.forEach((button) => {
        expect(button).toBeInTheDocument();
        expect(button.tagName).toBe("BUTTON");
      });
    });

    it("should have readable button text and titles", () => {
      render(<CityPagination />);

      // Essential buttons should have clear text and title attributes
      const sfButton = screen.getByText("San Francisco").closest("button");
      expect(sfButton).toHaveAttribute("title", "San Francisco");

      const oaklandButton = screen.getByText("Oakland").closest("button");
      expect(oaklandButton).toHaveAttribute("title", "Oakland");
    });

    it("should support keyboard navigation", () => {
      render(<CityPagination />);

      const firstButton = screen.getByText("San Francisco").closest("button");

      // Button should be focusable
      if (firstButton) {
        firstButton.focus();
        expect(document.activeElement).toBe(firstButton);
      }
    });
  });

  describe("responsive design", () => {
    it("should handle mobile viewport", () => {
      render(<CityPagination />);

      // Component should render both full names and abbreviated names
      // San Francisco button should contain both "San Francisco" and "SF"
      const sfButton = screen.getByText("San Francisco").closest("button");
      expect(sfButton).toContainHTML("San Francisco");
      expect(sfButton).toContainHTML("SF");
    });

    it("should handle desktop viewport", () => {
      render(<CityPagination />);

      // All city names should be visible
      expect(screen.getByText("San Francisco")).toBeInTheDocument();
      expect(screen.getByText("Oakland")).toBeInTheDocument();
      expect(screen.getByText("Berkeley")).toBeInTheDocument();
      expect(screen.getByText("Santa Cruz")).toBeInTheDocument();
      expect(screen.getByText("Other")).toBeInTheDocument();
    });
  });

  describe("data integrity", () => {
    it("should preserve existing filters when updating cities", () => {
      render(<CityPagination />);

      // The component should only update the cities filter
      fireEvent.click(screen.getByText("San Francisco"));

      expect(mockUpdateFilter).toHaveBeenCalledWith(
        "cities",
        expect.any(Array)
      );
      expect(mockUpdateFilter).not.toHaveBeenCalledWith(
        "dates",
        expect.anything()
      );
    });

    it("should handle empty selection properly", () => {
      render(<CityPagination />);

      // When no cities are selected, all buttons should be unselected
      const buttons = screen.getAllByRole("button");

      buttons.forEach((button) => {
        expect(button).not.toHaveClass("bg-red-50");
        expect(button).toHaveClass("bg-white");
      });
    });
  });
});
