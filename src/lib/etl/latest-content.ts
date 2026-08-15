const LIST_BANNER = /^\s*THE LIST\s*$/i;
const LIST_FOOTER = /^\s*Please feel free to forward The List on to your friends\.\s*$/i;
const DASH_SEPARATOR = /^\s*-+\s*$/;

/**
 * Remove the delivery-specific wrapper around a raw Steve List email.
 *
 * The source file may be either the historical plain-text body or the full
 * text exported from Gmail. In both cases, preserve the event listings,
 * radio links, and club information while dropping the email banner and
 * footer/link-reference block.
 */
export function normalizeLatestContent(content: string): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);

  let start = 0;
  if (firstContentIndex >= 0 && LIST_BANNER.test(lines[firstContentIndex])) {
    start = firstContentIndex + 1;
  }

  while (start < lines.length && !lines[start].trim()) start++;

  const footerIndex = lines.findIndex(
    (line, index) => index >= start && LIST_FOOTER.test(line)
  );
  let end = footerIndex >= 0 ? footerIndex : lines.length;

  while (end > start && (!lines[end - 1].trim() || DASH_SEPARATOR.test(lines[end - 1]))) {
    end--;
  }

  return lines.slice(start, end).join("\n") + "\n";
}
