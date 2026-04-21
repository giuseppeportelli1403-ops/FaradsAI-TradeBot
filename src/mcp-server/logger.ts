// MCP Tool Request Logger — logs every tool call for debugging and audit trail

export function logToolCall(toolName: string, params: Record<string, unknown>, result: unknown, durationMs: number, isError: boolean): void {
  const timestamp = new Date().toISOString();
  const level = isError ? 'ERROR' : 'INFO';
  const paramsStr = JSON.stringify(params).substring(0, 200);
  const resultStr = typeof result === 'string' ? result.substring(0, 200) : JSON.stringify(result).substring(0, 200);

  console.error(`[${timestamp}] [MCP] [${level}] ${toolName} (${durationMs}ms) params=${paramsStr} result=${resultStr}`);
}

// Wraps a tool handler with logging and error boundaries
export function wrapTool<T extends Record<string, unknown>>(
  toolName: string,
  handler: (params: T) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
): (params: T) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return async (params: T) => {
    const start = Date.now();
    try {
      const result = await handler(params);
      logToolCall(toolName, params as Record<string, unknown>, result.content[0]?.text, Date.now() - start, false);
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToolCall(toolName, params as Record<string, unknown>, msg, Date.now() - start, true);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, tool: toolName }) }],
        isError: true,
      };
    }
  };
}
