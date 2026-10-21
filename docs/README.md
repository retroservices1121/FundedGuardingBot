# Funded Guardian public pages

In repository **Settings → Pages**, set **Source: Deploy from a branch**, **Branch: main**, **Folder: /docs**, then Save. No build command or secrets are required. The Pages host serves only these public static files, not the bot, database or admin dashboard.

Expected URLs once GitHub finishes publishing:

- Landing: https://retroservices1121.github.io/FundedGuardingBot/
- Privacy: https://retroservices1121.github.io/FundedGuardingBot/privacy.html
- Terms: https://retroservices1121.github.io/FundedGuardingBot/terms.html
- Support: https://retroservices1121.github.io/FundedGuardingBot/support.html

The beta button forwards to the existing Railway signup page to preserve its email capture and immediate TestFlight link. API keys and app credentials must never be entered on GitHub Pages. Privacy/terms describe the current Guardian implementation; update them if processing or operator contact details change. Project support currently uses the existing Telegram project contact and public GitHub issues for non-sensitive technical reports. Do not post personal data or API keys in an issue.

Connect the final published privacy and support URLs in App Store Connect and the app's settings before production distribution. A terms URL on a site does not itself add an in-app acceptance flow or replace platform agreements.
