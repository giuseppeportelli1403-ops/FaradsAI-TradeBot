// Shared LLM-output helpers.
//
// CRITICAL FIX 2026-04-29 (audit pass): pre-fix, every agent extracted text
// from the Anthropic response with:
//
//   const text = response.content[0].type === 'text' ? response.content[0].text : '';
//
// This pattern is BROKEN when `thinking: { type: 'adaptive' }` is enabled —
// content[0] is typically a ThinkingBlock, not a TextBlock, so `text === ''`
// and downstream JSON parsing always falls through to the failure default.
//
// The Analyst was REJECTING by default 100% of the time. Reflection wrote
// no lessons. Researcher's brief was a "theme extraction failed" stub.
// EOD journal was silently empty. All five agents broken in the same way.
//
// This module centralises the fix. extractText iterates ALL content blocks
// and concatenates the text ones. extractJsonObject does balanced-brace
// scanning (not greedy regex) so a stray '}' in trailing prose can't
// splice junk into the parse target.

/** Loose shape for Anthropic ContentBlock. Accepts the SDK's typed union
 * (TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock | ...)
 * via `unknown[]` — the helper inspects `type` field at runtime and casts
 * the text-block subset internally. */
export type ContentBlockLike = unknown;

/**
 * Concatenate all text blocks in a Claude response, joined by '\n'. Skips
 * thinking, tool_use, and any non-text blocks. Returns '' for empty,
 * undefined, or null input. Whitespace is preserved verbatim — JSON inside
 * may legitimately use newlines and indentation.
 */
export function extractText(content: ContentBlockLike[] | null | undefined): string {
  if (!Array.isArray(content) || content.length === 0) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n');
}

/**
 * Find the first balanced JSON object in `text` and return its substring.
 * Returns null if none. Brace-aware: respects strings (inside double-quotes,
 * '{' and '}' don't count) and escapes ('\"' inside a string isn't a string
 * terminator). This is meaningfully more robust than the prior greedy regex
 * `/\{[\s\S]*\}/` which spliced trailing prose into the match.
 *
 * Multiple objects: returns the FIRST. Markdown fences (```json ... ```)
 * are handled because the scanner just looks for braces and skips
 * everything else.
 */
export function extractJsonObject(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  // Find the first '{' that begins an object outside any string.
  // Then scan forward maintaining a depth counter; respect quoted strings
  // and escape sequences inside them.
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  // Reached end without closing — malformed.
  return null;
}

/**
 * Like extractJsonObject but returns the LAST balanced object in the text.
 * Useful for prompts where the LLM may include an example object before the
 * final answer ("Example: {...}\n\nFinal: {...}"). Codex review flagged
 * that "first object" is wrong for review-style prose; this is the safer
 * default for Reflection/Review/Analyst.
 */
export function extractLastJsonObject(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  // Walk forward collecting all balanced objects; return the last one.
  // Same scanner as extractJsonObject, but doesn't return on first close.
  let last: string | null = null;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      i++;
      continue;
    }
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let foundEnd = -1;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          foundEnd = j;
          break;
        }
      }
    }
    if (foundEnd === -1) {
      // Unbalanced from this position — give up.
      break;
    }
    last = text.slice(start, foundEnd + 1);
    i = foundEnd + 1;
  }
  return last;
}

/**
 * Race a promise against a deadline. On timeout, the deadline timer rejects
 * with `new Error('${label} timed out after ${ms}ms')`. On either outcome
 * the timer is cleared so it doesn't leak.
 *
 * Codex final-review (2026-04-29) P2 fix: pre-fix the Promise.race pattern
 * across multiple agents created a setTimeout that wasn't cleared on the
 * happy path. Each LLM call left a dangling timer for the full timeout
 * duration. Trivial cost individually but compounds across thousands of
 * cycles per day. This helper centralises the cleanup.
 *
 * Note: the underlying Anthropic request is NOT actually aborted on
 * timeout — the SDK doesn't expose AbortController on Messages.create in
 * v0.90. The caller stops awaiting; the SDK call still runs to completion
 * in the background and its result is discarded. Acceptable trade-off
 * (occasional zombie request, never blocks the cycle).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Combined helper: extract the first balanced JSON object from `text` and
 * JSON.parse it. Returns null on extraction failure OR parse failure
 * (caller can't tell which — that's intentional; if you need to log raw
 * text on parse failure, do it at the call site BEFORE calling this).
 */
export function parseJsonObject<T = Record<string, unknown>>(
  text: string | null | undefined,
): T | null {
  const json = extractJsonObject(text);
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * Combined helper: extract the LAST balanced JSON object from `text` and
 * JSON.parse it. Use this when the LLM's output may include a prose example
 * object before the final answer.
 */
export function parseLastJsonObject<T = Record<string, unknown>>(
  text: string | null | undefined,
): T | null {
  const json = extractLastJsonObject(text);
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
