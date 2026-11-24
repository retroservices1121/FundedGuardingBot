const easternDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric',
});

export function nextDailyLossReset(now = new Date()) {
  const today = easternDate.format(now);
  const reset = new Date(now);
  // By 05:00 UTC, the Eastern date matches the UTC date in both winter and summer.
  reset.setUTCHours(5, 0, 0, 0);
  if (easternDate.format(reset) === today) reset.setUTCDate(reset.getUTCDate() + 1);
  // Use 04:00 UTC if the next Eastern day has already started by then.
  reset.setUTCHours(4);
  if (easternDate.format(reset) === today) reset.setUTCHours(5);
  return reset;
}
