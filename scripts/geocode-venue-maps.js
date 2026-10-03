#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const directory = resolve("data/research/venue-maps");
mkdirSync(directory, { recursive: true });
const endpoint =
  "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";
const details = JSON.parse(
  readFileSync("data/venue-details.json", "utf8")
).venues;
const groups = new Map();
for (const row of details) {
  if (row.status === "unresolved" || !row.streetAddress || !row.city) continue;
  const street = row.streetAddress
    .replace(/^One\s+/i, "1 ")
    .replace(/\s+(?:#|suite\b|ste\b|unit\b).*/i, "")
    .trim();
  if (!/^\d+[A-Za-z]?\s+/.test(street)) continue;
  const key = `${street.toLowerCase()}|${row.city.toLowerCase()}`;
  if (!groups.has(key))
    groups.set(key, {
      id: String(row.venueId),
      street,
      city: row.city,
      state: "CA",
      venueIds: [],
    });
  groups.get(key).venueIds.push(row.venueId);
}
const queries = [...groups.values()];
const csvField = (value) => `"${String(value).replaceAll('"', '""')}"`;
const input =
  queries
    .map((row) =>
      [row.id, row.street, row.city, row.state, ""].map(csvField).join(",")
    )
    .join("\n") + "\n";
const digest = createHash("sha256").update(input).digest("hex");
writeFileSync(
  `${directory}/census-queries.json`,
  JSON.stringify(
    { endpoint, benchmark: "Public_AR_Current", inputDigest: digest, queries },
    null,
    2
  ) + "\n"
);
writeFileSync(`${directory}/census-input.csv`, input);
const outputPath = `${directory}/census-response.csv`;
const receiptPath = `${directory}/census-receipt.json`;
if (
  existsSync(outputPath) &&
  existsSync(receiptPath) &&
  JSON.parse(readFileSync(receiptPath, "utf8")).inputDigest === digest
) {
  console.log(
    JSON.stringify({
      cached: true,
      uniqueAddresses: queries.length,
      venues: queries.reduce((sum, row) => sum + row.venueIds.length, 0),
    })
  );
} else {
  const form = new FormData();
  form.set(
    "addressFile",
    new Blob([input], { type: "text/csv" }),
    "venue-addresses.csv"
  );
  form.set("benchmark", "Public_AR_Current");
  console.log(
    `Matching ${queries.length} unique public addresses with one Census batch request.`
  );
  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
    headers: {
      "User-Agent": "ZivvVenueMaps/1.0 (+https://github.com/prodigic/zivv)",
    },
    signal: AbortSignal.timeout(300000),
  });
  const text = await response.text();
  if (!response.ok || /^\s*</.test(text))
    throw new Error(
      `Census batch failed: HTTP ${response.status}, ${text.slice(0, 200)}`
    );
  writeFileSync(outputPath, text);
  writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        endpoint,
        benchmark: "Public_AR_Current",
        fetchedAt: new Date().toISOString(),
        inputDigest: digest,
        responseDigest: createHash("sha256").update(text).digest("hex"),
      },
      null,
      2
    ) + "\n"
  );
  console.log(
    JSON.stringify({
      cached: false,
      uniqueAddresses: queries.length,
      venues: queries.reduce((sum, row) => sum + row.venueIds.length, 0),
      bytes: text.length,
    })
  );
}
