export class ProviderError extends Error {
  code: 'TIMEOUT' | 'RATE_LIMIT' | 'NETWORK' | 'NOT_FOUND' | 'UNSUPPORTED' | 'UNKNOWN';
  constructor(code: ProviderError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export function messageForProviderError(e: unknown): string {
  if (e instanceof ProviderError) {
    switch (e.code) {
      case 'TIMEOUT': return 'Music service is taking too long to respond.';
      case 'RATE_LIMIT': return 'Search temporarily limited. Try again shortly.';
      case 'NETWORK': return "You're offline. Showing your local library.";
      case 'NOT_FOUND': return 'This item is no longer available from the provider.';
      case 'UNSUPPORTED': return 'This action is not supported by the current provider.';
      default: return 'Unable to load results.';
    }
  }
  return 'Unable to load results.';
}
