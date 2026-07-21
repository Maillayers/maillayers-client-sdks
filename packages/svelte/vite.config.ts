import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  plugins: [
    svelte({
      compilerOptions: {
        compatibility: { componentApi: 4 },
      },
    }),
  ],
  define: {
    __MAILLAYERS_PACKAGE_VERSION__: JSON.stringify(packageVersion),
  },
  resolve: {
    conditions: ['browser', 'import', 'module', 'default'],
  },
  build: {
    lib: {
      entry: resolve('src/index.ts'),
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.js' : 'index.cjs'),
    },
    rollupOptions: {
      external: ['svelte', /^svelte\//],
    },
    sourcemap: false,
    minify: true,
    emptyOutDir: true,
  },
});
