import { describe, expect, it } from 'vitest';
import { parseSteamAppId, usdToCents } from '../src/cheapshark.js';

describe('CheapShark adapter helpers', () => {
  it('gets the Steam app ID from a confirmed URL', () => {
    expect(parseSteamAppId('https://store.steampowered.com/app/620/')).toBe('620');
  });

  it('rejects an unsupported game', () => {
    expect(() =>
      parseSteamAppId('https://store.steampowered.com/app/999999/'),
    ).toThrow();
  });

  it('converts a USD price to cents', () => {
    expect(usdToCents('9.99')).toBe(999);
  });
});