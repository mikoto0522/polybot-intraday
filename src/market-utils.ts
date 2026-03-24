import type { ClobToken, Coin, Duration, GammaMarket, TrackedMarket } from './types.js';

export function generateCandidateSlugs(coins: Coin[], durations: Duration[], now = Date.now()): string[] {
  const slugs: string[] = [];
  for (const coin of coins) {
    for (const duration of durations) {
      const ms = durationToMs(duration);
      const currentSlot = Math.floor(now / ms) * ms;
      const nextSlot = currentSlot + ms;
      slugs.push(`${coin.toLowerCase()}-updown-${duration}-${Math.floor(currentSlot / 1000)}`);
      slugs.push(`${coin.toLowerCase()}-updown-${duration}-${Math.floor(nextSlot / 1000)}`);
    }
  }
  return [...new Set(slugs)];
}

export function durationToMs(duration: Duration): number {
  return duration === '5m' ? 5 * 60_000 : 15 * 60_000;
}

export function isShortTermCrypto(market: GammaMarket): boolean {
  return /up or down/i.test(market.question) && /(btc|eth|sol|xrp)-updown-(5m|15m)-/i.test(market.slug);
}

export function buildTrackedMarket(gamma: GammaMarket, tokens: ClobToken[]): TrackedMarket {
  const parsed = parseShortTermSlug(gamma.slug);
  const up = tokens.find((token) => /up/i.test(token.outcome)) || tokens[0];
  const down = tokens.find((token) => /down/i.test(token.outcome)) || tokens[1];
  if (!parsed || !up || !down) {
    throw new Error(`Unable to parse short-term market ${gamma.slug}`);
  }
  return {
    conditionId: gamma.conditionId,
    slug: gamma.slug,
    question: gamma.question,
    coin: parsed.coin,
    duration: parsed.duration,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    upTokenId: up.tokenId,
    downTokenId: down.tokenId,
    minOrderSize: 5,
  };
}

export function parseShortTermSlug(slug: string): { coin: Coin; duration: Duration; startTime: number; endTime: number } | null {
  const match = slug.match(/^(btc|eth|sol|xrp)-updown-(5m|15m)-(\d+)$/i);
  if (!match) return null;
  const coin = match[1].toUpperCase() as Coin;
  const duration = match[2] as Duration;
  const startTime = parseInt(match[3], 10) * 1000;
  const endTime = startTime + durationToMs(duration);
  return { coin, duration, startTime, endTime };
}

export function toCoinFromBinance(symbol: string): Coin | null {
  const upper = symbol.toUpperCase();
  if (upper === 'BTCUSDT') return 'BTC';
  if (upper === 'ETHUSDT') return 'ETH';
  if (upper === 'SOLUSDT') return 'SOL';
  if (upper === 'XRPUSDT') return 'XRP';
  return null;
}

export function toCoinFromChainlink(symbol: string): Coin | null {
  const upper = symbol.toUpperCase();
  if (upper === 'BTC/USD') return 'BTC';
  if (upper === 'ETH/USD') return 'ETH';
  if (upper === 'SOL/USD') return 'SOL';
  if (upper === 'XRP/USD') return 'XRP';
  return null;
}
