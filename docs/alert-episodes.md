# Durable alert episodes

Implements the state/outbox service for [#16](https://github.com/aluciencozy/price-tracker/issues/16),
stacked on schema/history PRs #42/#44. The service persists qualifying episodes and
independent delivery records in MongoDB transactions. It sends no external messages.

## Integration

After committing a current successful observation, the shared check service calls
`evaluateTrackerObservation(trackedItemId, observationId)` for each enabled watcher
of that Product. Retry the same persisted observation after worker restart; never
fabricate a new observation to replay evaluation. The evaluator verifies Product,
currency, latest successful price/time and freshness. A failure, missing row,
disabled/deleted tracker, future/stale observation or superseded success is ignored.
Concurrent evaluations serialize through the tracker transaction write; state and
outbox commit together. Retries cannot leave a consumed episode without its outbox.

James's authenticated PATCH service should use
`updateOwnedTrackerSettings(serverUserId, trackedItemId, validatedPatch)` for target,
enabled and channel changes. It accepts the exact `targetPrice`, `enabled` and
`alerts` body shapes from OpenAPI. It checks ownership again and rejects unknown
fields, empty edits, invalid money and currency. It does not provide authentication,
CSRF, rate limiting or tracker creation/deletion; those remain the shared API's work.
Do not return its internal document directly to a client.

## State rules

- First fresh success at or below target opens an episode if any channel is enabled.
  Equal target and zero are valid. Each enabled channel gets a separate pending row.
- Sustained low observations update the evaluation pointer without opening another
  episode. Time plus observation ObjectId orders equal-time observations.
- A fresh successful price above target rearms the tracker and cancels old pending
  deliveries; a later qualifying success opens a different episode. Failures never
  rearm. Successful below-target price changes and changing deals never reset state.
- Changing target cents increments a revision, cancels old pending work and permits
  evaluation of a still-fresh current observation for the new target. Replaying the
  same target does not increment/reset. Describe this as target qualification, not
  a newly observed sale.
- Channel edits never reset an open episode or replay it for a newly enabled
  channel. Turning a channel off cancels its pending/retryable work. If both were
  off before any episode was opened, enablement can qualify on the next success.
- Disable cancels pending/retryable deliveries and preserves episode state.
  Re-enable alone does not replay an episode; above-target observations while
  disabled do not rearm it. A genuinely changed target still starts a new evaluation.

Episode IDs combine tracker identity, target revision and a monotonically increasing
sequence. Delivery identity is permanently unique per tracker/episode/channel.
Keep those records across retry/restart and do not use deal IDs or polling-run IDs
as alert identity. Two users sharing one Product have independent target/state.

## Delivery boundary

Nick's #18 worker must claim each pending row atomically with a fenced lease,
recheck current tracker/channel/recipient session eligibility before sending, and
complete only the claimed channel. A sent email never marks push as sent. Pending
work can be cancelled; an already submitted external send cannot be recalled.
The settings service intentionally does not overwrite `sending`, `sent`, `unknown`
or terminal outcomes. Worker reconciliation is necessary for in-flight sends and
uncertain provider acknowledgments. Never blindly retry an unknown email outcome
or treat an expired sending lease as proof nothing was delivered.

Deleted trackers and inactive sessions must be checked at dispatch time even if a
queued delivery remains. Tracker deletion must cancel pending rows through the
owned API. This PR implements no email/FCM adapter or delivery worker and promises
no exactly-once external delivery.

## Validation and remaining work

November 4, 2026: macOS arm64, Node 24.22.1 and disposable MongoDB 8.0 replica set.
The 11 new real-database cases cover equality/zero, sustained low price, recovery/new
episode, failed/stale/future inputs, target edit/replayed edit, channel toggles,
second-channel enablement, all-channels-off qualification, disable/re-enable,
two-user isolation, six concurrent workers, reconnect/replay, separate sent/retryable
channel state, invalid/foreign updates and deleted/older observations.

All 92 API tests passed; the affected history/alert tests passed again after strict
TypeScript fixes (24 cases). API typecheck/build and repository lint passed. The
tests isolate/drop only random test databases, and send no external messages.

Scheduler ingestion/evaluation hooks, the shared PATCH integration, remote MongoDB
proof and real #18 delivery/restart evidence remain before closing #16. The running
starter does not invoke these services or claim live alerts merely from health.
