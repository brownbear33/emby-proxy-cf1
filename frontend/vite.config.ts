import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname),
  plugins: [vue()],
  build: {
    outDir: resolve(__dirname, '../dist'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
