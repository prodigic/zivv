import { describe, expect, it } from "vitest";
import { compareDateOnly, dateOnly, eventDateFromInstant, eventDateSortValue, isDateOnlyInRange } from "../dates.ts";

describe("domain date policy", () => {
  it("accepts valid date-only values and rejects invalid calendar dates", () => {
    expect(dateOnly("2026-02-28")).toBe("2026-02-28");
    expect(() => dateOnly("2026-02-29")).toThrow();
    expect(() => dateOnly("2026-2-8")).toThrow();
  });

  it("compares date-only values lexically", () => {
    expect(compareDateOnly(dateOnly("2026-01-02"), dateOnly("2026-01-10"))).toBeLessThan(0);
    expect(isDateOnlyInRange(dateOnly("2026-01-10"), { start: dateOnly("2026-01-01"), end: dateOnly("2026-01-31") })).toBe(true);
    expect(isDateOnlyInRange(dateOnly("2026-02-01"), { end: dateOnly("2026-01-31") })).toBe(false);
  });

  it("uses the event timezone rather than the machine timezone", () => {
    const justBeforeLosAngelesMidnight = Date.parse("2026-03-08T07:59:00.000Z");
    const justAfterLosAngelesMidnight = Date.parse("2026-03-08T08:01:00.000Z");
    expect(eventDateFromInstant(justBeforeLosAngelesMidnight, "America/Los_Angeles")).toBe("2026-03-07");
    expect(eventDateFromInstant(justAfterLosAngelesMidnight, "America/Los_Angeles")).toBe("2026-03-08");
  });

  it("sorts unknown start times after known times on the same date", () => {
    const date = dateOnly("2026-04-04");
    expect(eventDateSortValue(date, "19:00")).toBe("2026-04-04|19:00");
    expect(eventDateSortValue(date)).toBe("2026-04-04|~");
  });
});
