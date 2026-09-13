# Funded Guardian Bot

Customer-ready Telegram SaaS foundation for MyFundedPerps challenge accounts. Every Telegram user can connect an individual API key, select an account, save personal risk settings, and create a confirmed protected trade.

## Customer journey

1. Customer opens the bot and taps **Connect MyFundedPerps**.
2. They paste an `fp_test_` sandbox key in the private chat.
3. The bot immediately attempts to delete that Telegram message, validates the key directly with MyFundedPerps, then encrypts it with AES-256-GCM before database storage.
4. The bot loads their available accounts and lets them select one.
5. They choose a risk preset and tap BTC, ETH, or SOL Long/Short.
6. Guardian checks the account risk snapshot and effective policy, calculates size from dollars at risk, requests a size-aware quote, and shows a short-lived confirmation.
7. Confirmation either completes a dry run or submits a market order with attached TP/SL.

## SaaS capabilities included

- Isolated Telegram user profiles
- Seven-day trial state and plan field (`trial`, `pro`, or `suspended`)
- Per-user encrypted MyFundedPerps credentials
- Sandbox/live environment isolation
- Per-user account selection and risk settings
- Persistent daily locks in PostgreSQL
- Persistent, single-use expiring trade tickets
- Credential deletion with `/disconnect`
- Owner-only `/adminstats`
- Global dry-run and live-key kill switches
- Railway/Docker deployment

Payment checkout is deliberately not connected yet. Trial expiration is enforced, and the database is ready for a billing webhook to set `plan='pro'`.

## Local setup

Requirements: Node.js 20+, PostgreSQL, a Telegram bot token, and a MyFundedPerps sandbox key for testing.

```bash
npm install
cp .env.example .env
openssl rand -base64 32
```

Put the generated encryption key and other required values into `.env`, then run:

```bash
npm run check
npm start
```

Database tables and indexes are created automatically on startup.

## Railway deployment

1. Create a Railway project from this GitHub repository.
2. Add a PostgreSQL service.
3. Add `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, `ENCRYPTION_KEY`, and optionally `ADMIN_TELEGRAM_ID`.
4. Keep `DRY_RUN=true` and `ALLOW_LIVE_TRADING=false` for initial testing.
5. Deploy. The Dockerfile runs Telegram long polling, so no public domain is required.
6. Open the bot, connect an `fp_test_` key, and complete the dry-run journey.

## Safe test sequence

1. Keep dry run enabled and live keys blocked.
2. Test two Telegram accounts and confirm each sees only its own connection, account, settings, locks, and tickets.
3. Confirm API-key messages are deleted from each private chat.
4. Test invalid keys, expired confirmations, reconnects, `/disconnect`, and restarts.
5. Disable dry run while keeping sandbox-only access. Submit small protected sandbox trades and verify TP/SL on MyFundedPerps.
6. Do not enable live keys until sandbox tests and an external security review are complete.

## Commands

- `/start` — onboarding or dashboard
- `/connect` — connect or replace a MyFundedPerps credential
- `/accounts` — select a challenge account
- `/status` — account and risk snapshot
- `/positions` — open positions with current mark and estimated P&L
- `/closed` — ten most recent closed positions with realized P&L, fees, and funding

Each closed position includes a **Share #** button that creates a downloadable 1200×675 branded PNG and a ready-to-copy social caption.
- `/settings` — select per-trade risk
- `/trade` — protected trade ticket
- `/lock` and `/unlock` — persistent daily trading lock
- `/disconnect` — delete stored credentials
- `/adminstats` — basic owner metrics

## Security notes

The encryption master key must remain a deployment secret and must never be committed. Losing it makes stored API keys unrecoverable. Rotating it requires a controlled re-encryption migration.

Telegram message deletion is best-effort. Before broad public launch, the recommended upgrade is a small HTTPS connection page using Telegram authentication so credentials never enter message history. Also add rate limiting, secret-free audit events, credential rotation support, database backups, and an external security review.

The MyFundedPerps developer API is beta. Always validate contract changes in sandbox before deployment.
