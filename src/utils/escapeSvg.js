/**
 * Escapes text before inserting it into an SVG XML document.
 *
 * @param {unknown} value The value to escape.
 * @returns {string} XML-safe text.
 */
export function escapeSvg(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
