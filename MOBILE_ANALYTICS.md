# Private mobile dashboard

Open `/admin/mobile` on the existing Guardian Railway domain. Set a private backend variable `GUARDIAN_ADMIN_TOKEN` to a random value of at least 32 characters. Generate one locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Never add it to EXPO_PUBLIC variables, URLs, or source code. Enter it in the dashboard; it is retained only in tab memory, with a Lock button.

The protected endpoint returns aggregates only. It never exposes API keys, emails, session tokens, or account IDs. Existing Telegram admin metrics remain separate.

## Definitions and coverage

- First app launches: installation IDs reported by the updated app, not Apple/Google download counts. SecureStore persistence, reinstalls and device resets can affect this number. Public telemetry can be spoofed; this is product analytics, not audited store acquisition data.
- Launched in 7 days: installs which started the updated app in the last 7 days. This does not track every foreground event or session duration.
- Users and connections: current retained mobile identities and connections. An identity is a login, not a verified unique person.
- Submitted notional: estimated order value from saved mobile trade tickets whose MFP response is non-dry-run and not a known failure/cancellation. Includes pending orders. It is not reconciled filled volume; fees, P&L, and close volume are not included.
- Dry runs, known failures and unresolved submissions are displayed separately.
- All-mobile metrics include existing history. Platform attribution starts with the updated app; unknown and multiple-platform identities are excluded from iOS/Android filters. Attribution is identity-level, not per order, so historical orders may be attributed once a user reports a platform.
- Account deletion removes associated tickets; dashboards reflect retained history rather than a permanent financial ledger.

## Rollout

The server/dashboard deploys on Railway. First-launch reporting needs the changed mobile JavaScript delivered through an authorized OTA update or a new native build. Nothing has been published to EAS by this commit. Build 8 alone cannot retroactively report installation history.

Review the app's public privacy policy and App Store/Play Console data disclosures for the anonymous installation ID, platform/version, timestamps and its linkage to the signed-in identity before distributing the tracking change. No advertising ID, contacts, location or cross-app tracking is collected.
