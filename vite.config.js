import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(import.meta.dirname);
const WATCHED = [path.join(root, 'src'), path.join(root, 'public'), path.join(root, 'index.html'), path.join(root, 'vite.config.js')];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001' },
    // Watch only what the frontend is built from. Anything else in the folder (archives being
    // written, browser profiles, the server) can be locked by another program, and a locked
    // file crashes Vite's watcher on Windows (EBUSY).
    watch: {
      ignored: (file) => {
        const f = path.resolve(file);
        if (f === root) return false;
        return !WATCHED.some((w) => f === w || f.startsWith(w + path.sep) || w.startsWith(f + path.sep));
      },
    },
  },
});
