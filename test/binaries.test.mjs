import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isElf, isMachO, readElf, readMachO } from '../dist/index.js';

import { elf32, elf64, fat, machO } from './fixtures.mjs';

const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;

test('an ELF file tells its architecture and its build ID, from a section or a program header', () => {
  const sixtyFour = elf64(183, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  assert.equal(isElf(sixtyFour), true);
  assert.deepEqual(
    { architecture: readElf(sixtyFour).architecture, debugId: readElf(sixtyFour).debugId },
    { architecture: 'arm64', debugId: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
  );
  const thirtyTwo = readElf(elf32(40, '00112233445566778899aabbccddeeff'));
  assert.equal(thirtyTwo.architecture, 'arm');
  assert.equal(thirtyTwo.debugId, '00112233445566778899aabbccddeeff');
  assert.equal(isElf(Buffer.from('not an elf file, just some text to be long enough for the check')), false);
});

test('a dSYM tells the UUID of each architecture, a universal one slice by slice', () => {
  const arm = machO(ARM64, '8a2c4f10-1d2e-3f40-5a6b-7c8d9e0f1a2b');
  assert.equal(isMachO(arm), true);
  assert.deepEqual(
    readMachO(arm).map(({ architecture, debugId }) => ({ architecture, debugId })),
    [{ architecture: 'arm64', debugId: '8A2C4F10-1D2E-3F40-5A6B-7C8D9E0F1A2B' }],
  );

  const intel = machO(X86_64, '00000000-0000-0000-0000-000000000001');
  const slices = readMachO(fat([arm, intel]));
  assert.deepEqual(
    slices.map(({ architecture, debugId }) => ({ architecture, debugId })),
    [
      { architecture: 'arm64', debugId: '8A2C4F10-1D2E-3F40-5A6B-7C8D9E0F1A2B' },
      { architecture: 'x86_64', debugId: '00000000-0000-0000-0000-000000000001' },
    ],
  );
  // Each slice goes up as the thin file it is.
  assert.deepEqual(Buffer.from(slices[1].bytes), intel);
});
