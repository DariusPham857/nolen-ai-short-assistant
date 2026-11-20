import 'dotenv/config';
import { migrateDatabase } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
migrateDatabase(url).then(() => console.log('Migration verified and complete')).catch(error => {
  console.error(error instanceof Error && error.message.startsWith('SCHEMA_MISMATCH') ? error.message : 'Migration failed');
  process.exitCode = 1;
});
