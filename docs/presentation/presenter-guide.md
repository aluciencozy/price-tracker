# Presenter guide

## Status and live gates

**As of November 9:** PR #61 is open against Staging. Local tests and Android checks are evidence, not proof of a hosted deployment. This deck is not presentation-ready until the team confirms:

- An approved live HTTPS application and API domain, remote MongoDB, and an independent daily job on approved $0 terms.
- SwaggerHub publication and a working HTTPS API base on a verified domain. Verify the demonstrated endpoint, not just the documentation page.
- A verified test account, Android build configured for the live API, and safe credentials provided privately to the presenters.
- Real sender/domain, published templates and runtime sending key; team/source-owner review of live history collection; and a genuine observation-to-outbox-to-email/push check. Confirm Firebase Spark/billing status with its owner. Until these gates pass, do not show or claim a complete live notification chain.
- Campus access to the domain and SwaggerHub. Check two days before and again one day before; escalate to campus IT 1–2 days ahead if blocked.

Use no localhost, IP address, fixture, or recording as a substitute for the required live hosted app and working endpoint. Dated local provider/Android results may be described as supplemental QA only. Do not claim changing a target caused a sale.

## Timed runbook

Content is **11:10**; reserve **0:50** for questions, total **12:00**. The penalty begins beyond 13 minutes; stop or shorten discussion rather than running over. Times include handoffs and demos.

Slides 1–17 are the timed presentation. Slides 18–23 are untimed appendix pages containing the six complete PlantUML diagrams; the larger editable views on slides 6–11 are simplified presentation summaries. Do not narrate the appendix as part of the timed run.

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
| 14 | James | 1:00 | One live SwaggerHub search endpoint |
| 15 | Martin | 1:05 | Hosted web app |
| 16 | Alex | 1:00 | Hosted Android app |
| 17 | Ibrahim | 1:05 | Retrospective and open gates |
| Questions | Whole team | 0:50 | Answer within remaining time |

## Live demo details

1. Before projection, privately sign in with an already verified account and authorize the team's published SwaggerHub documentation against the verified HTTPS API domain. Do not project the login request, password, returned token, authorization controls, request headers, or generated curl. Never put credentials in slides or shared examples.
2. Onscreen run only **GET `/api/tracked-items?q=por&limit=20`**, showing the partial query and a sanitized owned response. Explain that this is a case-insensitive partial server-side search of the signed-in user's watchlist, not a client-only filter. Clear authorization privately afterwards. Verify this endpoint works live in rehearsal; a functional endpoint is required in the presentation.
3. Open the live application by its domain, briefly show entry/verification/reset, sign in without projecting credentials, and show the watchlist, partial search, supported game, target and preferences; show CRUD as time allows. Do not expose private data.
4. Open the Android app connected to the same approved live API, refresh and show the same owned tracker and notification preferences. Only show real email/push when the gates above have been verified. A target change is not an actual provider price drop.

## Rubric map

| Requirement | Evidence |
| --- | --- |
| Problem, title, team and roles | 1–3 |
| MERN, TypeScript, Tailwind, Flutter, GitHub, JWT/security | 2, 4, 11–12 |
| Prototypes / wireframes | 5: existing early **web** wireframes only; no fictional mobile wireframe |
| Planned Gantt and ERD | Summaries 6–7; full diagrams 18–19 |
| Use case, activity, sequence, mobile class | Summaries 8–11; full diagrams 20–23 |
| Unit and integration results | 13 |
| SwaggerHub and working API | 14: one endpoint, pending publication and live checks |
| Live web and mobile app on domain | 15–16, pending deployment |
| What went well / poorly, questions | 17 and Q&A |
| Individual contribution | Role slide and each person's substantive speaking sections; do not invent contribution statistics |

## Verified contribution evidence

The following are merged author PRs in the [project repository](https://github.com/aluciencozy/price-tracker). They provide concrete examples, not contribution scores or a claim that one person did all work in an area.

| Member | Examples |
| --- | --- |
| Alex | [#36: shared API contract](https://github.com/aluciencozy/price-tracker/pull/36); [#38: Flutter API wiring](https://github.com/aluciencozy/price-tracker/pull/38) |
| Martin | [#34: React UI/tests and 12 web wireframes](https://github.com/aluciencozy/price-tracker/pull/34) |
| Ibrahim | [#42: MongoDB schemas/indexes and ERD](https://github.com/aluciencozy/price-tracker/pull/42); [#45: durable episodes/outbox](https://github.com/aluciencozy/price-tracker/pull/45) |
| James | [#50: registration/email verification and transaction/concurrency tests](https://github.com/aluciencozy/price-tracker/pull/50) |
| Nick | [#41: CheapShark adapter](https://github.com/aluciencozy/price-tracker/pull/41); [#49: email adapter](https://github.com/aluciencozy/price-tracker/pull/49) |

Review examples: Alex requested changes and later approved [#50](https://github.com/aluciencozy/price-tracker/pull/50). Martin approved an **earlier commit**, not necessarily the current head, of [#61](https://github.com/aluciencozy/price-tracker/pull/61). The email adapter PR is not proof of live email delivery. Slide 2 speaker notes also contain these references.

## Submission and room checklist

- Confirm the **assigned presentation slot** and the course deadline/time zone; do not infer a date or time from the plan.
- Enter title, GitHub repository URL and the verified live domain in the course signup spreadsheet. The provided spreadsheet is [here](https://ucf-my.sharepoint.com/:x:/g/personal/aa783101_ucf_edu/IQDJMr_LzweNQa0pHHbcngQWAXl_DMUG_Mg3tkA5eOgAye4?e=Dypdzu); access is a separate authorized team action.
- **All five members upload the slides to WebCourses.** Confirm the course's actual requirements and each upload; the older project plan's single-uploader note is not the presentation instruction.
- Bring a USB drive with the final `.pptx`, `.pdf`, diagram renders and presenter guide. Verify on the presentation machine; do not depend on cloud retrieval. Keep passwords and tokens off the drive.
- Rehearse once with live endpoints, Android device, projector and stopwatch. Confirm editability, embedded notes, page order, readable diagram text, fonts, links and the PDF fallback. A PDF is a deck backup, not a replacement for a working live endpoint.
