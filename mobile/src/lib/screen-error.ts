export class ScreenError extends Error {}

export function screenErrorMessage(error: unknown, fallback: string) {
  return error instanceof ScreenError ? error.message : fallback;
}

const plainServerMessages: Readonly<Record<string, string>> = {
  'Paste a key beginning fp_live_ or fp_test_.': 'Paste the key you copied from MyFundedPerps.',
  'Live account connections are not enabled yet.': 'Guardian cannot connect this account right now.',
  'Choose an active account belonging to your API key.': 'Choose an active account linked to your key.',
  'Live trading is not enabled.': 'Trading through Guardian is unavailable for this account.',
  'Live account operations are disabled.': 'Guardian cannot change positions on this account right now.',
  'Invalid notification device token.': 'Guardian could not set up notifications on this device.',
  'Invalid maxRiskUsd.': 'Check your maximum risk per trade.',
  'Invalid lossRoomPercent.': 'Check the percentage of remaining loss room.',
};

const diagnosticFormat = /[\r\n<>{}]|:\/\/|\/(?:api|v\d+)\/|^(?:\[[^\]]*\]|[45]\d\d\b)/;
const diagnosticTerms = /\b[a-z]*Error\s*:|\b(?:HTTP|SDK|API|Expo|sandbox|production|staging|(?:error|status|code)\s*[:=]?\s*[45]\d\d)\b/i;
const internalIdentifier = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\bfp_(?:live|test)_/;

export function serverErrorMessage(error: unknown, fallback: string) {
  if (typeof error !== 'string' || !error.trim()) return fallback;
  const message = error.trim();
  if (Object.hasOwn(plainServerMessages, message)) return plainServerMessages[message]!;
  // Guardian sends instructions as short, single-line messages.
  if (message.length > 500 || diagnosticFormat.test(message) || diagnosticTerms.test(message) || internalIdentifier.test(message)) {
    return fallback;
  }
  return message.replace(/\bTP and SL\b/g, 'take-profit and stop-loss');
}
