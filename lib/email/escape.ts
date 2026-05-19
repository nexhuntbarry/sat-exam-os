// HTML-escape helper for email templates. Every interpolated value
// (display names, URLs, free-form notes) MUST pass through this before
// being injected into a template string — otherwise a user-controlled
// value containing `<` or `"` can break out of an attribute and inject
// arbitrary markup into the recipient's inbox.

export function escapeHtml(input: unknown): string {
  if (input == null) return "";
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Stricter URL guard — only allow http(s). Prevents `javascript:` /
// `data:` / `mailto:` smuggling into href attributes.
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "#";
    return escapeHtml(u.toString());
  } catch {
    return "#";
  }
}
