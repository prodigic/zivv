import { describe, expect, it } from "vitest";
import { freePrice, paidPrice, priceLabel, priceOverlaps } from "../prices.ts";

describe("domain price semantics", () => {
  it("represents free events explicitly", () => {
    const price = freePrice();
    expect(price.isFree).toBe(true);
    expect(priceOverlaps(price, { max: 0 })).toBe(true);
    expect(priceLabel(price)).toBe("Free");
  });

  it("supports open-ended and bounded paid prices", () => {
    expect(priceLabel(paidPrice(20, 35))).toBe("$20–$35");
    expect(priceLabel(paidPrice(20))).toBe("From $20");
    expect(priceLabel(paidPrice(undefined, 50))).toBe("Up to $50");
    expect(priceOverlaps(paidPrice(20, 35), { min: 30, max: 40 })).toBe(true);
    expect(priceOverlaps(paidPrice(20, 35), { min: 40 })).toBe(false);
  });

  it("rejects reversed or negative ranges", () => {
    expect(() => paidPrice(40, 20)).toThrow();
    expect(() => paidPrice(-1)).toThrow();
  });
});
