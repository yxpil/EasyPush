import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: '/',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'chrome100',
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
});
