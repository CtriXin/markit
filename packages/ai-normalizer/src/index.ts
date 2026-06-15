export type NormalizerProvider = 'off' | 'mock' | 'openai-compatible' | 'local-mms-mmf';

export type NormalizerStatus = {
  enabled: boolean;
  provider: NormalizerProvider;
  reason?: string;
};

export function resolveNormalizerStatus(provider: NormalizerProvider | undefined): NormalizerStatus {
  if (!provider || provider === 'off') {
    return { enabled: false, provider: 'off', reason: 'AI normalizer is disabled by default.' };
  }
  return { enabled: true, provider };
}
