import pptxgen from './tools/node_modules/pptxgenjs/dist/pptxgen.cjs.js';
import { Resvg } from './tools/node_modules/@resvg/resvg-js/index.js';
import { readFileSync, existsSync } from 'node:fs';
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
const H = 7.5;
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
function node(s, x, y, w, h, text, color = C.white) {
  rect(s, x, y, w, h, color, C.line, true);
  txt(s, text, x + .12, y + .12, w - .24, h - .24, { fontSize: 20, bold: true, align: 'center', valign: 'mid', color: C.ink });
}
function arrow(s, x, y, text = '→') {
  txt(s, text, x, y, .6, .45, { fontSize: 27, bold: true, color: C.teal, align: 'center' });
}
function connect(s, x1, y1, x2, y2) {
  s.addShape(pptx.ShapeType.line, { x: Math.min(x1,x2), y: Math.min(y1,y2), w: Math.abs(x2-x1), h: Math.abs(y2-y1), flipV: y2 < y1, line: { color: C.teal, width: 1.6, endArrowType: 'triangle' } });
}
function summary(s) {
  txt(s, 'PRESENTATION SUMMARY  ·  FULL PLANTUML DIAGRAM IN APPENDIX', .78, 6.65, 11.8, .22, { fontSize: 11, bold: true, color: C.muted });
}
function appendix(name, title) {
  const s = pptx.addSlide();
  s.background = { color: C.white };
  txt(s, `APPENDIX  /  ${title}`, .3, .16, 12.7, .3, { fontSize: 17, bold: true, color: C.navy });
  const path = resolve(diagramDir, `${name}.png`);
  s.addImage({ path, altText: `Complete PlantUML ${title} diagram`, ...containPng(readFileSync(path), .15, .52, 13.03, 6.78) });
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
 const s=slide('Five people, one shared product','Team & ownership','Alex',40,'Introduce the five meaningful areas of work, not a claim of equal commit counts. Verified merged author PRs: Alex: https://github.com/aluciencozy/price-tracker/pull/36 shared API contract and https://github.com/aluciencozy/price-tracker/pull/38 Flutter API wiring; Martin: https://github.com/aluciencozy/price-tracker/pull/34 React UI/tests and 12 web wireframes; Ibrahim: https://github.com/aluciencozy/price-tracker/pull/42 MongoDB schemas/indexes and ERD, and https://github.com/aluciencozy/price-tracker/pull/45 durable episodes/outbox; James: https://github.com/aluciencozy/price-tracker/pull/50 registration/email verification and transaction/concurrency tests; Nick: https://github.com/aluciencozy/price-tracker/pull/41 CheapShark adapter and https://github.com/aluciencozy/price-tracker/pull/49 email adapter. The email adapter PR is not proof of live email delivery. Alex requested changes and later approved PR #50. Martin approved an earlier commit of PR #61, not necessarily its current head. Each person explains their own area.');
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
 const s=slide('Two clients, one source of truth','System architecture','James',35,'The React TypeScript web app uses asynchronous HTTP requests (AJAX) to the shared Express/Node TypeScript API; Flutter uses the same API. MongoDB holds accounts, trackers and durable delivery state. The API alone talks to CheapShark and notification adapters. GitHub supports project collaboration; the scheduler must run independently of clients in deployment.');
 card(s,.75,1.9,3.35,1.95,'CLIENTS','React + TypeScript\n+ Tailwind\nFlutter / Android');
 card(s,5,1.9,3.35,1.95,'SHARED API','Express + Node.js\nTypeScript');
 card(s,9.25,1.9,3.35,1.95,'PERSISTENCE','MongoDB / Mongoose\nowned data');
 txt(s,'→',4.25,2.48,.5,.5,{fontSize:28,color:C.teal}); txt(s,'→',8.5,2.48,.5,.5,{fontSize:28,color:C.teal});
 txt(s,'ASYNC HTTP / AJAX',4.12,3.12,.82,.42,{fontSize:8,bold:true,color:C.teal,align:'center'});
 card(s,2.9,4.25,3.55,1.5,'PRICE SOURCE','CheapShark · Steam');
 card(s,6.9,4.25,3.55,1.5,'DELIVERY','Email + Android push');
}
{
 const s=slide('From early wireframes to the product','Prototype evidence','Martin',25,'These are existing early web wireframes, not screenshots of the current app. They show the watchlist and add flow. The live web and Android walkthrough follows later; no fictional mobile prototype is represented here.');
 for (const [i,name] of ['07-watchlist.svg','08-add-tracker.svg'].entries()) {
   const svg=readFileSync(resolve(here,'../wireframes',name));
   const png=new Resvg(svg,{fitTo:{mode:'width',value:1400}}).render().asPng();
   s.addImage({data:`image/png;base64,${png.toString('base64')}`,altText:i?'Early web add tracker wireframe, illustrative values':'Early web watchlist wireframe, illustrative values',...containPng(png,.8+i*6.05,1.75,5.65,3.9)});
   txt(s,i?'EARLY WIREFRAME  /  ADD':'EARLY WIREFRAME  /  WATCHLIST',.8+i*6.05,5.9,5.65,.3,{fontSize:14,bold:true,color:C.teal});
 }
 txt(s,'Sketch prices are illustrative, not live quotes.',.8,6.45,11.7,.25,{fontSize:14,color:C.muted});
}
{
 const s=slide('The planned path to delivery','Schedule · planned, not actual','Ibrahim',25,'This summary of the October 26 to November 15 plan is not a claim that milestones completed. Foundations, tracking, test/freeze and presentation preparation overlap. Hosted acceptance remains open. The complete Gantt is in the appendix.');
 const stages=[['OCT 26–30','Foundations'],['OCT 31–NOV 6','Tracking & alerts'],['NOV 7–10','Test & freeze'],['NOV 11–15','Presentation']];
 stages.forEach(([date,label],i)=>{let x=.75+i*3.17; node(s,x,2.3,2.75,1.65,label,i%2?C.white:C.mint); txt(s,date,x,4.18,2.75,.4,{fontSize:17,bold:true,align:'center',color:C.teal}); if(i<3)arrow(s,x+2.78,2.9);});
 txt(s,'Planned milestones  ·  dates are not completion claims',.85,5.55,11.6,.4,{fontSize:20,color:C.muted}); summary(s);
}
{
 const s=slide('Shared offers, private tracking','Data model · ERD summary','Ibrahim',40,'A tracked item belongs to one user and references a shared product. Multiple trackers can reference the same product. Successful observations belong to the product. Targets and prices use integer cents. The complete ERD is in the appendix.');
 node(s,.75,2.1,2.4,1.2,'User'); node(s,4.05,2.1,2.65,1.2,'TrackedItem',C.mint); node(s,7.6,2.1,2.4,1.2,'Product'); node(s,10.55,4.15,2.05,1.2,'History');
 arrow(s,3.3,2.48); arrow(s,6.85,2.48); connect(s,9.4,3.3,10.55,4.15);
 txt(s,'owns',3.19,3.55,1,.35,{fontSize:18,color:C.teal}); txt(s,'references',6.75,3.55,1.35,.35,{fontSize:18,color:C.teal});
 txt(s,'PRIVATE target',4.12,4.2,2.7,.35,{fontSize:19,bold:true,color:C.teal}); txt(s,'SHARED offer',7.68,4.2,2.6,.35,{fontSize:19,bold:true,color:C.teal});
 txt(s,'USD amounts are integer cents.',.85,5.75,9,.4,{fontSize:20,color:C.muted}); summary(s);
}
{
 const s=slide('What users and administrators can do','Use-case summary','Martin',25,'A verified user manages a private watchlist and preferences. The admin can initiate a manual price check; ordinary users cannot trigger unrestricted upstream checks. Full use-case relationships appear in the appendix.');
 node(s,.8,2.2,2.3,1.15,'Verified user',C.mint); node(s,4.35,1.7,3.45,1,'Manage watchlist'); node(s,4.35,3.05,3.45,1,'Set preferences');
 connect(s,3.1,2.65,4.35,2.2); connect(s,3.1,2.85,4.35,3.55); node(s,8.8,4.5,2.8,1,'Admin check'); node(s,.8,4.5,2.3,1,'Admin');
 connect(s,3.1,5,8.8,5); summary(s);
}
{
 const s=slide('A successful check is not a repeat alert','Activity summary','Nick',25,'Fetch the selected Steam offer. If the fetch fails, preserve the previous price and do not rearm. On success, a price above target rearms; at or below target opens an episode only if one is not already open. Complete activity in appendix.');
 node(s,.8,2.6,2.55,1.05,'Fetch offer'); node(s,4.05,2.6,2.4,1.05,'Valid price?',C.mint); arrow(s,3.37,2.88);
 node(s,8.05,1.65,4.0,1,'Failure → preserve last price'); node(s,8.05,3.1,4.0,1,'Above target → rearm'); node(s,8.05,4.55,4.0,1,'At / below → alert once');
 connect(s,6.45,2.8,8.05,2.15); connect(s,6.45,3.12,8.05,3.6); connect(s,6.45,3.45,8.05,5.05); summary(s);
}
{
 const s=slide('From price check to delivery','Sequence summary','Nick',30,'The check worker records a successful observation and evaluates episodes into the durable outbox. Separately, a delivery worker polls on an independent interval, claims an eligible delivery and sends to its channel. A check does not call the dispatcher. Unknown outcomes require reconciliation. Full sequence in appendix.');
 node(s,.8,1.85,2.85,1.05,'Check worker'); node(s,5.15,1.85,3.05,1.05,'Observation +\noutbox',C.mint); arrow(s,3.83,2.12);
 txt(s,'successful check',3.48,3.08,2,.35,{fontSize:17,color:C.teal});
 node(s,.8,4.3,2.85,1.05,'Delivery worker'); node(s,5.15,4.3,3.05,1.05,'Claim delivery',C.mint); node(s,9.5,4.3,2.85,1.05,'Email / push');
 arrow(s,3.83,4.58); arrow(s,8.53,4.58); txt(s,'independent poll',.88,5.55,3,.35,{fontSize:18,color:C.teal}); summary(s);
}
{
 const s=slide('Mobile separates screens from data','Flutter class summary','Alex',25,'WatchlistScreen uses HttpTrackerRepository, which calls MobileApi. LiveAuthScreen uses SessionController, which calls MobileApi. PushRegistration uses HttpDeviceEndpoint for device registration and cleanup. Logout and permission cleanup differ; the complete mobile class diagram and notes are in the appendix.');
 node(s,.7,1.7,3.5,1,'WatchlistScreen'); node(s,4.88,1.7,3.75,1,'HttpTrackerRepository',C.mint); node(s,9.5,2.85,2.8,1,'MobileApi');
 node(s,.7,4.05,3.5,1,'LiveAuthScreen'); node(s,4.88,4.05,3.75,1,'SessionController',C.mint);
 arrow(s,4.22,1.98); arrow(s,4.22,4.33); connect(s,8.63,2.2,9.5,3.35); connect(s,8.63,4.55,9.5,3.35);
 txt(s,'PushRegistration → HttpDeviceEndpoint  ·  device cleanup',1.2,5.75,11,.42,{fontSize:19,bold:true,color:C.teal,align:'center'}); summary(s);
}
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
 const s=slide('Live API: search a private watchlist','SwaggerHub demo  /  configure URL before presenting','James',60,'CONFIGURE the published SwaggerHub URL and verified HTTPS API domain before rehearsal. Before projection, privately sign in with a verified test account and authorize SwaggerHub; do not project the login, returned token, authorization controls, request headers or generated curl. Onscreen demonstrate only GET /api/tracked-items?q=por&limit=20, showing the query and a sanitized owned response. Explain that search is server-side, partial and ownership-scoped. Clear authorization privately afterward. Verify this endpoint live before rehearsal. If unavailable, state the demo is blocked; a recording or local endpoint does not fulfill the requirement.');
 card(s,.8,1.9,5.7,2.65,'GET  /api/tracked-items','?q=por&limit=20\nServer-side partial title match');
 card(s,6.8,1.9,5.7,2.65,'PRIVATE BY DESIGN','Authorize offscreen\nShow sanitized owned results');
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
appendix('gantt', 'Planned Gantt');
appendix('erd', 'Entity relationship');
appendix('use-case', 'Use case');
appendix('activity', 'Activity');
appendix('sequence', 'Sequence');
appendix('mobile-class', 'Mobile class');
await pptx.writeFile({ fileName: resolve(here,'price-tracker.pptx') });
console.log(`Wrote ${page} narrated slides + 6 untimed appendix slides; content 11:10, questions 0:50; total 12:00.`);
