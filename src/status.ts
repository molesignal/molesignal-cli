import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { type Credentials, remoteTransport } from './mcp.js';

/** What a connection check found: who answered and how many tools it offers. */
export interface ConnectionStatus {
  server: string;
  version?: string | undefined;
  tools: number;
}

/** Connects to MoleSignal's MCP endpoint, lists its tools, and leaves. */
export async function checkConnection(credentials: Credentials, version: string): Promise<ConnectionStatus> {
  const client = new Client({ name: 'molesignal-cli', version });
  const transport = remoteTransport(credentials);
  await client.connect(transport);

  try {
    let tools = 0;
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools += page.tools.length;
      cursor = page.nextCursor;
    } while (cursor);

    const server = client.getServerVersion();
    return { server: server?.name ?? 'MoleSignal', version: server?.version, tools };
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close();
  }
}
