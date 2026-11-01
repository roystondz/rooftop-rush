import { existsSync } from 'node:fs';
import { DEFAULT_PORT } from '../shared/protocol';
import { startServer } from './server';

// Hosting services tell the server which port to use through the PORT variable.
const port = Number(process.env.PORT ?? DEFAULT_PORT);
// After `npm run build`, serve the game page from the same address as the multiplayer server.
const staticDir = existsSync('dist/index.html') ? 'dist' : undefined;

startServer(port, staticDir).then((s) => {
  console.log(`Rooftop Rush server listening on port ${s.port}${staticDir ? ', serving the game from dist/' : ''}`);
});
