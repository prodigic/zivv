/** Shared filter state and hook, kept separate from Fast Refresh components. */
import { createContext, useContext } from "react";

interface FilterModalContextType {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  toggleModal: () => void;
}

export const FilterModalContext = createContext<
  FilterModalContextType | undefined
>(undefined);

export function useFilterModal() {
  const context = useContext(FilterModalContext);
  if (context === undefined) {
    throw new Error("useFilterModal must be used within a FilterModalProvider");
  }
  return context;
}
