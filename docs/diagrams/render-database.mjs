import { writeFileSync } from 'node:fs';

// One editable source for the checked-in Mermaid and SVG artifacts. No renderer,
// cloud service or third-party assets are needed to reproduce the diagram.
const entities = [
  ['User', 40, 100, ['email UNIQUE', 'passwordHash (private)', 'emailVerifiedAt, role']],
  ['Session', 460, 100, ['userId -> User', 'transport, secretHash (private)', 'expiresAt, revokedAt']],
  ['Device', 880, 100, ['userId -> User; sessionId -> Session', 'installationId UNIQUE', 'pushToken UNIQUE (private)']],
  ['AuthToken', 40, 350, ['userId -> User; purpose', 'tokenHash UNIQUE (private)', 'expiresAt, consumedAt']],
  ['TrackedItem', 460, 350, ['userId -> User; productId -> Product', 'targetPriceMinor, alerts, enabled', 'targetRevision, episodeId, state']],
  ['Product', 880, 350, ['provider + game/store/US/USD UNIQUE', 'steamAppId, dealId (distinct IDs)', 'price, success/attempt time, lease']],
  ['NotificationDelivery', 40, 600, ['trackedItemId -> TrackedItem', 'episodeId + channel UNIQUE per tracker', 'status, attempts, fenced lease']],
  ['PriceHistory', 460, 600, ['productId -> Product; checkId', 'priceMinor, observedAt, source', 'immutable; rolling 90-day cap']],
  ['ProviderBudget', 880, 600, ['_id = cheapshark (singleton)', 'shared pacing/cooldown', 'leaseToken, leaseUntil']],
];
const relations = [
  ['User', 'Session', 'owns'], ['User', 'AuthToken', 'has'],
  ['User', 'TrackedItem', 'owns'], ['User', 'Device', 'owns'],
  ['Session', 'Device', 'binds'], ['Product', 'TrackedItem', 'watched_by'],
  ['Product', 'PriceHistory', 'observed_as'], ['TrackedItem', 'NotificationDelivery', 'queues'],
  ['User', 'NotificationDelivery', 'receives'], ['Product', 'NotificationDelivery', 'qualifies'],
  ['PriceHistory', 'NotificationDelivery', 'references'],
];
const mmd = ['erDiagram', ...entities.map(([name]) => `    ${name}`),
  ...relations.map(([from, to, label]) => `    ${from} ||--o{ ${to} : ${label}`), ''].join('\n');
writeFileSync(new URL('database.mmd', import.meta.url), mmd);
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const edges = [
  ['M 390 175 H 460', '1 : many', 405, 158],
  ['M 810 175 H 880', '1 : many', 825, 158],
  ['M 215 270 V 350', '1 : many', 227, 315],
  ['M 390 230 H 425 V 425 H 460', 'owns', 430, 320],
  ['M 880 425 H 810', '1 : many', 825, 408],
  ['M 1055 520 V 560 H 635 V 600', '1 : many', 825, 550],
  ['M 635 520 V 550 H 215 V 600', '1 : many', 310, 540],
  ['M 460 675 H 390', 'reference', 394, 658],
];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="920" viewBox="0 0 1280 920" role="img" aria-labelledby="title description">
<title id="title">Price Tracker MongoDB ER diagram</title>
<desc id="description">Users own sessions, tokens and private trackers; Products and observed history are shared. Trackers queue independent channel deliveries. Device tokens bind to a current session. All foreign keys are listed on cards; principal relationships are connected.</desc>
<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#52647a"/></marker></defs>
<rect width="1280" height="920" fill="#f5f7fb"/>
<g font-family="Arial, sans-serif" fill="#182838">
<text x="40" y="45" font-size="26" font-weight="700">Price Tracker · MongoDB schema</text>
<text x="40" y="72" font-size="16">Steam / US / USD · shared offers and history · private accounts, trackers and deliveries</text>
${edges.map(([d, label, x, y]) => `<path d="${d}" fill="none" stroke="#52647a" stroke-width="2" marker-end="url(#arrow)"/><text x="${x}" y="${y}" font-size="12">${label}</text>`).join('\n')}
${entities.map(([name, x, y, fields]) => `<g transform="translate(${x} ${y})"><rect width="350" height="170" rx="10" fill="white" stroke="#9eafc0"/><path d="M 10 0 H 340 Q 350 0 350 10 V 44 H 0 V 10 Q 0 0 10 0" fill="#183e67"/><text x="16" y="29" font-size="18" font-weight="700" fill="white">${name}</text>${fields.map((field, index) => `<text x="16" y="${76 + index * 28}" font-size="14">${esc(field)}</text>`).join('')}</g>`).join('\n')}
<text x="40" y="820" font-size="15">Every collection has a primary key. Arrow direction: one → many. User/Session ownership is enforced by services.</text>
<text x="40" y="848" font-size="15">Delivery also references User, Product and PriceHistory. Device also references User. References are logical, not MongoDB foreign keys.</text>
<text x="40" y="876" font-size="15">ProviderBudget is an independent singleton. See docs/database.md for all unique indexes, TTLs and transaction requirements.</text>
</g></svg>`;
writeFileSync(new URL('database.svg', import.meta.url), svg);
