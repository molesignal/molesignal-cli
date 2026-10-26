import { Client, type StandardSchemaV1, type StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

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

/** What a tool result holds: its structured content, else its text read as JSON, else the text. */
function valueOf(result: CallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Takes a tool result as it comes. The 2025 protocol wants structured content
 * to be an object, and MoleSignal sends a list for the tools that list things.
 */
const ANY_RESULT: StandardSchemaV1<unknown> = {
  '~standard': { version: 1, vendor: 'molesignal', validate: (value: unknown) => ({ value }) },
};

/** The content of a form MoleSignal asks to be filled in: every yes-or-no field answered yes. */
function confirmedContent(schema: unknown): Record<string, boolean> {
  const properties =
    schema && typeof schema === 'object' && 'properties' in schema && schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, { type?: unknown }>)
      : {};
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([, property]) => property?.type === 'boolean')
      .map(([name]) => [name, true]),
  );
}

export interface SessionOptions {
  /**
   * Answers MoleSignal when it asks before it carries out a change: true to go
   * ahead. Without it every such question is declined.
   */
  confirm?: ((message: string) => Promise<boolean>) | undefined;
}

/**
 * A session with MoleSignal's MCP endpoint for calling its tools directly, as the
 * commands do. MoleSignal applies the caller's permissions and the
 * organization's tool policy to every call, the same as for an agent tool.
 *
 * The session speaks the 2026-07-28 protocol when MoleSignal does, which needs
 * no session kept at the server and lets MoleSignal ask for a confirmation in
 * the middle of a call; otherwise the 2025 one.
 */
export class ToolSession {
  private constructor(
    private readonly client: Client,
    private readonly transport: StreamableHTTPClientTransport,
  ) {}

  static async open(credentials: Credentials, version: string, options: SessionOptions = {}): Promise<ToolSession> {
    const client = new Client(
      { name: 'molesignal-cli', version },
      { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' } },
    );
    client.setRequestHandler('elicitation/create', async (request) => {
      const params = request.params;
      if ('mode' in params && params.mode === 'url') return { action: 'decline' };
      const accepted = options.confirm ? await options.confirm(params.message) : false;
      if (!accepted) return { action: 'decline' };
      const schema = 'requestedSchema' in params ? params.requestedSchema : undefined;
      return { action: 'accept', content: confirmedContent(schema) };
    });

    const transport = remoteTransport(credentials);
    await client.connect(transport);
    return new ToolSession(client, transport);
  }

  /** Who answered: the server's name and version. */
  get server(): { name: string; version?: string | undefined } {
    const server = this.client.getServerVersion();
    return { name: server?.name ?? 'MoleSignal', version: server?.version };
  }

  /** The protocol revision the session speaks. */
  get protocolVersion(): string | undefined {
    return this.client.getNegotiatedProtocolVersion();
  }

  /** The tools MoleSignal offers directly. */
  async listTools(): Promise<{ name: string }[]> {
    const tools: { name: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /** Whether the session speaks the 2026-07-28 protocol or a later one. */
  private get modern(): boolean {
    return (this.protocolVersion ?? '') >= '2026-07-28';
  }

  /** Runs one tool MoleSignal offers directly and returns its structured result. */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const params = { name, arguments: args };
    const result = (
      this.modern
        ? await this.client.callTool(params)
        : await this.client.request({ method: 'tools/call', params }, ANY_RESULT)
    ) as CallResult;
    if (result.isError === true) throw new ToolError(errorOf(result));
    return valueOf(result);
  }

  /** Runs any read-only tool of the catalogue. */
  read(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.call('call_read_tool', { name, arguments: args });
  }

  /**
   * Asks for a change through one managed tool. What comes back is the
   * approval MoleSignal opened for it, or, when its policy runs the change at
   * once, the execution.
   */
  manage(name: string, args: Record<string, unknown>, idempotencyKey: string): Promise<unknown> {
    return this.call('call_managed_tool', { name, arguments: args, idempotency_key: idempotencyKey });
  }

  /** Reads one resource MoleSignal publishes as JSON, such as `molesignal://tools/catalog`. */
  async resource(uri: string): Promise<unknown> {
    const result = await this.client.readResource({ uri });
    const first = result.contents[0];
    const text = first && 'text' in first && typeof first.text === 'string' ? first.text : '';
    return JSON.parse(text);
  }

  /** Ends the session, at MoleSignal too when it kept one. */
  async close(): Promise<void> {
    if (this.transport.sessionId) await this.transport.terminateSession().catch(() => undefined);
    await this.client.close();
  }
}
