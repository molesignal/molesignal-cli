import type { Credentials } from './mcp.js';
import { ToolSession } from './tools.js';

/** What a connection check found: who answered, in which protocol, and how many tools it offers. */
export interface ConnectionStatus {
  server: string;
  version?: string | undefined;
  protocol?: string | undefined;
  tools: number;
}

/** Connects to MoleSignal's MCP endpoint, lists its tools, and leaves. */
export async function checkConnection(credentials: Credentials, version: string): Promise<ConnectionStatus> {
  const session = await ToolSession.open(credentials, version);
  try {
    const tools = await session.listTools();
    return {
      server: session.server.name,
      version: session.server.version,
      protocol: session.protocolVersion,
      tools: tools.length,
    };
  } finally {
    await session.close();
  }
}
