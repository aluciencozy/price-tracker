import pptxgen from './tools/node_modules/pptxgenjs/dist/pptxgen.cjs.js';
import { Resvg } from './tools/node_modules/@resvg/resvg-js/index.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slides } from './speaker-notes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const diagramDir = resolve(process.env.DIAGRAMS_DIR || resolve(here, '../diagrams/presentation'));
for (const { diagram } of slides.filter(s => s.diagram)) {
  if (!existsSync(resolve(diagramDir, `${diagram}.png`))) throw new Error(`Missing diagram: ${diagram}.png`);
}
const totalSeconds = slides.reduce((sum, s) => sum + s.seconds, 0);
if (slides.length !== 21 || totalSeconds !== 720 || slides.at(-1).id !== 'questions') throw new Error('Expected 21 timed slides totaling 12:00, ending with Questions.');
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Price Tracker team';
pptx.subject = 'COP 4331C presentation with complete presenter scripts';
pptx.title = 'Price Tracker — Your game. Your price.';
pptx.lang = 'en-US';
pptx.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial', lang: 'en-US' };
// sRGB equivalents of the website's OKLCH tokens in apps/web/src/styles.css.
// Bright primary teal is decorative; darker accent ink keeps small text readable.
const C = { ink: '031A1E', primary: '00BBA7', accentInk: '006363', secondaryInk: '2D4E54', background: 'F9FDFF', white: 'FFFFFF', muted: '50686D', accent: 'C3ECDF', border: 'DAE3E4' };
const W = 13.333333, H = 7.5, st = pptx.ShapeType;
const time = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
let elapsed = 0, textCount = 0;

function text(s, value, x, y, w, h, opt = {}) {
  if (x < 0 || y < 0 || x + w > W + .01 || y + h > H + .01) throw new Error(`Out-of-bounds text: ${value}`);
  textCount++;
  s.addText(value, { x, y, w, h, fontFace: 'Arial', fontSize: 25, color: C.ink, margin: 0, valign: 'mid', breakLine: false, ...opt });
}
function box(s, x, y, w, h, fill = C.white, stroke = C.border, type = st.rect) {
  s.addShape(type, { x, y, w, h, fill: { color: fill }, line: { color: stroke, width: 1 } });
}
function line(s, x1, y1, x2, y2, { arrow = false, dashed = false, color = C.muted } = {}) {
  s.addShape(st.line, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), flipH: x2 < x1, flipV: y2 < y1, line: { color, width: 1.5, ...(arrow && { endArrowType: 'triangle' }), ...(dashed && { dashType: 'dash' }) } });
}
function label(s, v, x, y, w, opt = {}) { text(s, v, x, y, w, .3, { fontSize: 13, bold: true, color: C.muted, charSpacing: .7, ...opt }); }
function callout(s, v) {
  box(s, .65, 6.25, 12.03, .52, C.accent, C.accent);
  text(s, v, .85, 6.32, 11.63, .36, { fontSize: 18, color: C.accentInk });
}
function card(s, x, y, w, h, heading, body, size = 25) {
  box(s, x, y, w, h);
  label(s, heading, x + .23, y + .2, w - .46, { color: C.accentInk });
  text(s, body, x + .23, y + .72, w - .46, h - .95, { fontSize: size, valign: 'top' });
}
function node(s, v, x, y, w, h, opt = {}) {
  box(s, x, y, w, h, C.accent);
  text(s, v, x + .12, y + .08, w - .24, h - .16, { fontSize: 22, bold: true, align: 'center', ...opt });
}
function imageFit(s, bytes, x, y, w, h, altText) {
  const aspect = bytes.readUInt32BE(16) / bytes.readUInt32BE(20);
  const iw = Math.min(w, h * aspect), ih = iw / aspect;
  s.addImage({ data: `image/png;base64,${bytes.toString('base64')}`, x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih, altText });
}
function notes(meta) {
  return [
    `PRESENTER: ${meta.speaker}`,
    `TIMING: ${time(meta.seconds)} including transition. Session ${time(elapsed)}–${time(elapsed + meta.seconds)}.`,
    ...(meta.actions ? ['DEMO / STAGE CUES:\n' + meta.actions.map((a, i) => `${i + 1}. ${a}`).join('\n')] : []),
    'SAY:\n' + meta.script,
    ...(meta.answer ? ['OPTIONAL Q&A:\n' + meta.answer] : []),
    'TRANSITION:\n' + (meta.transition || 'Continue to the next slide.'),
    ...(meta.evidence ? ['REFERENCE (do not read aloud):\n' + meta.evidence] : []),
  ].join('\n\n');
}
function base(meta, index) {
  const s = pptx.addSlide();
  s.background = { color: C.background };
  box(s, 0, 0, W, .12, C.primary, C.primary);
  label(s, meta.section.toUpperCase(), .65, .4, 11.9, { color: C.accentInk });
  text(s, meta.title, .65, .98, 12.03, .72, { fontSize: 35, bold: true, color: C.ink });
  line(s, .65, 7.04, 12.68, 7.04, { color: C.border });
  label(s, 'PRICE TRACKER  /  COP 4331C  /  FALL 2026', .65, 7.13, 7, { fontSize: 10 });
  label(s, `${String(index + 1).padStart(2, '0')}  /  ${meta.speaker}  /  ${time(meta.seconds)}`, 8.1, 7.13, 4.58, { fontSize: 10, align: 'right' });
  s.addNotes(notes(meta));
  return s;
}
function actor(s, name, x, y, w = 1.65) {
  s.addShape(st.ellipse, { x: x + w / 2 - .15, y, w: .3, h: .3, fill: { color: C.background }, line: { color: C.ink, width: 1.7 } });
  line(s, x + w / 2, y + .3, x + w / 2, y + .85);
  line(s, x + .25, y + .5, x + w - .25, y + .5);
  line(s, x + w / 2, y + .85, x + .35, y + 1.12);
  line(s, x + w / 2, y + .85, x + w - .35, y + 1.12);
  text(s, name, x - .2, y + 1.2, w + .4, .55, { fontSize: 20, bold: true, align: 'center' });
}
function umlClass(s, name, members, x, y, w, h) {
  box(s, x, y, w, h);
  box(s, x, y, w, .6, C.accent);
  text(s, name, x + .1, y + .08, w - .2, .44, { fontSize: name === 'NotificationDelivery' ? 17 : 20, bold: true, align: 'center' });
  text(s, members, x + .18, y + .75, w - .36, h - .88, { fontSize: 19, valign: 'top' });
}

