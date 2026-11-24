# Funded Guardian mobile app

Funded Guardian is an Expo and React Native app for managing a MyFundedPerps challenge account. It uses the Guardian backend in this repository.

[Privacy Policy](https://fundedguardian.xyz/privacy) · [Terms of Use](https://fundedguardian.xyz/terms) · [Support](https://fundedguardian.xyz/support)

## Features

- Sign in with Apple on iOS, Google, or email if Guardian has provided credentials. Connect a MyFundedPerps account and choose your risk limits.
- Use Home to track your balance, profit target, daily loss room, and maximum drawdown. Browse market prices and charts in Markets.
- Use Trade to size an order based on how much you want to risk and set take-profit and stop-loss levels. Use Activity to review open and closed positions, close part or all of a position, edit its protection, and share a closed-position card.
- Follow market news and alerts in Pulse, with optional push notifications on iPhone.

## Local setup

From the repository root, run:

```sh
cd mobile
npm ci
```

On a Mac with Xcode, run `npx expo run:ios` to compile and install a local debug build. Use that build to test native sign-in. For later JavaScript changes, use the start script.

The app uses the Guardian backend configured in `app.json` by default. To use a test backend, set `EXPO_PUBLIC_API_URL` to its publicly reachable base URL before starting Expo. That setting is public. Keep sign-in provider secrets and MyFundedPerps keys out of mobile configuration. Use a sandbox account when testing connected trading flows.

| Command | Purpose |
| --- | --- |
| `npm start` | Start the Expo development server. |
| `npm run lint` | Run Expo lint. |
| `npm test` | Run the mobile Vitest suite. |
| `npx tsc --noEmit` | Check TypeScript types. |

## App Review demo

On the sign-in screen, tap **Explore demo**. The demo opens a sample challenge account without a login or a MyFundedPerps key. Reviewers can browse the dashboard, markets, and Pulse, then try a simulated trade, position close, or protection change. All demo orders are simulated on the device. Tap **Exit** in the demo banner to return to sign-in.

## Releases

- Ship compatible JavaScript, styling, and bundled asset fixes through EAS Update. Test the update on the `preview` channel with a build that has the same runtime as production, then release it to the `production` channel. The app uses the `appVersion` runtime policy, so keep the app version aligned with the installed builds the update targets.
- Native dependency or Expo SDK changes, native permissions, and entitlements require a new build. Bump the app version to give the changed native runtime its own version, then distribute the new build through TestFlight or the App Store. [Expo runtime version guide](https://docs.expo.dev/eas-update/runtime-versions/)

Funded Guardian does not provide financial advice. It is independent of MyFundedPerps and has no affiliation or endorsement. Trading involves a risk of loss.
