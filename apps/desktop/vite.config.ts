import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root:'src/renderer',
  base:'./',
  plugins:[vue()],
  resolve:{alias:{'@':fileURLToPath(new URL('./src/renderer',import.meta.url))}},
  build:{outDir:'../../dist/renderer',emptyOutDir:true}
});
