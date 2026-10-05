# Funded Guardian mobile foundation

Expo mobile workspace alongside the existing Telegram backend. This is an initial scaffold, not a release-ready app. Native login and mobile backend authentication are not implemented yet.

## Local validation

Run `npm ci` then `npx tsc --noEmit`. Start with `npx expo start`; native Google sign-in will require a development build once implemented.

## Release approach

- First TestFlight build includes the core experience and native Apple/Google authentication, secure session storage, notifications and sharing capabilities required by launch scope.
- Compatible JavaScript, styling and asset fixes use EAS Update after preview validation.
- Native dependency changes, SDK upgrades, native permissions and entitlements require a new binary.
- Public App Store submission must be functional and accurately disclose the trading experience. Do not submit an empty shell and later add undisclosed functionality via OTA.
- Chat is a later product phase; assess native compatibility and review requirements when adding it.

## Setup still required

1. Confirm application bundle/package identifiers for Guardian. Existing developer credentials are not automatically configured for this new app.
2. Link this workspace to the intended Expo account and EAS project.
3. Run `npx eas-cli@latest update:configure` using the linked project. Do not invent an update URL or runtime version.
4. Configure Google OAuth client IDs for the Guardian app and Apple Sign In capability for its bundle ID.
5. Implement server-side identity token verification, session revocation and explicit Telegram account linking before enabling account access.
6. Configure preview and production delivery, validate a release build and test update rollback before publishing.

Apple/Google client IDs are public configuration. Provider secrets and MFP API keys stay on the backend. Never place those secrets in EXPO_PUBLIC variables.
