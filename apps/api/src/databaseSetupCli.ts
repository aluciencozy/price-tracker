import 'dotenv/config';
import { runDatabaseSetup } from './databaseSetup.js';

try {
  await runDatabaseSetup(process.argv[2]);
  console.log('Database operation completed. No credentials or user data printed.');
} catch {
  // Driver errors can contain hosts, usernames, URIs or provider response data.
  console.error('Database operation failed. Check command, explicit database URI, permissions, network access and replica-set transaction support.');
  process.exitCode = 1;
}
