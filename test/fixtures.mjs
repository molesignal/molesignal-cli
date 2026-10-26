/** Small binaries built byte by byte, the way the tools that make debug artifacts lay them out. */

/** A GNU build ID note. */
export function buildIdNote(id) {
  const desc = Buffer.from(id, 'hex');
  const note = Buffer.alloc(12 + 4 + Math.ceil(desc.length / 4) * 4);
  note.writeUInt32LE(4, 0);
  note.writeUInt32LE(desc.length, 4);
  note.writeUInt32LE(3, 8);
  note.write('GNU\0', 12, 'latin1');
  desc.copy(note, 16);
  return note;
}

/** A 64-bit little-endian ELF file whose build ID is in a PT_NOTE program header only. */
export function elf64(machine, id) {
  const note = buildIdNote(id);
  const file = Buffer.alloc(64 + 56 + note.length);
  file.write('\x7fELF', 0, 'latin1');
  file[4] = 2;
  file[5] = 1;
  file.writeUInt16LE(machine, 18);
  file.writeBigUInt64LE(64n, 32);
  file.writeUInt16LE(56, 54);
  file.writeUInt16LE(1, 56);
  file.writeUInt32LE(4, 64);
  file.writeBigUInt64LE(120n, 72);
  file.writeBigUInt64LE(BigInt(note.length), 96);
  note.copy(file, 120);
  return file;
}

/** A 32-bit little-endian ELF file whose build ID is in a SHT_NOTE section. */
export function elf32(machine, id) {
  const note = buildIdNote(id);
  const file = Buffer.alloc(52 + 40 + note.length);
  file.write('\x7fELF', 0, 'latin1');
  file[4] = 1;
  file[5] = 1;
  file.writeUInt16LE(machine, 18);
  file.writeUInt32LE(52, 32);
  file.writeUInt16LE(40, 46);
  file.writeUInt16LE(1, 48);
  file.writeUInt32LE(7, 52 + 4);
  file.writeUInt32LE(92, 52 + 16);
  file.writeUInt32LE(note.length, 52 + 20);
  note.copy(file, 92);
  return file;
}

/** A thin 64-bit Mach-O file with an LC_UUID. */
export function machO(cpu, uuid) {
  const file = Buffer.alloc(32 + 24);
  file.writeUInt32LE(0xfeedfacf, 0);
  file.writeInt32LE(cpu | 0, 4);
  file.writeUInt32LE(0xa, 12);
  file.writeUInt32LE(1, 16);
  file.writeUInt32LE(24, 20);
  file.writeUInt32LE(0x1b, 32);
  file.writeUInt32LE(24, 36);
  Buffer.from(uuid.replaceAll('-', ''), 'hex').copy(file, 40);
  return file;
}

/** A universal Mach-O file of the slices. */
export function fat(slices) {
  const header = Buffer.alloc(8 + slices.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  let offset = header.length;
  slices.forEach((slice, index) => {
    header.writeInt32BE(slice.readInt32LE(4), 8 + index * 20);
    header.writeUInt32BE(offset, 8 + index * 20 + 8);
    header.writeUInt32BE(slice.length, 8 + index * 20 + 12);
    offset += slice.length;
  });
  return Buffer.concat([header, ...slices]);
}

/**
 * MoleSignal's API for one token: it keeps every request it gets and answers
 * from `routes`, by method and path, with JSON.
 */
export async function fakeApi(routes) {
  const { createServer } = await import('node:http');
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, 'http://localhost');
    const seen = { method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers, body: Buffer.concat(chunks) };
    requests.push(seen);
    if (request.headers.authorization !== 'Bearer good') {
      response.writeHead(401, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ error: 'unauthorized', message: 'invalid API token' }));
    }
    const route = routes[`${request.method} ${url.pathname}`];
    const [status, body] = route ? await route(seen) : [404, { error: 'not_found', message: 'no such route' }];
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

/** The text fields and the file of a multipart form. */
export function readMultipart(request) {
  const boundary = /boundary=(.+)$/.exec(request.headers['content-type'])[1];
  const fields = {};
  let file;
  for (const part of request.body.toString('latin1').split(`--${boundary}`)) {
    const match = /^\r\nContent-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?\r\n(?:Content-Type: [^\r]+\r\n)?\r\n([\s\S]*)\r\n$/.exec(part);
    if (!match) continue;
    if (match[2]) file = { name: match[2], bytes: Buffer.from(match[3], 'latin1') };
    else fields[match[1]] = match[3];
  }
  return { fields, file };
}
