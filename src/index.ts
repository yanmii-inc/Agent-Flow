import { Db } from './db/index';
import { ApiServer } from './api/server';
import { runCLI } from './cli';
import { scanWorkspaces } from './scan';

// CLI mode: if arguments are provided, run as CLI
if (process.argv.length > 2) {
  await runCLI();
  process.exit(0);
}

const dbPath = process.env['MANDOR_DB_PATH'] ?? 'mandor.db';
const port = parseInt(process.env['PORT'] ?? '3000', 10);
const hostname = process.env['HOST'] ?? '0.0.0.0';

const db = new Db(dbPath);
const server = new ApiServer(db);
server.start(port, hostname);

// Initial workspace scan
console.log('Scanning workspace roots for .mandor.json files...');
try {
  const result = scanWorkspaces(db);
  console.log(`Workspace scan complete: ${result.created} created, ${result.updated} updated, ${result.deleted} removed (${result.projects.length} total projects)`);
} catch (err: any) {
  console.error('Workspace scan failed:', err.message);
}

// Graceful shutdown
const shutdown = () => {
  console.log('\nShutting down...');
  server.stop();
  db.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
