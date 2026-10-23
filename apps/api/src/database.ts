import mongoose from 'mongoose';
import type { DatabaseStatus } from './app.js';

export function databaseStatus(uri?: string): DatabaseStatus {
  if (!uri) {
    return 'not_configured';
  }

  // Mongoose uses numeric connection states: 1 is connected, 2 is connecting.
  if (mongoose.connection.readyState === 1) {
    return 'connected';
  }

  if (mongoose.connection.readyState === 2) {
    return 'connecting';
  }

  return 'disconnected';
}

export async function connectDatabase(uri: string): Promise<void> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
