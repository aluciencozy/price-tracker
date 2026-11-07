import { describe, expect, it } from 'vitest';
import { cheapSharkPurchaseUrl } from '../src/cheapshark.js';

describe('CheapShark purchase URL contract', () => {
  it.each([
    ['plain-id', 'plain-id'],
    ['a/b', 'a%2Fb'],
    ['a%2Fb', 'a%2Fb'],
    ['space id', 'space+id'],
    ['space%20and%2Bplus', 'space+and%2Bplus'],
    ['plus+id', 'plus%2Bid'],
    ['equals=id', 'equals%3Did'],
    ['percent%25', 'percent%25'],
    ['a%252Fb', 'a%252Fb'],
    ['*~', '*%7E'],
    ['😀', '%F0%9F%98%80'],
  ])('serializes %s exactly', (dealId, encoded) => {
    expect(cheapSharkPurchaseUrl(dealId)).toBe(`https://www.cheapshark.com/redirect?dealID=${encoded}`);
  });

  it.each(['bad%', 'bad%2', 'bad%GG', '%FF'])('rejects invalid encoding %s', (dealId) => {
    expect(() => cheapSharkPurchaseUrl(dealId)).toThrow('CheapShark returned an invalid deal ID.');
  });
});
