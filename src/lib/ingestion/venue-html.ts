import { createRequire } from "node:module";

/** Small server-side DOM contract; jsdom is an existing build dependency. */
export interface DomNode {
  textContent: string | null;
  innerHTML: string;
  outerHTML: string;
  tagName?: string;
  parentElement: DomNode | null;
  children: ArrayLike<DomNode>;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
  getAttribute(name: string): string | null;
  closest(selector: string): DomNode | null;
}

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html: string,
    options: { url: string }
  ) => { window: { document: DomNode } };
};

/** Scripts and remote resource execution are deliberately not enabled. */
export function htmlDocument(
  text: string,
  url = "https://example.invalid/"
): DomNode {
  return new JSDOM(text, { url }).window.document;
}

export function nodeText(node: DomNode | null | undefined): string {
  return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}
