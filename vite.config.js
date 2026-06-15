import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: 'localhost',
  },
  clearScreen: false,
});
