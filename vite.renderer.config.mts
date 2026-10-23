import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: '/desktop/',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome130',
    modulePreload: { polyfill: false },
    sourcemap: false,
    // Local Electron bundle loaded from disk; React plus app code lands just under 1 MB minified.
    chunkSizeWarningLimit: 1000,
  },
});
