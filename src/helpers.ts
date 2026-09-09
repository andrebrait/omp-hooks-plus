// ============================================================================
// Helper functions: extract information from content
// ============================================================================

export function extractTextFromContent(content: unknown): string {
  if (!content) return "";

  if (Array.isArray(content)) {
    const textItems = content.filter(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        item.type === "text" &&
        typeof item.text === "string",
    );

    if (textItems.length > 0) {
      return textItems.map((item) => item.text).join("\n");
    }
  }

  if (typeof content === "string") {
    return content;
  }

  if (typeof content === "object" && content !== null) {
    if ("text" in content && typeof content.text === "string") {
      return content.text;
    }
  }

  return "";
}

/**
 * Extract error information from tool result content
 */
export function extractErrorFromContent(content: unknown): string {
  if (!content) return "Unknown error";

  const text = extractTextFromContent(content);
  if (text) {
    return text;
  }

  return JSON.stringify(content);
}

/**
 * Extract response object from tool result content
 */
export function extractResponseFromContent(content: unknown): Record<string, unknown> {
  if (!content) return {};

  // content may be an array or a single object
  if (Array.isArray(content)) {
    // Attempt to construct response object
    const response: Record<string, unknown> = {};
    for (const item of content) {
      if (item.type === "text" && typeof item.text === "string") {
        response.output = item.text;
      }
    }
    return response;
  }

  if (typeof content === "object" && content !== null) {
    return content as Record<string, unknown>;
  }

  if (typeof content === "string") {
    return { output: content };
  }

  return {};
}