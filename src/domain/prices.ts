import type { Price } from "./entities.ts";

export function freePrice(): Price {
  return { isFree: true, min: 0, max: 0 };
}

export function paidPrice(min?: number, max?: number): Price {
  if (min === undefined && max === undefined) {
    return { isFree: false };
  }

  if (min !== undefined && (!Number.isFinite(min) || min < 0)) {
    throw new Error("Minimum price must be a finite non-negative number");
  }
  if (max !== undefined && (!Number.isFinite(max) || max < 0)) {
    throw new Error("Maximum price must be a finite non-negative number");
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error("Minimum price must not exceed maximum price");
  }

  return { isFree: false, min, max };
}

export function priceOverlaps(
  price: Price,
  range: { readonly min?: number; readonly max?: number },
): boolean {
  if (price.isFree) {
    return range.min === undefined || range.min <= 0;
  }
  if (range.min !== undefined && price.max !== undefined && price.max < range.min) {
    return false;
  }
  if (range.max !== undefined && price.min !== undefined && price.min > range.max) {
    return false;
  }
  return true;
}

export function priceLabel(price: Price): string {
  if (price.isFree) return "Free";
  if (price.min === undefined && price.max === undefined) return "Price unknown";
  if (price.min !== undefined && price.max !== undefined && price.min === price.max) {
    return `$${price.min}`;
  }
  if (price.min !== undefined && price.max !== undefined) return `$${price.min}–$${price.max}`;
  if (price.min !== undefined) return `From $${price.min}`;
  return `Up to $${price.max}`;
}
