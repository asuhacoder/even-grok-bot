export type AuthOutcome = 'tailnet identity' | 'tailnet identity via proxy' | 'token' | 'denied' | 'auth timeout';

export type AdmitVia = 'header' | 'proxy';

export function connectedOutcome(owner: boolean, via: AdmitVia): AuthOutcome {
  if (!owner) return 'token';
  return via === 'proxy' ? 'tailnet identity via proxy' : 'tailnet identity';
}

export function identityMatches(header: string | string[] | undefined, login: string): boolean {
  const expected = login.trim();
  if (!expected) return false;
  const value = Array.isArray(header) ? header[0] : header;
  return value === expected;
}

export function connectionLog(outcome: AuthOutcome): string {
  switch (outcome) {
    case 'tailnet identity':
      return 'client connected (tailnet identity)';
    case 'tailnet identity via proxy':
      return 'client connected (tailnet identity via proxy)';
    case 'token':
      return 'client connected (token)';
    case 'denied':
      return 'client denied (token)';
    case 'auth timeout':
      return 'client denied (auth timeout)';
  }
}