for (const [index, meta] of slides.entries()) {
  const s = base(meta, index);
  if (meta.diagram) {
    imageFit(s, readFileSync(resolve(diagramDir, `${meta.diagram}.png`)), .3, 1.85, 12.73, 5.05, `Complete PlantUML ${meta.title}`);
    elapsed += meta.seconds;
    continue;
  }
  switch (meta.id) {
    case 'title':
      box(s, 0, .12, W, 6.91, C.background, C.background);
      label(s, 'PRICE TRACKER', .8, .65, 11.7, { fontSize: 17, color: C.accentInk });
      text(s, 'Your game.\nYour price.', .8, 1.65, 10.4, 2.2, { fontSize: 64, bold: true, color: C.ink });
      text(s, 'A private Steam watchlist with target-price alerts.', .85, 4.35, 11.6, .8, { fontSize: 28, color: C.ink });
      label(s, 'INDIVIDUAL STEAM APP  /  TYPE: GAME  /  EXACT US · USD OFFER', .85, 5.65, 11.6, { fontSize: 16, color: C.accentInk });
      text(s, 'Steam’s game-type check cannot distinguish every special edition.', .85, 6.12, 11.6, .35, { fontSize: 15, color: C.muted });
      break;
    case 'team':
      [['Alex', 'Lead, integration & Flutter'], ['Martin', 'React web app & interface'], ['Ibrahim', 'MongoDB, infrastructure & tests'], ['James', 'Authentication & shared API'], ['Nick', 'Game matching & notification adapters']].forEach(([name, role], i) => {
        const y = 1.95 + i * .89;
        box(s, .65, y, 12.03, .75);
        text(s, name, .9, y + .12, 2.2, .5, { fontSize: 26, bold: true, color: C.accentInk });
        text(s, role, 3.15, y + .12, 9.2, .5, { fontSize: 25 });
      });
      break;
    case 'technology':
      card(s, .65, 2.05, 3.5, 2.3, 'CLIENTS', 'React + Tailwind\nTypeScript\nFlutter / Android');
      card(s, 4.9, 2.05, 3.5, 2.3, 'SHARED API', 'Express · Node.js\nTypeScript');
      card(s, 9.15, 2.05, 3.53, 2.3, 'DATABASE', 'MongoDB\nMongoose');
      line(s, 4.2, 3.15, 4.83, 3.15, { arrow: true, color: C.accentInk });
      line(s, 8.46, 3.15, 9.08, 3.15, { arrow: true, color: C.accentInk });
      text(s, 'CheapShark → Steam offers     |     Resend + Firebase → alerts', .8, 4.8, 11.8, .7, { fontSize: 24 });
      callout(s, 'Tools: GitHub + Actions  •  OpenAPI / SwaggerHub publication pending');
      break;
    case 'wireframes':
      for (const [i, name] of ['07-watchlist.svg', '08-add-tracker.svg'].entries()) {
        const png = new Resvg(readFileSync(resolve(here, '../wireframes', name)), { fitTo: { mode: 'width', value: 1600 } }).render().asPng();
        box(s, .65 + i * 6.15, 2.05, 5.88, 3.85);
        imageFit(s, png, .75 + i * 6.15, 2.15, 5.68, 3.35, 'Early web wireframe: ' + (i ? 'add game' : 'watchlist'));
        label(s, i ? '02 / ADD GAME' : '01 / WATCHLIST', .9 + i * 6.15, 5.55, 5.1, { fontSize: 16, color: C.accentInk });
      }
      callout(s, 'Early web planning artifacts; sketch prices are illustrative.');
      break;
    case 'gantt': {
      const gx = 4.05, day = 8.25 / 21;
      ['OCT 26', 'OCT 31', 'NOV 5', 'NOV 10', 'NOV 15'].forEach((d, i) => label(s, d, gx + i * 5 * day - .35, 2, 1.15, { align: 'center', fontSize: 14 }));
      for (let i = 0; i <= 20; i += 5) line(s, gx + i * day, 2.5, gx + i * day, 5.6, { dashed: true, color: C.border });
      [['Foundations', 0, 4], ['Tracking & alerts', 5, 11], ['Test & freeze', 12, 15], ['Presentation', 16, 20]].forEach(([name, start, end], i) => {
        const y = 2.7 + i * .75;
        text(s, name, .8, y, 3.15, .45, { fontSize: 22, bold: true });
        box(s, gx + start * day, y, (end - start + 1) * day, .45, i % 2 ? C.accentInk : C.primary, i % 2 ? C.accentInk : C.primary);
      });
      callout(s, 'Original planned dates, Oct 26–Nov 15; detailed tasks follow.');
      break;
    }
    case 'use-case':
      box(s, 3.1, 1.95, 6.8, 4.2);
      label(s, 'PRICE TRACKER / SHARED API', 3.35, 2.1, 6.25, { color: C.accentInk });
      actor(s, 'Verified user', .75, 3);
      actor(s, 'Admin', 10.65, 3);
      [['Preview Steam offer', 2.6], ['Manage own watchlist', 3.65], ['Set target & preferences', 4.7]].forEach(([v, y]) => {
        box(s, 3.85, y, 5.3, .8, C.accent, C.accentInk, st.ellipse);
        text(s, v, 4, y + .15, 5, .5, { fontSize: 22, align: 'center' });
        line(s, 2.45, 3.5, 3.85, y + .4);
      });
      line(s, 11.48, 4.75, 11.48, 5.89);
      line(s, 11.48, 5.89, 9.3, 5.89);
      box(s, 6.65, 5.65, 2.65, .48, C.accent, C.accentInk, st.ellipse);
      text(s, 'Manual check', 6.8, 5.72, 2.35, .3, { fontSize: 18, align: 'center' });
      callout(s, 'Core use cases; the next slide includes authentication and external actors.');
      break;
    case 'erd': {
      const entity = (name, body, x, y) => umlClass(s, name, body, x, y, 3.2, 1.5);
      entity('User', '_id · verified account', .7, 2.2);
      entity('TrackedItem', 'userId · productId\ntargetPriceMinor', 5.05, 2.2);
      entity('Product', 'store · provider IDs\ncurrentPriceMinor', 9.4, 2.2);
      line(s, 3.9, 2.95, 5.05, 2.95); label(s, '1', 3.95, 2.52, .35); label(s, '0..*', 4.55, 2.52, .5);
      line(s, 8.25, 2.95, 9.4, 2.95); label(s, '0..*', 8.3, 2.52, .6); label(s, '1', 9, 2.52, .35);
      entity('NotificationDelivery', 'episodeId · channel', 5.05, 4.6);
      entity('PriceHistory', 'priceMinor · observedAt', 9.4, 4.6);
      line(s, 6.65, 3.7, 6.65, 4.6); label(s, '1 → 0..*', 6.85, 4, 1.5);
      line(s, 11, 3.7, 11, 4.6); label(s, '1 → 0..*', 11.2, 4, 1.4);
      text(s, 'Private ownership', .85, 4.55, 3.6, .55, { fontSize: 24, bold: true, color: C.accentInk });
      text(s, 'Shared Steam offer', .85, 5.15, 3.6, .55, { fontSize: 24, color: C.secondaryInk });
      callout(s, 'Core ERD excerpt  •  USD amounts use integer cents.');
      break;
    }
    case 'mobile-class':
      umlClass(s, 'WatchlistScreen', 'Watchlist interface', .7, 2.3, 3.3, 1.65);
      umlClass(s, 'HttpTrackerRepository', '+ list()\n+ create() / update()', 4.7, 2.3, 4.05, 1.65);
      umlClass(s, 'MobileApi', '+ list()\n+ login()', 9.45, 3.25, 3.15, 1.65);
      umlClass(s, 'LiveAuthScreen', 'Account interface', .7, 4.55, 3.3, 1.4);
      umlClass(s, 'SessionController', '+ login() / logout()', 4.7, 4.55, 4.05, 1.4);
      line(s, 4, 3.1, 4.7, 3.1, { arrow: true, dashed: true });
      line(s, 4, 5.25, 4.7, 5.25, { arrow: true, dashed: true });
      line(s, 8.75, 3.1, 9.45, 3.8, { arrow: true, dashed: true });
      line(s, 8.75, 5.25, 9.45, 4.4, { arrow: true, dashed: true });
      callout(s, 'Core dependencies; the next slide includes secure storage and push classes.');
      break;
    case 'sequence': {
      const xs = [1.85, 5, 8.15, 11.3];
      ['Check worker', 'CheapShark', 'Database', 'Delivery worker'].forEach((v, i) => {
        node(s, v, xs[i] - 1.15, 2.05, 2.3, .65, { fontSize: 19 });
        line(s, xs[i], 2.7, xs[i], 5.95, { dashed: true, color: C.border });
      });
      const message = (a, b, y, title, dashed = false) => {
        line(s, xs[a], y, xs[b], y, { arrow: true, dashed, color: C.accentInk });
        text(s, title, Math.min(xs[a], xs[b]) + .1, y - .42, Math.abs(xs[b] - xs[a]) - .2, .35, { fontSize: 18, align: 'center' });
      };
      message(0, 1, 3.25, 'Fetch Steam offer');
      message(1, 0, 3.95, 'Valid USD price', true);
      message(0, 2, 4.65, 'Save observation + episode deliveries');
      message(3, 2, 5.4, 'Claim delivery');
      text(s, 'Then send to email / push', 8.55, 5.65, 4, .4, { fontSize: 18, color: C.secondaryInk, align: 'right' });
      callout(s, 'Sequence excerpt  •  Delivery polls independently; failures preserve the last price.');
      break;
    }
    case 'tests':
      card(s, .65, 2.05, 5.87, 2.35, 'NODE / RECORDED NOV 11', '735 passing tests\nZero skips', 32);
      card(s, 6.8, 2.05, 5.88, 2.35, 'FLUTTER / RECORDED NOV 11', '239 passing tests\nAnalysis + format passed', 30);
      text(s, 'Unit + API integration: auth, ownership, tracking, delivery', .8, 4.72, 11.85, .5, { fontSize: 24 });
      text(s, 'Manual integration: local web / Android checks', .8, 5.35, 11.85, .5, { fontSize: 24 });
      callout(s, 'Full hosted mailbox and qualifying-alert acceptance remain open.');
      break;
    case 'api-demo':
      label(s, '01 / EXECUTE', .8, 2.05, 11.8, { color: C.accentInk, fontSize: 16 });
      box(s, .65, 2.6, 12.03, 1.1, C.ink, C.ink);
      text(s, 'GET /api/tracked-items?q=por&limit=20', .9, 2.88, 11.5, .5, { fontSize: 28, color: C.white });
      card(s, .65, 4.2, 5.87, 1.65, '02 / SHOW', 'Partial title match', 26);
      card(s, 6.8, 4.2, 5.88, 1.65, '03 / EXPLAIN', 'Only this user’s records', 26);
      callout(s, 'Rehearsal prerequisite: published SwaggerHub + verified live endpoint.');
      break;
    case 'web-demo':
      card(s, .65, 2.1, 3.75, 3.65, '01 / FIND', 'Open the watchlist.\nSearch a saved title.');
      card(s, 4.8, 2.1, 3.75, 3.65, '02 / ADD', 'Preview a Steam URL.\nSet a target.');
      card(s, 8.95, 2.1, 3.73, 3.65, '03 / EDIT', 'Save preferences.\nChange the target.');
      callout(s, 'Use the hosted API-mode app and a privately signed-in verified account.');
      break;
    case 'android-demo':
      card(s, .65, 2.1, 3.75, 3.65, '01 / RELOAD LIST', 'Open the same\naccount on Android.');
      card(s, 4.8, 2.1, 3.75, 3.65, '02 / COMPARE', 'Show the tracker\njust edited on web.');
      card(s, 8.95, 2.1, 3.73, 3.65, '03 / EXPLAIN', 'Review details and\nalert preferences.');
      callout(s, 'Target edit changes the threshold; a successful check is needed. No sale is implied.');
      break;
    case 'lessons':
      card(s, .65, 2.05, 5.87, 3.7, 'WENT WELL', 'One API for both clients\nRepeatable fixture tests\nCross-client privacy checks', 26);
      card(s, 6.8, 2.05, 5.88, 3.7, 'DID NOT GO WELL', 'Scope changed mid-project\nProvider limits and matching\nAndroid lifecycle races', 26);
      callout(s, 'Next lesson: schedule live integration evidence earlier.');
      break;
    case 'questions':
      text(s, 'Design. Testing. Demo.', .8, 2.65, 11.8, .95, { fontSize: 42, bold: true, color: C.accentInk });
      text(s, 'A Steam watchlist shared across web and Android.', .85, 4.1, 11.6, .7, { fontSize: 28 });
      text(s, 'github.com/aluciencozy/price-tracker', .85, 5.55, 11.6, .45, { fontSize: 22, color: C.muted, hyperlink: { url: 'https://github.com/aluciencozy/price-tracker' } });
      break;
    default: throw new Error(`No renderer for ${meta.id}`);
  }
  elapsed += meta.seconds;
}
await pptx.writeFile({ fileName: resolve(here, 'price-tracker.pptx') });

