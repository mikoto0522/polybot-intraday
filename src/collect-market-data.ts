import { loadConfig } from './config.js';
import { generateCandidateSlugs, isShortTermCrypto, buildTrackedMarket, toCoinFromBinance, toCoinFromChainlink } from './market-utils.js';
import { fetchClobMarket, fetchGammaMarketBySlug } from './polymarket-api.js';
import { PolymarketRealtime } from './realtime.js';
import { JsonlTapeWriter } from './tape-writer.js';
import type { Coin, CryptoPrice, OrderbookSnapshot, TrackedMarket } from './types.js';

const config = loadConfig();
const realtime = new PolymarketRealtime();
const writer = new JsonlTapeWriter(config.dataDir, 'observed-tape', 'tape');

const markets = new Map<string, TrackedMarket>();
const coinToConditions = new Map<Coin, Set<string>>();
const latestBinance = new Map<Coin, CryptoPrice>();

async function main(): Promise<void> {
  console.log(`Collecting real data to ${writer.getPath()}`);
  writer.record('session_start', {
    mode: 'collector',
    coins: config.coins,
    durations: config.durations,
    dataDir: config.dataDir,
    baselineCaptureGraceSec: config.baselineCaptureGraceSec,
  });

  realtime.on('orderbook', (book: OrderbookSnapshot) => {
    writer.record('book_top', {
      tokenId: book.assetId || book.tokenId,
      market: book.market,
      bestBid: book.bids[0]?.price ?? 0,
      bidSize: book.bids[0]?.size ?? 0,
      bestAsk: book.asks[0]?.price ?? 0,
      askSize: book.asks[0]?.size ?? 0,
      spread: (book.asks[0]?.price ?? 0) - (book.bids[0]?.price ?? 0),
      timestamp: book.timestamp,
      hash: book.hash,
    }, book.timestamp);
  });

  realtime.on('binancePrice', (price: CryptoPrice) => {
    const coin = toCoinFromBinance(price.symbol);
    if (!coin) return;
    latestBinance.set(coin, price);
    writer.record('binance_price', {
      coin,
      symbol: price.symbol,
      price: price.price,
      timestamp: price.timestamp,
    }, price.timestamp);
    captureBaselines(coin, price);
  });

  realtime.on('chainlinkPrice', (price: CryptoPrice) => {
    const coin = toCoinFromChainlink(price.symbol);
    if (!coin) return;
    writer.record('chainlink_price', {
      coin,
      symbol: price.symbol,
      price: price.price,
      timestamp: price.timestamp,
    }, price.timestamp);
  });

  realtime.subscribeCryptoPrices(config.coins.map((coin) => `${coin.toLowerCase()}usdt`));
  realtime.subscribeCryptoChainlinkPrices(config.coins.map((coin) => `${coin.toLowerCase()}/usd`));

  await realtime.connect();
  await discoverMarkets();
  const discoverTimer = setInterval(() => void discoverMarkets(), config.scanSec * 1000);
  const baselineTimer = setInterval(() => {
    for (const [coin, tick] of latestBinance.entries()) {
      captureBaselines(coin, tick);
    }
  }, 250);

  const shutdown = async (): Promise<void> => {
    clearInterval(discoverTimer);
    clearInterval(baselineTimer);
    realtime.disconnect();
    writer.record('session_end', { markets: markets.size });
    await writer.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise(() => undefined);
}

async function discoverMarkets(): Promise<void> {
  const slugs = generateCandidateSlugs(config.coins, config.durations);
  for (const slug of slugs) {
    try {
      const gamma = await fetchGammaMarketBySlug(slug);
      if (!gamma || gamma.closed || !isShortTermCrypto(gamma)) continue;
      if (markets.has(gamma.conditionId)) continue;
      const clob = await fetchClobMarket(gamma.conditionId);
      if (!clob || clob.closed || !clob.acceptingOrders || clob.tokens.length < 2) continue;
      const meta = buildTrackedMarket(gamma, clob.tokens);
      markets.set(meta.conditionId, meta);
      const perCoin = coinToConditions.get(meta.coin) || new Set<string>();
      perCoin.add(meta.conditionId);
      coinToConditions.set(meta.coin, perCoin);
      realtime.subscribeMarkets([meta.upTokenId, meta.downTokenId]);
      writer.record('market_discovered', { ...meta });
      const tick = latestBinance.get(meta.coin);
      if (tick) captureBaselineForMarket(meta, tick);
    } catch (error) {
      console.warn(`discoverMarkets failed for ${slug}:`, error);
    }
  }
}

function captureBaselines(coin: Coin, tick: CryptoPrice): void {
  for (const conditionId of coinToConditions.get(coin) || []) {
    const market = markets.get(conditionId);
    if (!market) continue;
    captureBaselineForMarket(market, tick);
  }
}

function captureBaselineForMarket(market: TrackedMarket, tick: CryptoPrice): void {
  if (market.baseline != null) return;
  const now = tick.timestamp;
  if (now < market.startTime) return;
  if (now > market.startTime + config.baselineCaptureGraceSec * 1000) return;
  market.baseline = tick.price;
  market.baselineCapturedAt = tick.timestamp;
  writer.record('baseline_captured', {
    conditionId: market.conditionId,
    slug: market.slug,
    coin: market.coin,
    baseline: market.baseline,
    capturedAt: market.baselineCapturedAt,
  }, tick.timestamp);
}

main().catch(async (error) => {
  console.error('Collector failed:', error);
  writer.record('collector_error', { message: error instanceof Error ? error.message : String(error) });
  await writer.close();
  process.exit(1);
});
