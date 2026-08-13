import { describe, expect, it } from "vitest";
import { validateGeneratedData } from "./generatedDataContract.js";

describe("generated data contract", () => {
  it("keeps referential integrity across chunks, entities, indexes, and projections", () => {
    const violations = validateGeneratedData();
    const structuralViolations = violations.filter(
      (violation) =>
        !["metadata-size", "metadata-checksum"].includes(violation.code)
    );

    expect(structuralViolations, JSON.stringify(structuralViolations, null, 2)).toEqual([]);
  });

  it("describes the exact bytes served by every manifest-referenced file", () => {
    const violations = validateGeneratedData().filter(
      (violation) =>
        violation.code === "metadata-size" || violation.code === "metadata-checksum"
    );

    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
