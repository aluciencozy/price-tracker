import mongoose from 'mongoose';
import { reserveEmailSend } from '../../src/emailBudget.js';

const { TEST_MONGODB_URI: uri, EMAIL_BUDGET_TEST_DB: dbName, EMAIL_BUDGET_TEST_DISPOSABLE: disposable } = process.env;
if (!uri || disposable !== '1' || !/^price_tracker_test_email_[a-f0-9]{32}$/.test(dbName ?? '')) {
  throw new Error('A guarded disposable budget test database is required.');
}
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 5000, autoIndex: false });
process.stdout.write('ready\n');
await new Promise<void>(resolve => process.stdin.once('data', () => resolve()));
const decision = await reserveEmailSend({ dailyLimit: 9, monthlyLimit: 30 });
process.stdout.write(`${JSON.stringify(decision)}\n`);
await mongoose.disconnect();
