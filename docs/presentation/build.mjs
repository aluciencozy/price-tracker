import pptxgen from './tools/node_modules/pptxgenjs/dist/pptxgen.cjs.js';
import { Resvg } from './tools/node_modules/@resvg/resvg-js/index.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const diagramDir = resolve(process.env.DIAGRAMS_DIR || resolve(here, '../diagrams/presentation'));
const diagrams = ['gantt', 'erd', 'use-case', 'activity', 'sequence', 'mobile-class'];
const missing = diagrams.filter(name => !existsSync(resolve(diagramDir, `${name}.png`)));
if (missing.length) throw new Error(`Missing real diagram assets in ${diagramDir}: ${missing.join(', ')}`);
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Price Tracker team';
pptx.subject = 'COP 4331C project presentation';
pptx.title = 'Price Tracker';
pptx.lang = 'en-US';
pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'en-US' };
const C = { navy: '102B35', ink: '17343B', teal: '147D78', mint: 'D8ECE5', cream: 'F8F7F0', white: 'FFFFFF', muted: '597176', amber: 'B9782E', line: 'D7E2DE' };
const W = 13.333333, H = 7.5;
let page = 0;
const txt = (s, text, x, y, w, h, opt = {}) => s.addText(text, { x, y, w, h, fontFace: 'Aptos', fontSize: 21, color: C.ink, margin: 0, breakLine: false, ...opt });
const rect = (s, x, y, w, h, fill, line = fill, radius = false) => s.addShape(radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, { x, y, w, h, rectRadius: 0.12, line: { color: line, width: 0.8 }, fill: { color: fill }, radius: 0.12 });
function containPng(bytes, x, y, w, h) {
  const aspect = bytes.readUInt32BE(16) / bytes.readUInt32BE(20);
  const width = Math.min(w, h * aspect), height = width / aspect;
  return { x: x + (w - width) / 2, y: y + (h - height) / 2, w: width, h: height };
}
function slide(title, kicker, speaker, seconds, notes) {
  const s = pptx.addSlide(); page++;
  s.background = { color: C.cream };
  rect(s, 0, 0, 0.13, H, C.teal);
  txt(s, kicker.toUpperCase(), 0.65, 0.32, 11.9, 0.22, { fontSize: 10, bold: true, charSpacing: 1.5, color: C.teal });
  txt(s, title, 0.65, 0.72, 12, 0.66, { fontSize: 34, bold: true, color: C.navy });
  rect(s, 0.65, 7.07, 12.0, 0.012, C.line);
  txt(s, 'PRICE TRACKER  /  COP 4331C', 0.65, 7.16, 6, 0.16, { fontSize: 9, color: C.muted });
  txt(s, `${String(page).padStart(2, '0')}   ·   ${speaker}   ·   ${seconds}s`, 9.1, 7.16, 3.55, 0.16, { align: 'right', fontSize: 9, color: C.muted });
  s.addNotes(`${speaker} — ${seconds} seconds. ${notes}`);
  return s;
}
function card(s, x, y, w, h, label, body, fill = C.white) {
  rect(s, x, y, w, h, fill, C.line, true);
  txt(s, label, x + .22, y + .2, w - .44, .32, { fontSize: 17, bold: true, color: C.teal });
  txt(s, body, x + .22, y + .7, w - .44, h - .86, { fontSize: 19, valign: 'top', breakLine: false });
}
function diagram(title, kicker, name, speaker, sec, notes, caption) {
  const s = slide(title, kicker, speaker, sec, notes);
  rect(s, .65, 1.55, 12, 4.82, C.white, C.line, true);
  const path = resolve(diagramDir, `${name}.png`);
  s.addImage({ path, ...containPng(readFileSync(path), .82, 1.68, 11.66, 4.52) });
  txt(s, caption, .78, 6.55, 11.8, .3, { fontSize: 15, color: C.muted });
}