const table = slides.map((s, i) => `| ${i + 1} | ${s.title} | ${s.speaker} | ${time(s.seconds)} |`).join('\n');
const number = id => slides.findIndex(s => s.id === id) + 1;
const rubric = [['Title / purpose', number('title')], ['Team and contributions', number('team')], ['Technology and tools', number('technology')], ['Prototypes / wireframes', number('wireframes') + ': early web designs'], ['Gantt', number('gantt') + '–' + number('gantt-detail')], ['Use case', number('use-case') + '–' + number('use-case-detail')], ['ERD', number('erd') + '–' + number('erd-detail')], ['Mobile class', number('mobile-class') + '–' + number('mobile-class-detail')], ['Sequence or activity', number('sequence') + '–' + number('sequence-detail')], ['Unit and integration results', number('tests')], ['API demonstration', number('api-demo')], ['Web and Android demonstration', number('web-demo') + '–' + number('android-demo')], ['Things that went well / poorly', number('lessons')], ['Questions', number('questions')]].map(([r, s]) => `| ${r} | ${s} |`).join('\n');
let guide = `# Presenter guide

Generated by \`node docs/presentation/build.mjs\` from \`speaker-notes.mjs\`. Edit that source and rebuild to keep this guide and PowerPoint synchronized.

## How to use the notes

In PowerPoint, expand the **Notes** pane under each slide or open **View → Notes Page**. Use **Presenter View** to see scripts privately while projecting. Every slide has a presenter, script, and transition; demos also have timed actions. Complete diagrams follow their overviews in the main presentation. Stage cues and references are not narration. The PDF contains slides only; carry this guide for scripts outside PowerPoint.

## Timing and roles

Slides 1–20 total **11:00**, including diagram details, transitions, and demos. Slide 21 reserves **1:00** for questions: **12:00 total**. Questions is the final slide. Each member has substantive sections. These are allocations, not a measured rehearsal; practice with a stopwatch.

| Slide | Topic | Presenter | Time |
| --- | --- | --- | --- |
${table}

## Evidence and demo readiness

The [November 11 report](../test-results/production-resume-2026-11-11.md) records 735 Node tests (17 contract, 11 deployment/runner, 421 API, 286 web; zero skips), 239 Flutter tests, and HTTPS/database readiness. This refresh does not rerun those suites or establish full hosted acceptance. The active VM timer is hourly, replacing the earlier in-process daily scheduler. Inspected runs skipped products without observations; a running timer does not prove successful price checks.

The team domain configured in current mobile documentation is **https://largeproject.cop4331cfall26jo.com**. Recheck before rehearsal. SwaggerHub publication and functional live demonstration remain pending in repository evidence; do not invent its URL. Readiness does not prove real mailbox verification/reset, two-user authenticated flows, or qualifying durable email/push delivery. These remain separate gates. Use the full alert flow only after team/source-owner approval of history collection, provider policy, free-service settings, and channel acceptance.

Prepare a verified account, sanitized owned Portal tracker for API search, a second rehearsed supported game for adding, and Android signed into the same account against the live API. Never bypass verification. Demo scripts describe an intended successful run: narrate only successes actually observed. If a step fails, state the outcome and continue within time; do not switch silently to sample data. A recording, local endpoint, or fixture does not replace the required live endpoint. A target edit is not a provider price drop.

## Requirement map

| Requirement | Slide |
| --- | --- |
${rubric}

## Attendance, rehearsal, and submission

- All five members attend and explain assigned work. Missing the presentation without prior approval results in a zero under the supplied requirements.
- Confirm the actual presentation slot and deadline/time zone; do not infer them from the Gantt.
- Rehearse the entire session with live endpoints, Android screen sharing, projector, and stopwatch. Stop at 12 minutes; exceeding 13 minutes incurs five points, plus five per additional minute. Shorten answers or optional demo steps if behind.
- Check the app domain and SwaggerHub on the campus network two days before and again one day before presentation. Contact UCF IT promptly if blocked; allow one or two days for unblocking.
- Bring final PPTX, PDF, this guide, and diagram exports on USB. Open them on the presentation machine before class. Do not rely on Google Drive, Dropbox, or cloud retrieval. Keep credentials off the drive and projected screen.
- Each of the five members individually uploads the final PowerPoint to WebCourses; Alex coordinates the handoff.
- Enter project title, GitHub repository, and verified live domain (hostname, not IP) in the course signup spreadsheet. These are team actions, not completed by rebuilding slides.

## Contribution references

Existing project references are examples, not contribution scores or a new audit of GitHub status.

| Member | Examples |
| --- | --- |
| Alex | [#36: API contract](https://github.com/aluciencozy/price-tracker/pull/36), [#38: Flutter wiring](https://github.com/aluciencozy/price-tracker/pull/38) |
| Martin | [#34: React UI, tests, wireframes](https://github.com/aluciencozy/price-tracker/pull/34) |
| Ibrahim | [#42: MongoDB](https://github.com/aluciencozy/price-tracker/pull/42), [#45: episodes/outbox](https://github.com/aluciencozy/price-tracker/pull/45) |
| James | [#50: authentication](https://github.com/aluciencozy/price-tracker/pull/50) |
| Nick | [#41: provider adapter](https://github.com/aluciencozy/price-tracker/pull/41), [#49: email adapter](https://github.com/aluciencozy/price-tracker/pull/49) |

## Slide-by-slide scripts

`;
elapsed = 0;
for (const [i, meta] of slides.entries()) {
  guide += `### ${i + 1}. ${meta.title}\n\n${notes(meta)}\n\n`;
  elapsed += meta.seconds;
}
writeFileSync(resolve(here, 'presenter-guide.md'), guide.trimEnd() + '\n');
console.log(`Wrote 21 slides with notes; 11:00 content + 1:00 questions = ${time(totalSeconds)}. Presenter guide synchronized.`);
console.log(`Validated ${textCount} text boxes within slide boundaries. Render PPTX to check visual fit.`);
