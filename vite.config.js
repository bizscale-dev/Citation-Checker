import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001' },
    // only the frontend needs hot reload; the server and any browser profile must not be watched
    watch: { ignored: ['**/.browser-profile/**', '**/server/**', '**/.env*'] },
  },
});
