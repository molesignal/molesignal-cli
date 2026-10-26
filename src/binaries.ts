/**
 * What a debug artifact says about itself: the architecture and the build ID
 * of an ELF file (Android native libraries, Flutter symbols), the UUID and
 * the architecture of each slice of a Mach-O file (an Apple dSYM).
 */

/** One build of a binary: its architecture, its build ID or UUID, and its bytes. */
export interface BinarySlice {
  architecture: string;
  debugId: string;
  bytes: Uint8Array;
}

const ELF_MACHINES: Record<number, string> = { 3: 'x86', 40: 'arm', 62: 'x86_64', 183: 'arm64' };

const MACH_CPU_TYPES: Record<number, string> = {
  7: 'x86',
  12: 'arm',
  0x01000007: 'x86_64',
  0x0100000c: 'arm64',
  0x0200000c: 'arm64_32',
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Whether the bytes start an ELF file. */
export function isElf(bytes: Uint8Array): boolean {
  return bytes.length > 52 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

/** The GNU build ID in a run of ELF notes, if one is there. */
function buildIdInNotes(view: DataView, start: number, size: number, little: boolean): string | undefined {
  let offset = start;
  const end = Math.min(view.byteLength, start + size);
  while (offset + 12 <= end) {
    const nameSize = view.getUint32(offset, little);
    const descSize = view.getUint32(offset + 4, little);
    const type = view.getUint32(offset + 8, little);
    const name = offset + 12;
    const desc = name + Math.ceil(nameSize / 4) * 4;
    if (desc + descSize > end) return undefined;
    const isGnu =
      nameSize === 4 &&
      view.getUint8(name) === 0x47 &&
      view.getUint8(name + 1) === 0x4e &&
      view.getUint8(name + 2) === 0x55 &&
      view.getUint8(name + 3) === 0;
    if (isGnu && type === 3 && descSize > 0) {
      return hex(new Uint8Array(view.buffer, view.byteOffset + desc, descSize));
    }
    offset = desc + Math.ceil(descSize / 4) * 4;
  }
  return undefined;
}

/** The architecture and the GNU build ID of an ELF file; the build ID is empty when it has none. */
export function readElf(bytes: Uint8Array): BinarySlice {
  if (!isElf(bytes)) throw new Error('not an ELF file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wide = bytes[4] === 2;
  const little = bytes[5] !== 2;
  const machine = view.getUint16(18, little);
  const architecture = ELF_MACHINES[machine] ?? `elf-${machine}`;
  const number = (offset: number) => (wide ? Number(view.getBigUint64(offset, little)) : view.getUint32(offset, little));

  // Section headers first: a stripped file may keep only its program headers.
  const sectionOffset = number(wide ? 0x28 : 0x20);
  const sectionSize = view.getUint16(wide ? 0x3a : 0x2e, little);
  const sections = view.getUint16(wide ? 0x3c : 0x30, little);
  for (let index = 0; index < sections; index += 1) {
    const at = sectionOffset + index * sectionSize;
    if (at + sectionSize > bytes.length) break;
    if (view.getUint32(at + 4, little) !== 7) continue;
    const offset = wide ? Number(view.getBigUint64(at + 24, little)) : view.getUint32(at + 16, little);
    const size = wide ? Number(view.getBigUint64(at + 32, little)) : view.getUint32(at + 20, little);
    const id = buildIdInNotes(view, offset, size, little);
    if (id) return { architecture, debugId: id, bytes };
  }

  const programOffset = number(wide ? 0x20 : 0x1c);
  const programSize = view.getUint16(wide ? 0x36 : 0x2a, little);
  const programs = view.getUint16(wide ? 0x38 : 0x2c, little);
  for (let index = 0; index < programs; index += 1) {
    const at = programOffset + index * programSize;
    if (at + programSize > bytes.length) break;
    if (view.getUint32(at, little) !== 4) continue;
    const offset = wide ? Number(view.getBigUint64(at + 8, little)) : view.getUint32(at + 4, little);
    const size = wide ? Number(view.getBigUint64(at + 32, little)) : view.getUint32(at + 16, little);
    const id = buildIdInNotes(view, offset, size, little);
    if (id) return { architecture, debugId: id, bytes };
  }

  return { architecture, debugId: '', bytes };
}

/** Whether the bytes start a Mach-O file, thin or fat. */
export function isMachO(bytes: Uint8Array): boolean {
  if (bytes.length < 32) return false;
  const magic = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  return [0xcafebabe, 0xcafebabf, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic);
}

/** A UUID as Apple tools print it: `8A2C…-…`, upper case. */
function uuidText(bytes: Uint8Array): string {
  const text = hex(bytes).toUpperCase();
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/** The architecture and the UUID of a thin Mach-O file. */
function readThin(bytes: Uint8Array): BinarySlice {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const wide = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const cpu = view.getInt32(4, little) >>> 0;
  const architecture = MACH_CPU_TYPES[cpu] ?? `cpu-${cpu}`;
  const commands = view.getUint32(16, little);

  let offset = wide ? 32 : 28;
  for (let index = 0; index < commands && offset + 8 <= bytes.length; index += 1) {
    const command = view.getUint32(offset, little);
    const size = view.getUint32(offset + 4, little);
    if (command === 0x1b && offset + 24 <= bytes.length) {
      return { architecture, debugId: uuidText(bytes.subarray(offset + 8, offset + 24)), bytes };
    }
    if (size < 8) break;
    offset += size;
  }
  return { architecture, debugId: '', bytes };
}

/**
 * The slices of a Mach-O file, each with its architecture, UUID and bytes:
 * one for a thin file, one an architecture for a universal (fat) one, which
 * MoleSignal takes one at a time.
 */
export function readMachO(bytes: Uint8Array): BinarySlice[] {
  if (!isMachO(bytes)) throw new Error('not a Mach-O file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return [readThin(bytes)];

  const wide = magic === 0xcafebabf;
  const count = view.getUint32(4, false);
  const slices: BinarySlice[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = 8 + index * (wide ? 32 : 20);
    if (at + (wide ? 32 : 20) > bytes.length) break;
    const offset = wide ? Number(view.getBigUint64(at + 8, false)) : view.getUint32(at + 8, false);
    const size = wide ? Number(view.getBigUint64(at + 16, false)) : view.getUint32(at + 12, false);
    if (offset + size > bytes.length) throw new Error('the universal binary is cut short');
    slices.push(readThin(bytes.subarray(offset, offset + size)));
  }
  return slices;
}
