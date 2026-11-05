import { describe, expect, it } from 'vitest';
import { validateSetupUri } from '../src/databaseSetup.js';

describe('database administration target', () => {
  it.each([undefined, '', 'https://example.invalid/db', 'mongodb://localhost', 'mongodb://localhost/', 'mongodb://localhost/admin', 'mongodb://localhost/test', 'mongodb://localhost/config', 'mongodb://localhost/local', 'mongodb://localhost/db/extra'])('rejects an unsafe or implicit target %s', uri => {
    expect(() => validateSetupUri(uri)).toThrow();
  });
  it.each(['mongodb://127.0.0.1:27028/price_tracker?directConnection=true', 'mongodb+srv://fixture:secret@example.invalid/price_tracker', 'mongodb://host1:27017,host2:27017/price_tracker?replicaSet=rs0'])('accepts an explicit application database', uri => {
    expect(validateSetupUri(uri)).toBe(uri);
  });
});
