const UNTRUSTED_TAG = "untrusted_tool_result";

/**
 * Escape nested delimiter tags so external content cannot break out of the
 * `<untrusted_tool_result>` wrapper.
 */
export function escapeUntrustedDelimiter(text: string): string {
  return text
    .replaceAll(`<${UNTRUSTED_TAG}>`, `<\\${UNTRUSTED_TAG}>`)
    .replaceAll(`</${UNTRUSTED_TAG}>`, `<\\/${UNTRUSTED_TAG}>`);
}

/** Wrap model-facing external content in the untrusted result tag. */
export function wrapUntrustedContent(text: string): string {
  return `<${UNTRUSTED_TAG}>\n${escapeUntrustedDelimiter(text)}\n</${UNTRUSTED_TAG}>`;
}

/** Strip the wrapper tags for clean UI rendering. */
export function stripUntrustedWrapper(text: string): string {
  const start = new RegExp(`^<${UNTRUSTED_TAG}>\\n`);
  const end = new RegExp(`\\n</${UNTRUSTED_TAG}>$`);
  return text.replace(start, "").replace(end, "");
}
