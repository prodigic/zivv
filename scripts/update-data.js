import fs from "fs";
import path from "path";

const projectRoot = path.resolve(process.cwd());
const dataDir = path.join(projectRoot, "data");

function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error("Usage: node scripts/update-data.js <path_to_new_data_file>");
    process.exit(1);
  }

  const inputFilePath = path.resolve(projectRoot, inputFile);

  if (!fs.existsSync(inputFilePath)) {
    console.error(`Input file not found: ${inputFilePath}`);
    process.exit(1);
  }

  console.log(`Processing new data from: ${inputFile}`);

  const newEventsRaw = fs.readFileSync(inputFilePath, "utf-8");
  const existingEventsRaw = fs.readFileSync(
    path.join(dataDir, "events.txt"),
    "utf-8"
  );
  const existingVenuesRaw = fs.readFileSync(
    path.join(dataDir, "venues.txt"),
    "utf-8"
  );

  // --- Process Events ---
  const datePattern =
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\s+\w{3}/i;

  const splitEvents = (rawText) => {
    const events = [];
    let currentEvent = [];
    const lines = rawText.split("\n");
    let startIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      if (datePattern.test(lines[i])) {
        startIndex = i;
        break;
      }
    }

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      if (datePattern.test(line) && currentEvent.length > 0) {
        events.push(currentEvent.join("\n"));
        currentEvent = [line];
      } else {
        currentEvent.push(line);
      }
    }
    if (currentEvent.length > 0) {
      events.push(currentEvent.join("\n"));
    }
    return events.map((event) => event.trim()).filter(Boolean);
  };

  const newEventsList = splitEvents(newEventsRaw);
  const existingEventsList = splitEvents(existingEventsRaw);
  const existingEventsSet = new Set(existingEventsList);
  const newUniqueEvents = newEventsList.filter(
    (event) => !existingEventsSet.has(event)
  );

  if (newUniqueEvents.length > 0) {
    console.log(`Found ${newUniqueEvents.length} new events to add.`);
    const newEventsToAppend = "\n" + newUniqueEvents.join("\n");
    fs.appendFileSync(
      path.join(dataDir, "events.txt"),
      newEventsToAppend,
      "utf-8"
    );
    console.log("Appended new events to data/events.txt");
  } else {
    console.log("No new events found.");
  }

  // --- Process Venues ---
  const venueAliases = JSON.parse(
    fs.readFileSync(path.join(dataDir, "venue-aliases.json"), "utf-8")
  );

  const normalizeName = (name) => {
    return name
      .toLowerCase()
      .trim()
      .replace(/^(the|dj|a)\s+/i, "")
      .replace(/\s+(band|music|group)$/i, "")
      .replace(/['’]/g, "'")
      .replace(/["”“]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  };

  const newVenues = new Set();
  const venuePattern =
    /at\s+(.*?)(?=\s*(?:, S\.F\.|, Oakland|, Berkeley|, San Jose|, Santa Cruz|, Petaluma|, Novato|, Napa|, Saratoga|, Albany|, Emeryville|, Concord|, Hayward|, Alameda|, San Leandro|, Crockett|, Rohnert Park|, Mountain View|, Menlo Park|, Stanford|, Pacifica|, Half Moon Bay|, Walnut Creek|, Richmond|, El Cerrito|, Mill Valley|, San Rafael|, Santa Rosa|, Sonoma|, Vallejo|, Redwood City|, Cupertino|, Ben Lomond|, Livermore|, San Mateo|, Fremont|, Newark|, Pittsburg|, Daily City|, Treasure Island|, Bolinas|, Modesto|, Salinas|\$|\d+pm|a\/a|$))/i;

  newUniqueEvents.forEach((event) => {
    event.split("\n").forEach((line) => {
      if (line.includes(" at ")) {
        const parts = line.split(" at ");
        if (parts.length > 1) {
          const venuePart = parts[parts.length - 1];
          const match = ("at " + venuePart).match(venuePattern);
          if (match && match[1]) {
            const venueName = match[1].trim().replace(/,$/, "");
            if (venueName) {
              newVenues.add(venueName);
            }
          }
        }
      }
    });
  });

  const existingVenues = new Set();
  existingVenuesRaw.split("\n").forEach((line) => {
    if (line.trim()) {
      const venueName = line.split(",")[0].trim();
      existingVenues.add(normalizeName(venueName));
    }
  });

  const venuesToAdd = new Set();
  for (const originalVenueName of newVenues) {
    const aliasedVenueName =
      venueAliases[originalVenueName.toLowerCase()] || originalVenueName;
    const normalizedVenueName = normalizeName(aliasedVenueName);
    if (
      !existingVenues.has(normalizedVenueName) &&
      aliasedVenueName.length > 0
    ) {
      venuesToAdd.add(aliasedVenueName);
    }
  }

  if (venuesToAdd.size > 0) {
    console.log(`Found ${venuesToAdd.size} new venues to add.`);
    const newVenuesToAppend =
      "\n" +
      [...venuesToAdd]
        .sort()
        .map((venue) => `${venue},,,,`)
        .join("\n");
    fs.appendFileSync(
      path.join(dataDir, "venues.txt"),
      newVenuesToAppend,
      "utf-8"
    );
    console.log("Appended new venues to data/venues.txt");
  } else {
    console.log("No new venues found.");
  }
}

main();
