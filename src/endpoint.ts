/** Where MoleSignal serves MCP, under the address it is reached at. */
const MCP_PATH = '/api/v1/mcp';

/**
 * A MoleSignal address as it is kept: an http(s) origin with the path it is
 * served under, without a trailing slash or the MCP path. Accepts the address
 * of the web app, a page in it, or the MCP endpoint itself.
 */
export function serverAddress(address: string): string {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new Error(`"${address}" is not an address; write it like https://molesignal.example.com`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`"${address}" must start with https:// (or http:// on a local network)`);
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith(MCP_PATH)) path = path.slice(0, -MCP_PATH.length);
  return `${url.origin}${path}`;
}

/** The MCP endpoint of a MoleSignal address. */
export function mcpEndpoint(address: string): URL {
  return new URL(`${serverAddress(address)}${MCP_PATH}`);
}
