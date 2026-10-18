import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { type Credentials, remoteTransport } from './mcp.js';

/** A tool call MoleSignal refused or could not finish, with what it said. */
export class ToolError extends Error {
  override name = 'ToolError';
}

/** A tool result as MoleSignal sends it: content blocks, structured content, and whether it failed. */
interface CallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}

/** The text a tool result carries, joined. */
function textOf(result: CallResult): string {
  if (!Array.isArray(result.content)) return '';
  return result.content
    .map((block: unknown) =>
      block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? block.text : '',
    )
    .filter(Boolean)
    .join('\n');
}

/** What a failed tool call says: its structured message, else its text. */
function errorOf(result: CallResult): string {
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object' && 'message' in structured && typeof structured.message === 'string') {
    return structured.message;
  }
  return textOf(result) || 'the tool call failed';
}

/**
 * A session with MoleSignal's MCP endpoint for calling its tools directly, as the
 * commands that read data do. MoleSignal applies the caller's permissions and the
 * organization's tool policy to every call, the same as for an agent tool.
 */
export class ToolSession {
  private constructor(
    private readonly client: Client,
    private readonly transport: StreamableHTTPClientTransport,
  ) {}

  static async open(credentials: Credentials, version: string): Promise<ToolSession> {
    const client = new Client({ name: 'molesignal-cli', version });
    const transport = remoteTransport(credentials);
    await client.connect(transport);
    return new ToolSession(client, transport);
  }

  /** Runs one tool and returns its structured result. */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    // The SDK's type also allows the result shape of an older protocol, which MoleSignal does not send.
    const result = (await this.client.callTool({ name, arguments: args })) as CallResult;
    if (result.isError === true) throw new ToolError(errorOf(result));
    if (result.structuredContent !== undefined) return result.structuredContent;

    const text = textOf(result);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Ends the session at MoleSignal too. */
  async close(): Promise<void> {
    await this.transport.terminateSession().catch(() => undefined);
    await this.client.close();
  }
}
