# Room-scoped phone identity rollout

## Scope and privacy

This is the approved friends-only, unverified nickname + phone flow. It is not an account/password/SMS system. Possession of the entered phone text is enough to use that identity in its room, including owner rights. Never print real phone inputs, phone digests, room HMAC keys or browser bearer tokens in deployment output.

The raw phone is normalized in memory only. Each room stores `phoneIdentity: { version: 1, key }` (random 256-bit HMAC key); each bound member stores `phoneKey`. The index is rebuilt on startup and rejects duplicates or a missing/malformed key. Nothing is shared across rooms. Both fields stay in the existing private room snapshot with its existing 0600 file/0700 directory protection. They are excluded from state, history, ledger, card proofs, effects, private hand/transaction text, and client storage.

## Migration

- Keep every stable member ID, bearer token, seat, chip balance, queued transaction, hand, and owner token
- An old browser token can bind only its exact unbound member to a phone. A phone already bound to another member rejects the claim; it never merges records
- Without that old token, a matching nickname cannot claim a legacy member. The old record remains intact. Existing users must first bind from their original browser
- Valid phone + different saved bound token follows the phone, without rebinding the saved identity
- On first load, original unique legacy nicknames may gain stable display references in structured records. Ambiguous records remain unchanged. This is display metadata only
- `displayIdentityVersion: 1` prevents reinferring historical identity after renames. New actions/winners/reveals/events include IDs or internal name spans. Public copies resolve the latest name on read; private audit text and transaction files remain unchanged
- In-memory `stateEpoch` is new after restart; browser ordering rejects retired epochs, accepts the new epoch's lower revision, and resets sound/preaction baselines

## Staging and cutover

1. Verify the live baseline is release `20261006-loading-e9cde307`, with exact hashes from the supplied manifest
2. Create a fresh candidate release from that release, preserving all 13 production media files; apply only the forward patch. Do not replace the entire public directory with this text-only checkout
3. Create a separate rollback-compatible release from that same baseline and apply the supplied compatibility patch. Its room serializer preserves the room phone HMAC key and the existing member spread preserves phoneKey
4. Run syntax, full isolated tests, identity concurrency/privacy/restart/failure tests and the ten-player load script. For the rollback test, pass PHONE_ROLLBACK_ROOM pointing to the staged compatibility release's room.js if no Git baseline is present
5. Immediately before cutover, verify source hashes and no active/soon-starting hand. Back up private data and hand records without logging contents. Keep the backup private
6. Switch the service to the candidate, preserving shared DATA_DIR/HAND_RECORDS_DIR and existing runtime configuration. Verify health, live static hashes/media, private API cache controls and synthetic-room UI flows
7. Browser acceptance should include two independent contexts using one synthetic phone, new nickname shown on both tables/history, no old code UI, refresh/reconnect, compact payloads, failed/repeated clicks, and another player's turn progressing during refresh bursts

## Rollback

Never point back to the unpatched e9cde307 room serializer after phone bindings exist: it drops the room-level key while retaining member digests, breaking future recovery.

Use the prepared compatibility release. It preserves `phoneIdentity` exactly and preserves each member's `phoneKey` through the baseline member spread. It writes `displayIdentityVersion: 0` so a later forward upgrade can attach IDs only to unambiguous events made by the older code during rollback; existing stable IDs/spans remain authoritative. Browser tokens, owner, chips, seats, actions and transaction receipts remain untouched. The older UI temporarily returns during rollback; do not claim the phone flow is still active then.

Do not restore a predeployment data backup after any postdeployment player activity; that would discard chips/actions/identity bindings. Use code-only compatibility rollback against current private data, or stop and investigate. Local tests exercise an actual baseline serializer through forward → compatibility rollback → forward with the same identity, owner, seat, chips and archived events.

## Refresh limits

Identical normalized phone/name join is a no-op: no snapshot write, version bump, table state broadcast or greeting effect. The live app adds compact=1, so no historical-hand list is transmitted on create/join/state/command/WS; paginated history remains explicit. Transient presence coalesces over 250 ms without a room snapshot write. Each connection gets its own initial snapshot; game mutations remain promptly broadcast.

Per-room player limits are approximately 120 joins and socket handshakes/minute, 300 reads/commands/minute, and eight concurrent sockets. Valid joins do not share an IP bucket. Limiter storage is bounded to 10,000 constant-size token buckets. Existing slow-socket coalescing and disconnect thresholds remain in effect. This reduces ordinary refresh churn; it is not an unlimited-traffic or hostile-DDoS guarantee.
