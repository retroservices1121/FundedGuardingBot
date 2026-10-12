# Guardian landing page on Railway

The existing bot service serves the public landing page at `/`. Telegram stays at `/app`, and mobile API routes stay unchanged. The existing Dockerfile includes `public`, so no separate Railway service or build command is needed.

Optional Railway variables:

- `GUARDIAN_TESTFLIGHT_URL`: Guardian's approved public link, in the form `https://testflight.apple.com/join/XXXXXXXX`. Until set, successful signups show a waiting-list message. Do not use another app's link.
- `GUARDIAN_AFFILIATE_URL`: your HTTPS challenge-account affiliate link. The affiliate section remains hidden until configured.

Beta emails are saved to `landing_beta_signups` in the existing PostgreSQL database. Marketing consent is optional and is not required for beta access. Re-submitting an email updates its preference. No emails are sent automatically by this change.

Export beta registrations using a private database connection:

```sql
SELECT email, marketing_consent, consent_version, created_at, updated_at
FROM landing_beta_signups ORDER BY created_at DESC;
```

Only use rows with `marketing_consent = TRUE` for marketing. Handle deletion or consent-withdrawal requests received through the listed Telegram support contact. There is no public email-list endpoint.

To delete a requested email, use a parameterized query through your private database client:
`DELETE FROM landing_beta_signups WHERE email = $1`.

Connect a future custom domain to this same Railway service. Keep `MINI_APP_URL` pointing to `/app` for the Telegram mini app.

Screenshots are the original app captures, extracted losslessly from the approved mockup. Website JavaScript and image assets are served separately with a restrictive Content Security Policy.
