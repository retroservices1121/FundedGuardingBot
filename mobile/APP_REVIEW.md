# App Review access

Use the live email sign-in path for the next review. The sample-data Explore demo remains available, but does not replace the live access instructions.

## Server activation

Set these private Railway backend variables (never EXPO_PUBLIC variables):

- `GUARDIAN_REVIEW_EMAIL`: the approved review login identifier.
- `GUARDIAN_REVIEW_PASSWORD_HASH`: generated with `npx tsx scripts/hash-review-password.ts`, supplying the password through stdin. Do not store the plaintext password in source, the mobile bundle, logs, or this document.

Email login is disabled until both variables are valid. No real mailbox or email verification is required. Removing either setting or changing the password hash invalidates existing email sessions. Preserve the same hash across deployments while review is ongoing. There is no public email registration or password reset flow. This is a provisioned account using normal session and account permissions.

## Beta App Review Information

Enable Sign-in required. Put the review email and password in the username and password fields. Enter the competition API key privately in the Notes field with these steps:

1. On the login screen, tap Sign in with email.
2. Enter the supplied username and password and tap Sign in.
3. Follow Connect MyFundedPerps and paste the supplied API key. The key determines the Live environment.
4. Select the competition account.
5. Home shows real account information; Markets provides live discovery; Trade supports trade review and confirmation; Activity supports position management and TP/SL; Pulse shows news and alerts.

The account belongs to the developer and is provided for testing. Trading actions affect the competition account. State explicitly which actions the reviewer may perform. No API key is bundled in the app. Keep the review credentials and key valid throughout review and subsequent review cycles. Do not include them in What to Test or public metadata.

## Release

Deploy and activate the server first, verify valid and invalid credentials against the live endpoint, then build iOS from the commit containing email login. Verify the exact installed build and full API-key setup before submitting. Keep Apple/Google login and the secondary email option in the shipped app; deleting it is unnecessary. Future reviewers must retain working access even if this account is rotated or disabled between reviews.
