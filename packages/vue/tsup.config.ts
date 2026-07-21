import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  sourcemap: false,
  clean: true,
  dts: true,
  minify: true,
  target: 'es2019',
  outDir: 'dist',
  external: ['vue'],
  tsconfig: './tsconfig.json',
  define: { __MAILLAYERS_PACKAGE_VERSION__: JSON.stringify(packageVersion) },
});
