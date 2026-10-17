/** A same-origin directory prefix shared by assets, routes and dataset requests. */
export function normalizeSiteBase(value = "/"): string {
  if (
    !/^\/(?:[A-Za-z0-9._-]+\/)*$/.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(
      "Site base must be a same-origin directory path ending in /"
    );
  return value;
}

export function siteCacheName(base: string): string {
  const normalized = normalizeSiteBase(base);
  return normalized === "/zivv/"
    ? "zivv-data-v6"
    : `zivv-data-v6:${encodeURIComponent(normalized)}`;
}

/** Render the Pages redirect for root, project, or nested-directory hosting. */
export function renderPagesFallback(html: string, base: string): string {
  const normalized = normalizeSiteBase(base);
  if (!/var pathSegmentsToKeep = \d+;/.test(html))
    throw new Error("Unrecognized Pages fallback template");
  return html
    .replace(
      /var pathSegmentsToKeep = \d+;/,
      `var pathSegmentsToKeep = ${normalized.split("/").filter(Boolean).length};`
    )
    .replaceAll("/zivv/", normalized)
    .replace(/<script type="module" src="[^"]*src\/main\.tsx"><\/script>/, "");
}

export function renderWebManifest(json: string, base: string): string {
  const normalized = normalizeSiteBase(base);
  const manifest = JSON.parse(json) as {
    scope: string;
    start_url: string;
    icons: { src: string }[];
  };
  manifest.scope = normalized;
  manifest.start_url = normalized;
  manifest.icons = manifest.icons.map((icon) => {
    const path = icon.src.replace(/^\/+/, "");
    if (
      !/^[A-Za-z0-9._/-]+$/.test(path) ||
      path.split("/").some((part) => part === ".." || part === ".")
    )
      throw new Error("Manifest icons must use local paths");
    return { ...icon, src: normalized + path };
  });
  return JSON.stringify(manifest, null, 2) + "\n";
}
