# Server device registration and FCM adapter

Supports [#17](https://github.com/aluciencozy/price-tracker/issues/17), based on
schema PR #42. See [Android readiness](android-push-readiness.md) for client wiring.
No Firebase project, credential, real Android token or delivery is established here.

## Device endpoints

Mount `createDeviceRouter(authenticateMobileSession)` at `/api` before the API 404.
The API owner must supply actual JWT signature/algorithm/issuer/audience/expiry
validation, cookie/auth-ambiguity rejection and server-derived `{userId,sessionId}`.
Translate auth failures to `DeviceError` with the shared status/code. There is no
default identity; the health-only starter does not mount these routes automatically.

The service independently checks verified user state and an active, unexpired
mobile Session. Bodies accept exactly `{installationId,platform:"android",pushToken}`.
Request and database validation share the same UUID parser, including UUIDv7.
Installation UUIDs normalize to lowercase before lookup, rotation and rebinding.
POST returns 201; full PUT rotation 200; bodyless DELETE 204. Public Device has
only id, installationId, platform, sessionId, createdAt and updatedAt. Tokens and
foreign identities never appear in public responses or sanitized error envelopes.

Repeat registration returns the same ID. Owned rotation preserves device identity.
A new account can rebind the same installation only when it also supplies that
binding's existing secret token; an installation UUID alone cannot steal a binding.
A token cannot silently move to another installation. Unique collisions return 409
without deleting or revealing the old binding. Different-account plus different-token
rebind deliberately conflicts: remove the old binding while authenticated before
rotation/account switch, or resolve that lifecycle with the API/mobile owners.

PUT/DELETE require current user and session ownership. Old-session removal cannot
delete a rebound device. Invalid-token cleanup matches the captured session/token,
so a late failure cannot disable a rotated replacement. `eligiblePushDevices` is
private worker data, excluding revoked/expired/nonmobile sessions and unverified
users even if device rows remain. Never expose it as a public listing endpoint.
Dispatch must recheck just before each send; an already submitted external message
cannot be recalled, so recipient-session payload and client checks remain essential.

Logout/reset should proactively deactivate bindings with session revocation. Session
TTL alone is not cleanup. A registration racing logout might leave a row, but the
revoked session can never become eligible from that row. Browser login does not
register Android tokens. Shared auth/CORS/rate limits remain API integration work.

## Configuring free FCM

1. Create an approved Spark/free Firebase project without billing or a payment
   method. Register the exact Flutter Android application ID and coordinate its
   client configuration with Alex. Keep delivery orchestration in Express/worker;
   do not enable paid Cloud Functions.
2. Enable Cloud Messaging HTTP v1 and grant the server only the required messaging
   permission in this project. Prefer short-lived managed credentials where possible;
   otherwise keep a service-account credential file outside git, readable only by
   the service user. Never paste it in PR text or frontend configuration.
3. Configure `FIREBASE_PROJECT_ID` and deployment-managed Application Default
   Credentials; `GOOGLE_APPLICATION_CREDENTIALS` can point to the private file.
   The worker explicitly calls `createFirebaseFcmSender(projectId)`. Importing the
   module does not configure cloud resources or send a message.
4. Record real Android receipt, foreground/background/tap, permission denial,
   rotation and account switching with Alex. Provider acceptance alone proves
   neither device receipt nor notification display.

The implementation follows [official Admin SDK/ADC setup](https://firebase.google.com/docs/admin/setup)
and [FCM error guidance](https://firebase.google.com/docs/cloud-messaging/error-codes),
checked November 4, 2026. Actual account access and free limits remain to be verified.

## Sending and retry boundary

`createFcmSender(transport)` supplies the explicit fake-transport test boundary;
production uses `getMessaging(app).send`. Its strict all-string OpenAPI payload
contains schemaVersion/type, episode eventId, stable deliveryId, recipientSessionId,
trackedItemId, productId and observedAt. No URLs, titles, price/target, personal
information or secrets are allowed. Android receives a data-only, normal-priority
message with one-hour TTL. Authenticated client code owns display/lifecycle handling;
the server adds no automatic OS notification.

Outcomes are accepted (provider message ID), retryable with backoff, permanent
failure with an explicit invalid-token flag, or unknown. Raw SDK errors, credentials
and tokens are never returned/logged. Explicit quota/service rejection uses at least
60 seconds backoff and honors numeric Retry-After up to a day. There is no automatic
application retry. Uncertain transport results and a 15-second deadline are unknown.

The deadline bounds caller waiting; it cannot cancel an SDK request already in
flight. The SDK can apply its own internal retries. Do not blindly resubmit unknown
sends. Persist outbox identity, stable event/delivery IDs and uncertainty for
reconciliation. Only explicit invalid/unregistered-token outcomes deactivate the
captured binding; payload/config errors do not invalidate a user's token. This is
not exactly-once device delivery.

## Validation and remaining proof

November 4, 2026: Node 24.22.1, macOS arm64, disposable MongoDB 8.0 replica set.
All **85 API tests passed**, including eight device database cases and nine offline
FCM cases. They cover exact response/status shapes, repeat register, rotation,
account rebind, anti-stealing conflicts, ownership, revoked/expired/unverified
exclusion, late invalidation, strict payloads, backoff and unknown/deadline outcomes.
API typecheck/build and repository lint passed. No external message was sent.

Real JWT/header/CORS/rate-limit wiring, Firebase/Spark setup, messaging permissions,
deployed credentials, Android send and lifecycle evidence remain before #17 closes.
