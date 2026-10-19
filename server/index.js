// Local server: the API from app.js plus the built frontend (npm run build && npm start).
// On Vercel, api/index.js serves the same app as a function and Vercel hosts the frontend.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import app from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');
app.use(express.static(dist));
app.get('*', (_, res, next) => res.sendFile(path.join(dist, 'index.html'), (e) => e && next()));

// a crashed Chrome tab or a dropped connection should fail one check, not kill the server
process.on('unhandledRejection', (err) => console.error('[unhandled]', err?.message || err));
process.on('uncaughtException', (err) => console.error('[uncaught]', err?.message || err));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Citation checker API on http://localhost:${PORT}`));
