import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The command, and the same pieces as a module for tests and for programs that embed them.
// Dependencies stay external: npm installs them next to the package.
export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  define: { __VERSION__: JSON.stringify(version) },
});