{
 const s=slide('Know when your game hits your price', 'Price Tracker  /  Fall 2026', 'Alex',35,'Open with the problem: players repeatedly check prices or miss a target. Price Tracker tracks a supported Steam base game and alerts when its selected Steam offer meets the user’s target. State that hosted demonstration is pending as of November 9.');
 txt(s,'A shared watchlist for Steam games,\nwith target-price alerts.',.8,1.9,8.4,1.3,{fontSize:30,color:C.ink,breakLine:false});
 rect(s,.8,4.25,7.5,.65,C.mint,C.mint,true);
 txt(s,'REAL PRICES  /  PRIVATE WATCHLIST  /  WEB + ANDROID',1.05,4.47,7,.2,{fontSize:13,bold:true,color:C.teal});
 txt(s,'Status · 09 Nov 2026',.8,5.45,3.2,.3,{fontSize:15,bold:true,color:C.muted});
 txt(s,'Local integration verified; hosted demo pending.',.8,5.85,9,.35,{fontSize:18,color:C.muted});
}
{
 const s=slide('Five people, one shared product','Team & ownership','Alex',40,'Introduce the five meaningful areas of work, not a claim of equal commit counts. GitHub issues and pull requests organize work. Each person explains their own area in this presentation.');
 const rows=[['Alex','Lead, integration & Flutter  ·  @aluciencozy'],['Martin','React, TypeScript & Tailwind  ·  @Martaino'],['Ibrahim','MongoDB, infrastructure & tests  ·  @IbrahimShaqqou'],['James','Express authentication & API  ·  @MageOfLight'],['Nick','CheapShark matching & email adapters  ·  @NickTheBrick04']];
 rows.forEach(([a,b],i)=>{ const y=1.65+i*.91; rect(s,.75,y,11.8,.72,C.white,C.line,true); txt(s,a,1,y+.19,2,.3,{fontSize:21,bold:true,color:C.teal}); txt(s,b,3.2,y+.19,8.7,.3,{fontSize:20}); });
}
{
 const s=slide('One specific offer, not any low price','Problem & scope','Nick',40,'The MVP is US/USD individual base games, starting with Steam URLs and CheapShark. We match a Steam app to a CheapShark game and select the Steam store offer. A missing match or offer is unsupported, not another store’s price.');
 card(s,.75,1.85,3.75,3.65,'01  IDENTIFY','Parse a supported Steam app URL locally.');
 card(s,4.8,1.85,3.75,3.65,'02  COMPARE','Use the exact Steam offer in USD, not the all-store low.');
 card(s,8.85,1.85,3.75,3.65,'03  ALERT','Notify when the user’s target is met; avoid repeats.');
 txt(s,'No DLC, bundles, guessed editions, or physical retailers in the MVP.',.9,6.12,11.7,.35,{fontSize:17,color:C.muted});
}
{
 const s=slide('Two clients, one source of truth','System architecture','James',35,'React and Flutter call the same Express/Node TypeScript API. MongoDB holds accounts, trackers and durable delivery state. The API alone talks to CheapShark and notification adapters. GitHub supports project collaboration; the scheduler must run independently of clients in deployment.');
 card(s,.75,1.9,3.35,1.65,'CLIENTS','React + Tailwind\nFlutter / Android');
 card(s,5,1.9,3.35,1.65,'SHARED API','Express + Node.js\nTypeScript');
 card(s,9.25,1.9,3.35,1.65,'PERSISTENCE','MongoDB / Mongoose\nowned data');
 txt(s,'→',4.25,2.48,.5,.5,{fontSize:28,color:C.teal}); txt(s,'→',8.5,2.48,.5,.5,{fontSize:28,color:C.teal});
 card(s,2.9,4.25,3.55,1.5,'PRICE SOURCE','CheapShark · Steam');
 card(s,6.9,4.25,3.55,1.5,'DELIVERY','Email + Android push');
}
{
 const s=slide('From early wireframes to the product','Prototype evidence','Martin',25,'These are existing early web wireframes, not screenshots of the current app. They show the watchlist and add flow. The live web and Android walkthrough follows later; no fictional mobile prototype is represented here.');
 for (const [i,name] of ['07-watchlist.svg','08-add-tracker.svg'].entries()) {
   const svg=readFileSync(resolve(here,'../wireframes',name));
   const png=new Resvg(svg,{fitTo:{mode:'width',value:1400}}).render().asPng();
   s.addImage({data:`image/png;base64,${png.toString('base64')}`,...containPng(png,.8+i*6.05,1.75,5.65,3.9)});
   txt(s,i?'EARLY WIREFRAME  /  ADD':'EARLY WIREFRAME  /  WATCHLIST',.8+i*6.05,5.9,5.65,.3,{fontSize:14,bold:true,color:C.teal});
 }
 txt(s,'Sketch prices are illustrative, not live quotes.',.8,6.45,11.7,.25,{fontSize:14,color:C.muted});
}
diagram('The planned path to delivery','Schedule · planned, not actual','gantt','Ibrahim',25,'This is the October 26 to November 15 plan from the project schedule, not a claim that all milestones completed. Foundations, tracking, test/freeze and presentation preparation overlap. Hosted acceptance remains open.', 'Planned schedule  ·  Oct 26–Nov 15, 2026');
diagram('Shared offers, private tracking','Data model · ERD','erd','Ibrahim',40,'Explain that a shared game/store offer can be tracked by multiple users, but each tracked item belongs to one user. History records successful observations and notification deliveries are keyed per episode and channel.', 'Shared products; user-owned targets and delivery state');
diagram('What users and administrators can do','Use-case diagram','use-case','Martin',25,'The user manages a private watchlist and notification preferences. The administrator runs a manual check; ordinary users cannot trigger unrestricted upstream checks.', 'The administrator’s manual check is separate from ordinary user actions');
diagram('A successful check is not a repeat alert','Activity diagram','activity','Nick',25,'Walk through the decision, not every box: fetch the selected Steam offer, preserve the last valid observation if the request fails, and evaluate the target only after a successful observation.', 'A failed fetch is not a zero price');
diagram('From price check to delivery','Sequence diagram','sequence','Nick',30,'The check service updates an observation, evaluates the qualifying episode and records channel deliveries before sending. Email and push are independent. Uncertain external outcomes need reconciliation, not a claim of exactly-once delivery.', 'Episode and per-channel records survive retries and restarts');
diagram('Mobile separates screens from data','Flutter class diagram','mobile-class','Alex',25,'The mobile app uses a repository/API boundary rather than connecting to MongoDB or CheapShark directly. Explain the relationship between presentation, repository, session and device notification responsibilities.', 'Flutter uses the same API and ownership rules as web');
{
 const s=slide('Security at the boundaries','Authentication & privacy','James',35,'An unverified user cannot log in. Passwords are strongly hashed; verification and reset tokens are hashed and single-use. Web uses an opaque HttpOnly cookie and CSRF protection. Mobile uses a seven-day JWT backed by a revocable server session. Every private query enforces ownership.');
 card(s,.75,1.8,3.75,3.75,'IDENTITY','Verified email before login; hashed passwords and single-use reset tokens.');
 card(s,4.8,1.8,3.75,3.75,'SESSIONS','Web: HttpOnly cookie + CSRF. Mobile: revocable JWT.');
 card(s,8.85,1.8,3.75,3.75,'OWNERSHIP','Server scopes private resources to the signed-in user.');
}
{
 const s=slide('Tests are evidence, not deployment','Unit & integration results','Ibrahim',40,'At the recorded local validation, npm run check passed 700 tests: 17 contract, 409 API, 274 web, plus lint, typechecks and builds. Flutter had 237 passing tests, format and analyze. Local cross-client and Android device checks add integration evidence, not hosted acceptance. Eight FCM sends were accepted, seven receiver arrivals verified; the last post-permission duplicate arrival remains unverified.');
 card(s,.75,1.75,3.75,2.2,'700  /  NODE','17 contract · 409 API\n274 web');
 card(s,4.8,1.75,3.75,2.2,'237  /  FLUTTER','Format, analysis and tests passed');
 card(s,8.85,1.75,3.75,2.2,'LOCAL QA','Cross-client ownership and Android lifecycle');
 txt(s,'Not a hosted end-to-end or real email acceptance claim.',.85,4.65,11.6,.45,{fontSize:22,bold:true,color:C.ink});
 txt(s,'Recorded validation: Nov 2026  ·  PR #61 open against Staging',.85,5.45,11.6,.35,{fontSize:16,color:C.muted});
}
{
 const s=slide('Live API: authenticate, then search','SwaggerHub demo  /  configure URL before presenting','James',60,'CONFIGURE the published SwaggerHub URL and HTTPS API base before rehearsal. Demonstrate exactly two endpoints: POST /api/auth/mobile/login using a verified test account; enter the password live, never in slides or notes. Copy the returned accessToken into a temporary SwaggerHub Bearer authorization, then GET /api/tracked-items?q=por&limit=20. Show that search is server-side, partial and ownership-scoped. Clear temporary authorization afterward. Verify both endpoints live before rehearsal. If unavailable, state the demo is blocked; a recording or local endpoint does not fulfill the requirement.');
 card(s,.8,1.9,5.7,2.65,'01  POST  /api/auth/mobile/login','Verified account → accessToken\nPassword entered live');
 card(s,6.8,1.9,5.7,2.65,'02  GET  /api/tracked-items','?q=por&limit=20\nBearer token → owned search');
 txt(s,'CONFIGURE: published SwaggerHub URL + HTTPS API domain',.9,5.35,11.6,.45,{fontSize:21,bold:true,color:C.amber});
}
{
 const s=slide('Live web: the watchlist workflow','Hosted app demo  /  configure domain before presenting','Martin',65,'On the approved HTTPS domain, briefly show the landing and login or registration entry, explain verification and reset, and sign in with an already verified test account. Show owned watchlist, server partial search, add or edit a supported game target and preferences, then removal if time permits. Never reveal credentials. Change a target without calling it a price drop. No localhost or fixture demo substitutes for the required hosted application.');
 card(s,.8,1.85,5.7,2.7,'ACCOUNT','Register / verify / reset\nSign in with verified account');
 card(s,6.8,1.85,5.7,2.7,'WATCHLIST','Search · add · edit target\nPreferences · remove');
 txt(s,'CONFIGURE: verified live application domain',.9,5.35,11.6,.45,{fontSize:22,bold:true,color:C.amber});
}
{
 const s=slide('Live Android: the same account and data','Hosted app demo  /  device ready','Alex',60,'On Android connected to the approved HTTPS API, show the same verified account and watchlist, refresh and show the web change, and explain notification preferences. Show real alert delivery only after sender, history, scheduler and push gates have been approved and verified. A changed target is not a price drop. Local Android QA is supplemental evidence, not a substitute for hosted demonstration.');
 card(s,.8,1.85,5.7,2.7,'SHARED STATE','Refresh on Android\nSee the same owned tracker');
 card(s,6.8,1.85,5.7,2.7,'NOTIFICATIONS','Per-game email / push\nReal delivery only when verified');
 txt(s,'CONFIGURE: Android build + approved live API',.9,5.35,11.6,.45,{fontSize:22,bold:true,color:C.amber});
}
{
 const s=slide('What we learned & what remains','Retrospective','Ibrahim',65,'What went well: a shared API and offline fixtures let clients and server integrate and privacy issues were found during cross-client QA. What was difficult: the pivot from physical retailers to games, provider 429 limits, and Android session/permission lifecycle races. Fixes were tested locally. The remaining gates are approved HTTPS deployment, remote database and independent job, SwaggerHub publication, verified sender and real history/alert approval. Ask for questions for 50 seconds after this slide.');
 card(s,.8,1.8,3.75,3.6,'WENT WELL','Shared API + fixtures enabled integration and privacy checks.');
 card(s,4.8,1.8,3.75,3.6,'WAS DIFFICULT','Scope pivot, provider throttling and Android lifecycle races.');
 card(s,8.8,1.8,3.75,3.6,'STILL OPEN','Hosted acceptance, SwaggerHub and real alert gates.');
 txt(s,'Questions  /  50 seconds',.9,6.03,9,.45,{fontSize:24,bold:true,color:C.teal});
}
await pptx.writeFile({ fileName: resolve(here,'price-tracker.pptx') });
console.log(`Wrote ${page} slides; content 11:10, questions 0:50; total 12:00.`);
