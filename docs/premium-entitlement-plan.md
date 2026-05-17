# LoL Vault Premium Entitlement Plan

## Purpose

This document captures the full premium access plan we discussed:

- no mandatory login for free users
- Paddle-driven subscription truth
- backend-issued license entitlements
- secure validation in Electron
- graceful offline behavior

## Current Issue: ERR_CONNECTION_REFUSED on Pricing Fetch

The frontend fetch fails at pricing_service.ts because the dev URL points to the Functions emulator on port 5001.

Current development URL:

- http://127.0.0.1:5001/lolvault/us-central1/getPaddlePremiumPricing

ERR_CONNECTION_REFUSED means nothing is listening on that host/port, so the request never reaches your function.

### Quick Fix Checklist

1. Start Firebase emulators (especially Functions) before loading the web app.
2. Confirm port 5001 is active.
3. Confirm function name exists: getPaddlePremiumPricing.
4. Confirm PADDLE_API_KEY secret is configured for emulator or deployed environment.
5. If using hosting route /api/paddle/pricing, run Hosting emulator too (or deploy hosting rewrite).

## Product Direction (No Traditional Login)

Recommended model:

- Free tier: no login required, local use, max 3 accounts.
- Premium tier: entitlement-based access via Paddle purchase + activation code/license key.

This avoids building a full account dashboard while still enforcing subscriptions.

## High-Level Architecture

1. User purchases Premium via Paddle checkout.
2. Paddle sends webhook events to Firebase Cloud Functions.
3. Cloud Function verifies webhook signature and updates entitlement state in Firestore.
4. Backend issues/maintains license key (or activation code).
5. Electron app activates license on first use and receives a signed entitlement lease token.
6. Electron validates lease locally at launch and periodically refreshes when online.
7. If offline, lease remains valid for a grace period (24h).
8. If lease expires and no refresh possible, app downgrades to free limits.

## Data Ownership Rules

- Paddle is source of truth for billing and subscription status.
- Firestore is source of truth for app entitlement state.
- Electron local state is cache only, never authoritative.

## Firestore Data Model (Suggested)

Collection: entitlements

- entitlementId
- paddleCustomerId
- paddleSubscriptionId
- productId
- monthlyPriceId
- yearlyPriceId
- status (active, past_due, paused, canceled, expired)
- validUntil
- createdAt
- updatedAt
- metadata

Collection: licenses

- licenseKeyHash
- entitlementId
- deviceBindings
- maxDevices
- revoked
- createdAt
- updatedAt

Collection: activationLogs

- licenseKeyHash
- deviceIdHash
- action (activate, refresh, revoke, reject)
- ipHash (optional)
- timestamp

## Webhook Handling Plan

Implement secure webhook endpoint in Cloud Functions.

Typical events to handle:

- subscription.created
- subscription.updated
- subscription.resumed
- subscription.paused
- subscription.canceled
- transaction.completed (if needed for one-time states)

For each webhook:

1. Verify Paddle signature.
2. Enforce idempotency (store processed event IDs).
3. Map billing state -> entitlement state.
4. Update Firestore atomically.
5. Invalidate/refresh lease eligibility accordingly.

## Dynamic Pricing Plan

Already in progress:

- Cloud Function getPaddlePremiumPricing calls Paddle Prices API.
- Returns active recurring month/year prices for the product.
- Frontend consumes this so displayed prices and checkout price IDs are dynamic.

Outcome:

- update prices in Paddle once
- website picks up new amounts and price IDs without hardcoded edits

## Electron Validation and Offline Policy

### Activation

- User enters license key/code in Electron.
- App sends key + device proof to backend.
- Backend validates entitlement status and returns signed lease token.

### Lease Token

- Contains entitlementId, deviceId hash, status, expiry.
- Signed by server private key.
- App verifies signature locally using embedded public key.

### Offline Grace

- If last valid lease exists, allow premium up to 24h after expiry window starts.
- Past grace without successful refresh: downgrade to free mode constraints.

## Anti-Tamper Hardening

- Never trust local active flags for premium.
- Use signed server-issued tokens with short expiry.
- Bind activation to device fingerprint or generated device keypair.
- Store sensitive material in OS secure storage (DPAPI/Keychain), not plain files.
- Add nonce/timestamp checks to prevent replay.
- Add rate limits and abuse monitoring for activation endpoints.
- Expect tampering attempts and optimize for resistance, not perfection.

## UX Policy for Access Loss

Prefer downgrade behavior over destructive lockouts:

- premium-only features disabled
- free limits enforced (3 accounts)
- clear in-app message for renewal/reconnect

This is safer and less likely to damage user trust/data.

## Rollout Plan

Phase 1:

- stabilize dynamic pricing endpoint
- ensure emulator/deploy configuration works

Phase 2:

- implement webhook verification and entitlement storage

Phase 3:

- implement license issuance + activation endpoint

Phase 4:

- implement signed lease token refresh flow in Electron

Phase 5:

- enforce offline grace and downgrade policy

Phase 6:

- hardening, monitoring, edge cases, and support tooling

## Operational Checklist

- Set Firebase secret: PADDLE_API_KEY
- Configure Paddle webhook destination to Cloud Function URL
- Add webhook signing verification secret
- Add alerting for webhook failures and high activation failures
- Add admin utilities to revoke/reset license binding safely

## Notes

- Free users remain loginless.
- Premium users can still be managed by entitlement records without forcing a full account system.
- This approach keeps your product simple while still secure enough for real-world use.
