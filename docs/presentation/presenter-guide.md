# Presenter guide

## Status and live gates

**As of November 9:** PR #61 is open against Staging. Local tests and Android checks are evidence, not proof of a hosted deployment. This deck is not presentation-ready until the team confirms:

- An approved live HTTPS application and API domain, remote MongoDB, and an independent daily job on approved $0 terms.
- SwaggerHub publication and a working HTTPS API base. Verify both demonstrated endpoints, not just the documentation page.
- A verified test account, Android build configured for the live API, and safe credentials provided privately to the presenters.
- Real sender/domain, published templates and runtime sending key; team/source-owner review of live history collection; and a genuine observation-to-outbox-to-email/push check. Confirm Firebase Spark/billing status with its owner. Until these gates pass, do not show or claim a complete live notification chain.
- Campus access to the domain and SwaggerHub. Check two days before and again one day before; escalate to campus IT 1–2 days ahead if blocked.

Use no localhost, IP address, fixture, or recording as a substitute for the required live hosted app and working endpoint. Dated local provider/Android results may be described as supplemental QA only. Do not claim changing a target caused a sale.

## Timed runbook

Content is **11:10**; reserve **0:50** for questions, total **12:00**. The penalty begins beyond 13 minutes; stop or shorten discussion rather than running over. Times include handoffs and demos.

| Slide | Presenter | Time | Cue |
| --- | --- | --- | --- |
| 1 | Alex | 0:35 | Problem and current status |
| 2 | Alex | 0:40 | Five roles |
| 3 | Nick | 0:40 | Scope and exact Steam offer |
| 4 | James | 0:35 | Shared architecture |
| 5 | Martin | 0:25 | Existing early web wireframes |
| 6 | Ibrahim | 0:25 | Planned Gantt |
| 7 | Ibrahim | 0:40 | ERD and ownership |
| 8 | Martin | 0:25 | Use cases |
| 9 | Nick | 0:25 | Activity |
| 10 | Nick | 0:30 | Sequence |
| 11 | Alex | 0:25 | Mobile classes |
| 12 | James | 0:35 | Security |
| 13 | Ibrahim | 0:40 | Test results and limitations |
| 14 | James | 1:00 | Two live SwaggerHub endpoints |
| 15 | Martin | 1:05 | Hosted web app |
| 16 | Alex | 1:00 | Hosted Android app |
| 17 | Ibrahim | 1:05 | Retrospective and open gates |
| Questions | Whole team | 0:50 | Answer within remaining time |

## Live demo details

1. Open the team's published SwaggerHub documentation. Use **POST `/api/auth/mobile/login`** with an already verified account. Type its password live; never include it in slides or shared examples. The response contains `accessToken`.
2. Temporarily authorize with that Bearer token and run **GET `/api/tracked-items?q=por&limit=20`**. Explain that this is a case-insensitive partial server-side search of the signed-in user's watchlist, not a client-only filter. Clear the authorization afterwards. Both must work in rehearsal; at least one functional endpoint is required in the presentation.
3. Open the live application by its domain, briefly show entry/verification/reset, sign in, and show the watchlist, partial search, supported game, target and preferences; show CRUD as time allows. Do not expose private data.
4. Open the Android app connected to the same approved live API, refresh and show the same owned tracker and notification preferences. Only show real email/push when the gates above have been verified. A target change is not an actual provider price drop.

## Rubric map

| Requirement | Evidence |
| --- | --- |
| Problem, title, team and roles | 1–3 |
| MERN, TypeScript, Tailwind, Flutter, GitHub, JWT/security | 2, 4, 11–12 |
| Prototypes / wireframes | 5: existing early **web** wireframes only; no fictional mobile wireframe |
| Planned Gantt and ERD | 6–7 |
| Use case, activity, sequence, mobile class | 8–11 |
| Unit and integration results | 13 |
| SwaggerHub and one or two working APIs | 14, pending publication and live checks |
| Live web and mobile app on domain | 15–16, pending deployment |
| What went well / poorly, questions | 17 and Q&A |
| Individual contribution | Role slide and each person's substantive speaking sections; do not invent contribution statistics |

## Submission and room checklist

- Confirm the **assigned presentation slot** and the course deadline/time zone; do not infer a date or time from the plan.
- Enter title, GitHub repository URL and the verified live domain in the course signup spreadsheet. The provided spreadsheet is [here](https://ucf-my.sharepoint.com/:x:/g/personal/aa783101_ucf_edu/IQDJMr_LzweNQa0pHHbcngQWAXl_DMUG_Mg3tkA5eOgAye4?e=Dypdzu); access is a separate authorized team action.
- **All five members upload the slides to WebCourses.** Confirm the course's actual requirements and each upload; the older project plan's single-uploader note is not the presentation instruction.
- Bring a USB drive with the final `.pptx`, `.pdf`, diagram renders and presenter guide. Verify on the presentation machine; do not depend on cloud retrieval. Keep passwords and tokens off the drive.
- Rehearse once with live endpoints, Android device, projector and stopwatch. Confirm editability, embedded notes, page order, readable diagram text, fonts, links and the PDF fallback. A PDF is a deck backup, not a replacement for a working live endpoint.
