import { Db } from './db/index';
import { ApiServer } from './api/server';

const dbPath = process.env['CONSIGN_DB_PATH'] ?? 'consign.db';
const port = parseInt(process.env['PORT'] ?? '3000', 10);
const hostname = process.env['HOST'] ?? '0.0.0.0';

const db = new Db(dbPath);
const server = new ApiServer(db);
server.start(port, hostname);

// Graceful shutdown
const shutdown = () => {
  console.log('\nShutting down...');
  server.stop();
  db.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
