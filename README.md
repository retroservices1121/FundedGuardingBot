# Funded Guardian Bot

Free multi-user Telegram guardian for MyFundedPerps challenge accounts. Every Telegram user can connect an individual API key, select an account, save personal risk settings, and create a confirmed protected trade.

The repository now includes a mobile-first Telegram Mini App served by the same Railway service. The bot remains the alert and onboarding layer; the Mini App provides the visual Guardian, trading, positions, and history experience.

## Customer journey

1. Customer opens the bot and taps **Connect MyFundedPerps**.
2. They paste an `fp_test_` sandbox key in the private chat.
3. The bot immediately attempts to delete that Telegram message, validates the key directly with MyFundedPerps, then encrypts it with AES-256-GCM before database storage.
4. The bot loads their available accounts and lets them select one.
5. They choose a risk preset and tap BTC, ETH, or SOL Long/Short.
6. Guardian checks the account risk snapshot and effective policy, calculates size from dollars at risk, requests a size-aware quote, and shows a short-lived confirmation.
7. Confirmation either completes a dry run or submits a market order with attached TP/SL.

## Multi-user capabilities included

- Isolated Telegram user profiles
- Per-user encrypted MyFundedPerps credentials
- Sandbox/live environment isolation
- Per-user account selection and risk settings
- Per-user editable loss-room guardrail percentage and exact custom dollar-risk entry
- User-selectable enforced or warnings-only guardrail behavior
- Persistent daily locks in PostgreSQL
- Persistent, single-use expiring trade tickets
- Credential deletion with `/disconnect`
- Owner-only `/adminstats`
- Global dry-run and live-key kill switches
- Railway/Docker deployment
- Telegram-signed Mini App authentication
- Guided first-launch onboarding with API-key creation, permission, validation, and success steps
- Owner-only Mini App analytics for users, connections, activity, successful entry orders, notional, dry runs, and recent executions
- Live public MyFundedPerps price streaming and lightweight chart
- Live best bid, spread, best ask, top-level size, and bid/ask liquidity balance on the protected trade ticket
- Dedicated live Markets tab with search, favorites, category filters, 24-hour movers, volume, and protected long/short shortcuts
- Mini App account overview with per-account profit-target, daily-loss-floor, and maximum-drawdown progress
- Activity view combining open positions, working orders, closed history, and share downloads
- Settings view for manual/automatic daily locks and Telegram alerts
- Protected quote and confirmation flow shared with the bot's risk policy
- Complete working-order view with confirmed order cancellation
- Position chart overlays for entry, take-profit, and stop-loss levels
- Confirmed 25%, 50%, and full position closes
- Atomic TP/SL replacement for open positions
- Optional automatic daily profit and loss lockouts
- Proactive Telegram alerts for new positions, closed positions, and shrinking loss room
- Optional Funded Guardian Pulse channel with public price-move, unusual-volume, widened-spread, and daily market-brief posts

Funded Guardian is free to use. There are no trials, subscriptions, pricing tiers, or payment checkout.

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
5. Generate a Railway public domain for the bot service. Railway exposes it as `RAILWAY_PUBLIC_DOMAIN`; alternatively set `MINI_APP_URL=https://your-domain/app`.
6. Deploy. The service runs Telegram long polling and the Mini App web server together.
7. Open the bot, connect an API key, and use `/app` or the **Open Guardian Mini App** button.
8. Complete the dry-run journey before enabling execution.

The Mini App refreshes authenticated account data automatically every 20 seconds while the Home, Trade, or Activity view is visible. It pauses in the background, while settings are being edited, or while a confirmation sheet is open, then refreshes when Telegram returns to the foreground. Set `MINI_APP_REFRESH_SECONDS` between 10 and 300 seconds to adjust this without a code change.

The Guardian monitor checks connected accounts every 90 seconds by default. Set `GUARDIAN_MONITOR_SECONDS` between 30 and 3,600 seconds to adjust the interval. MyFundedPerps does not currently expose private account WebSocket events, so account alerts use authenticated REST reads while public prices and candles continue to use the public market stream.

The Mini App requires HTTPS when opened through Telegram. Its API accepts only fresh Telegram-signed launch data. MyFundedPerps credentials are decrypted only on the server and are never returned to browser code.

## Funded Guardian Pulse channel

Pulse gives the public Telegram channel a useful job without turning it into a signal room. It publishes factual public-market conditions from the MyFundedPerps market stream; it never publishes customer account data or claims that a news event caused a move.

1. Create a Telegram **channel** for the read-only Pulse feed. Use a separate linked discussion group later if the community needs conversation.
2. Add the Funded Guardian bot as a channel administrator and enable **Post Messages**.
3. In Railway, set `PULSE_CHANNEL_ID` to the public `@channelusername` or numeric `-100...` channel ID.
4. Optionally adjust `PULSE_SYMBOLS`, move/volume/spread thresholds, cooldown, and the New York-time daily brief hour shown in `.env.example`.
5. Redeploy and check Railway logs for `Pulse channel ready` and `Funded Guardian Pulse connected`.

Safe defaults watch BTC, ETH, and SOL; alert on a 1% move over roughly 15 minutes, 3× recent 1-minute volume, or a 10-basis-point best-bid/ask spread. Each alert type is limited to once per market per 60-minute cooldown bucket and publications are deduplicated in PostgreSQL across restarts. Alert buttons hand the reader back to the private bot and open that market in the Mini App.

### Optional news-catalyst alerts

Create a free CryptoPanic token at [cryptopanic.com/developers/api/keys](https://cryptopanic.com/developers/api/keys), then add `CRYPTOPANIC_TOKEN` in Railway. Pulse polls every five minutes and only considers fresh English-language headlines from the configured source-domain allowlist. A headline is published only when it identifies a watched asset and that asset has moved at least 0.5% during the Pulse window.

Every post links to the source, labels the story a **possible catalyst**, reports the overlapping price move, and explicitly says timing does not prove causation. The integration republishes no article body or image. Remove the token to disable news immediately. Adjust `PULSE_NEWS_*` variables in `.env.example` if needed.

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
- `/app` — open the Funded Guardian Mini App
- `/accounts` — select a challenge account
- `/status` — account and risk snapshot
- `/positions` — open positions with current mark and estimated P&L
- `/closed` — ten most recent closed positions with realized P&L, fees, and funding

Each closed position includes a **Share card** button that creates a 1200×675 branded PNG with explicit Copy image, Download PNG, and native Share actions. The direct image clipboard path supports pasting into X on compatible Windows Telegram WebViews.
- `/settings` — select per-trade risk
- `/trade` — protected trade ticket
- `/lock` and `/unlock` — persistent daily trading lock
- `/disconnect` — delete stored credentials
- `/adminstats` — basic owner metrics

When `ADMIN_TELEGRAM_ID` is configured, the same Telegram user sees an owner-only **Guardian analytics** entry in Mini App Settings. The API verifies that Telegram ID server-side before returning analytics. Live order and notional totals include only successful Guardian entry submissions recorded after this analytics release; dry-run confirmations are counted separately.

## Security notes

The encryption master key must remain a deployment secret and must never be committed. Losing it makes stored API keys unrecoverable. Rotating it requires a controlled re-encryption migration.

Telegram message deletion is best-effort. Before broad public launch, the recommended upgrade is a small HTTPS connection page using Telegram authentication so credentials never enter message history. Also add rate limiting, secret-free audit events, credential rotation support, database backups, and an external security review.

The MyFundedPerps developer API is beta. Always validate contract changes in sandbox before deployment.
