# TestFlight review access

The login screen includes **Explore demo**. Reviewers do not need a username,
password, Apple/Google account, or MyFundedPerps API key to use it.

The persistent **DEMO · Sample data · No real orders** banner identifies the demo.
The **Exit** button returns to the login screen.

## Suggested review notes

Launch Funded Guardian and tap **Explore demo** below the Apple/Google sign-in
buttons. This opens a sample $25,000 challenge account. No sign-in credentials or
API key are required for demo access.

You can explore Home (account overview and limits), Markets (sample heatmap and
search), Trade (interactive sample chart, leverage selection, risk sizing and
dry-run order review), Activity (open/closed sample positions, TP/SL review and
dry-run closing), Pulse (clearly marked sample content), and Settings/Learn.
The sample trade card can also be shared and is marked as demo data.

Demo data and trade validations are handled locally on the device. Demo mode
does not submit real orders, connect an API key, or register for push notifications.
Dry-run validations leave sample positions unchanged. Exit demo to access the
normal Apple/Google sign-in flow. Real account features require a separately
connected MyFundedPerps API key.

## Release notes

Submit the new TestFlight build that embeds this feature rather than relying on
an OTA update to the earlier build. EAS build success and upload do not establish
Apple processing, Beta App Review approval or external tester availability.
