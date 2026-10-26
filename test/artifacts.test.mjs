import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import { flutterTarget, sourceMaps, symbolFiles, uploadArtifact } from '../dist/index.js';

import { elf64, fakeApi, fat, machO, readMultipart } from './fixtures.mjs';

async function folder(files) {
  const root = await mkdtemp(join(tmpdir(), 'molesignal-artifacts-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test('every .map under a folder is a source map, under its own name; two of a name are refused', async () => {
  const root = await folder({
    'assets/app.8f312.js': 'code',
    'assets/app.8f312.js.map': '{}',
    'assets/chunks/vendor.1c2.js.map': '{}',
    'node_modules/x/x.js.map': '{}',
  });
  const maps = await sourceMaps([root], { platform: 'web' });
  assert.deepEqual(maps.map((map) => map.filename).sort(), ['app.8f312.js.map', 'vendor.1c2.js.map']);
  assert.deepEqual(new Set(maps.map((map) => `${map.kind} ${map.platform}`)), new Set(['javascript_sourcemap web']));

  const flutter = await sourceMaps([join(root, 'assets/app.8f312.js.map')], { platform: 'flutter', debugId: 'b1' });
  assert.equal(flutter[0].architecture, 'javascript');

  const twice = await folder({ 'a/main.js.map': '{}', 'b/main.js.map': '{}' });
  await assert.rejects(sourceMaps([twice], { platform: 'web' }), /are both main\.js\.map/);
});

test('symbols are found by what they are: Flutter, R8, native libraries and dSYMs', async () => {
  const root = await folder({
    'flutter/app.android-arm64.symbols': elf64(183, 'aa'),
    'android/mapping.txt': '# compiler: R8\n',
    'android/libnative.so': elf64(62, 'bb11'),
    'Checkout.app.dSYM/Contents/Resources/DWARF/Checkout': fat([
      machO(0x0100000c, '11111111-1111-1111-1111-111111111111'),
      machO(0x01000007, '22222222-2222-2222-2222-222222222222'),
    ]),
  });
  const found = await symbolFiles([join(root, 'flutter'), join(root, 'android'), join(root, 'Checkout.app.dSYM')], { debugId: undefined });
  const summary = found.map((artifact) => [artifact.filename, artifact.kind, artifact.platform, artifact.architecture, artifact.debugId]);
  assert.deepEqual(summary, [
    ['app.android-arm64.symbols', 'flutter_symbols', 'android', 'arm64', undefined],
    ['libnative.so', 'android_native_symbols', 'android', 'x86_64', 'bb11'],
    ['mapping.txt', 'android_mapping', 'android', undefined, undefined],
    ['Checkout', 'apple_dsym', 'ios', 'arm64', '11111111-1111-1111-1111-111111111111'],
    ['Checkout', 'apple_dsym', 'ios', 'x86_64', '22222222-2222-2222-2222-222222222222'],
  ]);
  assert.deepEqual(flutterTarget('app.ios-arm64.symbols'), { platform: 'ios', architecture: 'arm64' });
  assert.deepEqual(flutterTarget('app.android-x64.symbols'), { platform: 'android', architecture: 'x86_64' });
  assert.equal(flutterTarget('app.so'), undefined);
});

test('an upload is a form with the build, the kind and the file, gzipped', async () => {
  const api = await fakeApi({ 'POST /api/v1/debug-artifacts': async () => [200, { id: 'd1' }] });
  try {
    const root = await folder({ 'app.js.map': '{"version":3,"mappings":""}' });
    const [map] = await sourceMaps([root], { platform: 'web' });
    await uploadArtifact(
      { connection: { url: api.url, token: 'good' }, fetch },
      { application: 'checkout-web', service: 'web', release: '1.0.0' },
      map,
    );
    const { fields, file } = readMultipart(api.requests[0]);
    assert.deepEqual(fields, { application_id: 'checkout-web', service: 'web', release: '1.0.0', kind: 'javascript_sourcemap', platform: 'web' });
    assert.equal(file.name, 'app.js.map');
    assert.equal(gunzipSync(file.bytes).toString(), '{"version":3,"mappings":""}');
  } finally {
    api.close();
  }
});
