const DATE_LINE = /^[a-z]{3}\s+\d{1,2}\s+\w{3}/i;
const CLUB_INFO_HEADER = /C\s*L\s*U\s*B\s+I\s*N\s*F\s*O/i;

export class EventSanitizer {
  /**
   * Collapse a multi-line events file (latest.txt / events.txt format) into
   * an array of single-line event strings.  Each element is one complete event.
   * Lines before the first date-line (headers etc.) and everything from the
   * club-info section onward are dropped.
   */
  static collapseToSingleLines(content: string): string[] {
    const lines = content.split("\n");
    const entries: string[] = [];
    let currentParts: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (CLUB_INFO_HEADER.test(trimmed)) break;

      if (DATE_LINE.test(trimmed)) {
        if (currentParts.length > 0) {
          entries.push(this.join(currentParts));
          currentParts = [];
        }
        currentParts = [trimmed];
      } else if (currentParts.length > 0) {
        // artist continuation, venue line, or venue-info continuation
        currentParts.push(trimmed);
      }
      // else: pre-first-date header line — skip
    }

    if (currentParts.length > 0) {
      entries.push(this.join(currentParts));
    }

    return entries;
  }

  private static join(parts: string[]): string {
    return parts.join(" ").replace(/\s{2,}/g, " ").trim();
  }
}
