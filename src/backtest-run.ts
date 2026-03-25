import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { loadConfig, type Config } from './config.js';
import {
  applyCoinStrategyAdjustments,
  computeLateExitPrice,
  computeTakeProfitPrice,
  evaluateSignal,
  evaluateLotterySignal,
  toBps,
} from './strategy-core.js';
import type { Coin, CryptoPrice, OpenPosition, Side, SignalCandidate, TokenBook, TrackedMarket } from './types.js';

interface TapeEvent<T = Record<string, unknown>> {
  ts: number;
  type: string;
  payload: T;
}

interface MarketDiscoveredPayload {
  conditionId: string;
  slug: string;
  question: string;
  coin: Coin;
  duration: '5m' | '15m';
  startTime: number;
  endTime: number;
  upTokenId: string;
  downTokenId: string;
  minOrderSize: number;
}

interface PricePayload {
  coin: Coin;
  symbol: string;
  price: number;
  timestamp: number;
}

interface BookTopPayload {
  tokenId: string;
  market: string;
  bestBid: number;
  bidSize: number;
  bestAsk: number;
  askSize: number;
  spread: number;
  timestamp: number;
}

interface BaselinePayload {
  conditionId: string;
  baseline: number;
  capturedAt: number;
}

interface ClosedTrade extends OpenPosition {
  closeReason: string;
}

class StrictBacktester {
  private readonly markets = new Map<string, TrackedMarket>();
  private readonly tokenToCondition = new Map<string, string>();
  private readonly coinToConditions = new Map<Coin, Set<string>>();
  private readonly orderbooks = new Map<string, TokenBook>();
  private readonly binance = new Map<Coin, CryptoPrice>();
  private readonly chainlink = new Map<Coin, CryptoPrice>();
  private readonly binanceHistory = new Map<Coin, CryptoPrice[]>();
  private readonly openPositions = new Map<string, OpenPosition>();
  private readonly closedTrades: ClosedTrade[] = [];
  private readonly coinCooldownUntil = new Map<Coin, number>();
  private paperBalance: number;
  private signalCount = 0;
  private rejectCount = 0;
  private readonly rejectReasons = new Map<string, number>();

  constructor(private readonly config: Config) {
    this.paperBalance = config.paperBalance;
  }

  process(event: TapeEvent): void {
    switch (event.type) {
      case 'market_discovered':
        this.handleMarketDiscovered(event.payload as unknown as MarketDiscoveredPayload);
        break;
      case 'baseline_captured':
        this.handleBaseline(event.payload as unknown as BaselinePayload);
        break;
      case 'binance_price': {
        const payload = event.payload as unknown as PricePayload;
        this.handleBinance(payload);
        this.settleExpired(payload.timestamp);
        this.manageOpenPositions(payload.coin, payload.timestamp);
        this.evaluateCoin(payload.coin, payload.timestamp);
        break;
      }
      case 'chainlink_price': {
        const payload = event.payload as unknown as PricePayload;
        this.handleChainlink(payload);
        this.manageOpenPositions(payload.coin, payload.timestamp);
        this.evaluateCoin(payload.coin, payload.timestamp);
        break;
      }
      case 'book_top': {
        const payload = event.payload as unknown as BookTopPayload;
        this.handleBookTop(payload);
        this.settleExpired(payload.timestamp);
        this.manageOpenPositionsByToken(payload.tokenId, payload.timestamp);
        this.evaluateByToken(payload.tokenId, payload.timestamp);
        break;
      }
      default:
        break;
    }
  }

  finish(): void {
    for (const position of this.openPositions.values()) {
      const current = this.currentWinner(position.coin, position.baseline, position.endTime);
      if (!current) continue;
      this.settlePosition(position, current === position.side ? 1 : 0);
    }
  }

  printSummary(filePath: string): void {
    const summary = this.getSummary();
    console.log('=== Strict Backtest ===');
    console.log(`File: ${filePath}`);
    console.log(`Signals: ${summary.signals} | Rejects: ${summary.rejects} | Closed trades: ${summary.closedTrades}`);
    console.log(`Realized PnL: ${summary.realizedPnl.toFixed(3)} | Paper balance: ${summary.paperBalance.toFixed(3)} | Open unresolved: ${summary.openUnresolved}`);

    console.log('Close reasons');
    for (const line of summary.byReason) console.log(line);

    console.log('By side');
    for (const line of summary.bySide) console.log(line);

    console.log('By strategy');
    for (const line of summary.byStrategy) console.log(line);

    console.log('By coin');
    for (const line of summary.byCoin) console.log(line);

    console.log('Top rejects');
    for (const line of summary.topRejects) console.log(line);
  }

  getSummary(): {
    signals: number;
    rejects: number;
    closedTrades: number;
    realizedPnl: number;
    paperBalance: number;
    openUnresolved: number;
    byReason: string[];
    bySide: string[];
    byStrategy: string[];
    byCoin: string[];
    topRejects: string[];
  } {
    const realized = this.closedTrades.reduce((sum, trade) => sum + (trade.realizedPnl || 0), 0);
    return {
      signals: this.signalCount,
      rejects: this.rejectCount,
      closedTrades: this.closedTrades.length,
      realizedPnl: realized,
      paperBalance: this.paperBalance,
      openUnresolved: this.openPositions.size,
      byReason: summarize(this.closedTrades, (trade) => trade.closeReason),
      bySide: summarize(this.closedTrades, (trade) => trade.side),
      byStrategy: summarize(this.closedTrades, (trade) => trade.strategyKind || 'main'),
      byCoin: summarize(this.closedTrades, (trade) => trade.coin),
      topRejects: [...this.rejectReasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([reason, count]) => `${reason} ${count}`),
    };
  }

  private handleMarketDiscovered(payload: MarketDiscoveredPayload): void {
    const market: TrackedMarket = { ...payload };
    this.markets.set(market.conditionId, market);
    this.tokenToCondition.set(market.upTokenId, market.conditionId);
    this.tokenToCondition.set(market.downTokenId, market.conditionId);
    const perCoin = this.coinToConditions.get(market.coin) || new Set<string>();
    perCoin.add(market.conditionId);
    this.coinToConditions.set(market.coin, perCoin);
  }

  private handleBaseline(payload: BaselinePayload): void {
    const market = this.markets.get(payload.conditionId);
    if (!market) return;
    market.baseline = payload.baseline;
    market.baselineCapturedAt = payload.capturedAt;
  }

  private handleBinance(payload: PricePayload): void {
    const tick: CryptoPrice = {
      symbol: payload.symbol,
      price: payload.price,
      timestamp: payload.timestamp,
    };
    this.binance.set(payload.coin, tick);
    const history = this.binanceHistory.get(payload.coin) || [];
    history.push(tick);
    const retentionMs = Math.max(
      this.config.binanceLookbackMs * 3,
      this.config.trendLookbackMs + this.config.binanceLookbackMs,
      15_000,
    );
    const cutoff = payload.timestamp - retentionMs;
    while (history.length > 0 && history[0].timestamp < cutoff) history.shift();
    this.binanceHistory.set(payload.coin, history);
  }

  private handleChainlink(payload: PricePayload): void {
    this.chainlink.set(payload.coin, {
      symbol: payload.symbol,
      price: payload.price,
      timestamp: payload.timestamp,
    });
  }

  private handleBookTop(payload: BookTopPayload): void {
    this.orderbooks.set(payload.tokenId, {
      bestBid: payload.bestBid,
      bestAsk: payload.bestAsk,
      bidSize: payload.bidSize,
      askSize: payload.askSize,
      spread: payload.spread,
      timestamp: payload.timestamp,
    });
  }

  private evaluateByToken(tokenId: string, now: number): void {
    const conditionId = this.tokenToCondition.get(tokenId);
    if (!conditionId) return;
    const market = this.markets.get(conditionId);
    if (!market) return;
    this.evaluateCoin(market.coin, now);
  }

  private evaluateCoin(coin: Coin, now: number): void {
    const openCount = this.openPositions.size;
    if (openCount >= this.config.maxOpenPositions) return;
    if ((this.coinCooldownUntil.get(coin) || 0) > now) return;

    const candidates: Array<{ market: TrackedMarket; signal: SignalCandidate }> = [];
    for (const conditionId of this.coinToConditions.get(coin) || []) {
      const market = this.markets.get(conditionId);
      if (!market || market.baseline == null) continue;
      if (this.openPositions.has(conditionId)) continue;
      if (now < market.startTime || now >= market.endTime) continue;
      const strategy = applyCoinStrategyAdjustments(this.config.strategyProfiles[market.duration], market.coin, market.duration);
      const timeRemainingSec = (market.endTime - now) / 1000;
      if (timeRemainingSec > strategy.closeWindowSec || timeRemainingSec <= 1) continue;

      const spot = this.binance.get(market.coin);
      if (!spot || now - spot.timestamp > strategy.maxExternalAgeMs) continue;
      const chain = this.chainlink.get(market.coin);
      const chainAvailable = !!chain && now - chain.timestamp <= strategy.maxExternalAgeMs;
      const upBook = this.orderbooks.get(market.upTokenId);
      const downBook = this.orderbooks.get(market.downTokenId);
      if (!upBook || !downBook) continue;
      if (now - upBook.timestamp > strategy.maxBookAgeMs || now - downBook.timestamp > strategy.maxBookAgeMs) continue;

      const binanceDeltaBps = toBps(spot.price, market.baseline);
      const chainlinkDeltaBps = chainAvailable && chain ? toBps(chain.price, market.baseline) : 0;
      const result = evaluateSignal({
        market,
        strategy,
        upBook,
        downBook,
        baseline: market.baseline,
        timeRemainingSec,
        binanceDeltaBps,
        chainlinkDeltaBps,
        chainAvailable,
        binancePulseBps: this.getBinancePulseBps(market.coin),
        macroTrendBps: this.getBinanceTrendBps(market.coin),
        stake: this.config.budget,
      }, this.config.trendBiasBps);

      if ('failure' in result) {
        if (this.config.lotteryEnabled) {
          const lotteryResult = evaluateLotterySignal({
            market,
            strategy,
            upBook,
            downBook,
            baseline: market.baseline,
            timeRemainingSec,
            binanceDeltaBps,
            chainlinkDeltaBps,
            chainAvailable,
            binancePulseBps: this.getBinancePulseBps(market.coin),
            macroTrendBps: this.getBinanceTrendBps(market.coin),
            stake: this.config.lotteryBudget,
          }, {
            enabled: this.config.lotteryEnabled,
            budget: this.config.lotteryBudget,
            closeWindowSec: this.config.lotteryCloseWindowSec,
            minSignalAsk: this.config.lotteryMinSignalAsk,
            maxSignalAsk: this.config.lotteryMaxSignalAsk,
            minEdge: this.config.lotteryMinEdge,
            minLag: this.config.lotteryMinLag,
            minScore: this.config.lotteryMinScore,
            minPulseBps: this.config.lotteryMinPulseBps,
            minTrendBps: this.config.lotteryMinTrendBps,
            minBinanceDeltaBps: this.config.lotteryMinBinanceDeltaBps,
            minLeadGapBps: this.config.lotteryMinLeadGapBps,
            maxTopBookValue: this.config.lotteryMaxTopBookValue,
            maxSpread: this.config.lotteryMaxSpread,
          });
          if ('signal' in lotteryResult) {
            candidates.push({ market, signal: lotteryResult.signal });
            continue;
          }
        }
        this.rejectCount += 1;
        this.rejectReasons.set(result.failure.reason, (this.rejectReasons.get(result.failure.reason) || 0) + 1);
        continue;
      }
      candidates.push({ market, signal: result.signal });
    }

    const currentCoinPositions = [...this.openPositions.values()].filter((position) => position.coin === coin).length;
    if (currentCoinPositions >= this.config.maxOpenPositionsPerCoin) return;

    for (const { market, signal } of candidates.sort((a, b) => b.signal.score - a.signal.score)) {
      if (this.openPositions.size >= this.config.maxOpenPositions) break;
      const coinOpen = [...this.openPositions.values()].filter((position) => position.coin === market.coin).length;
      if (coinOpen >= this.config.maxOpenPositionsPerCoin) break;
      this.openPosition(market, signal, now);
      this.coinCooldownUntil.set(market.coin, now + this.config.coinCooldownSec * 1000);
      break;
    }
  }

  private openPosition(market: TrackedMarket, signal: SignalCandidate, now: number): void {
    if (this.paperBalance < signal.stake) return;
    const tokenId = signal.side === 'UP' ? market.upTokenId : market.downTokenId;
    const ask = signal.ask;
    if (ask <= 0) return;
    const shares = signal.stake / ask;
    const position: OpenPosition = {
      id: randomUUID(),
      conditionId: market.conditionId,
      slug: market.slug,
      question: market.question,
      coin: market.coin,
      duration: market.duration,
      side: signal.side,
      tokenId,
      upTokenId: market.upTokenId,
      downTokenId: market.downTokenId,
      baseline: market.baseline!,
      stake: signal.stake,
      entryPrice: ask,
      shares,
      openedAt: now,
      endTime: market.endTime,
      mode: 'paper',
      strategyKind: signal.strategyKind,
      takeProfitPrice: computeTakeProfitPrice(this.config, market, ask, signal),
      exitFloorPrice: ask * (1 + this.config.forceExitMinRoi),
      minHoldUntil: now + this.config.minHoldSec * 1000,
      entryEdge: signal.edge,
      entryLag: signal.marketLag,
      entryImpliedProb: signal.impliedProb,
    };
    this.paperBalance -= signal.stake;
    this.openPositions.set(position.conditionId, position);
    this.signalCount += 1;
  }

  private manageOpenPositions(coin: Coin, now: number): void {
    for (const position of [...this.openPositions.values()].filter((item) => item.coin === coin)) {
      if (now >= position.endTime) continue;
      if ((position.minHoldUntil || 0) > now) continue;
      const strategy = this.config.strategyProfiles[position.duration];
      const book = this.orderbooks.get(position.tokenId);
      if (!book || now - book.timestamp > strategy.maxBookAgeMs || book.bestBid <= 0) continue;
      const spot = this.binance.get(position.coin);
      const currentDeltaBps = spot && spot.price > 0 ? toBps(spot.price, position.baseline) : null;
      const currentWinner = currentDeltaBps == null ? null : currentDeltaBps > 0 ? 'UP' : currentDeltaBps < 0 ? 'DOWN' : null;
      const timeRemainingSec = (position.endTime - now) / 1000;
      const hitTakeProfit = position.takeProfitPrice != null && book.bestBid >= position.takeProfitPrice;
      const lateExitPrice = computeLateExitPrice(position, timeRemainingSec, this.config.forceExitSec, this.config.forceExitMinRoi);
      const hardExit = this.config.hardExitSec > 0
        && timeRemainingSec <= this.config.hardExitSec
        && currentWinner != null
        && currentWinner !== position.side
        && book.bestBid < position.entryPrice;
      const shouldExit = hitTakeProfit || hardExit || (lateExitPrice != null && book.bestBid >= lateExitPrice);
      if (!shouldExit) continue;
      const reason = hitTakeProfit
        ? 'take_profit'
        : hardExit
          ? book.bestBid >= position.entryPrice ? 'expiry_profit_exit' : 'expiry_defensive_exit'
          : lateExitPrice != null && lateExitPrice >= position.entryPrice
            ? 'late_profit_exit'
            : 'late_defensive_exit';
      this.closePosition(position, book.bestBid, reason, now);
    }
  }

  private manageOpenPositionsByToken(tokenId: string, now: number): void {
    for (const position of [...this.openPositions.values()].filter((item) => item.tokenId === tokenId)) {
      this.manageOpenPositions(position.coin, now);
    }
  }

  private settleExpired(now: number): void {
    for (const position of [...this.openPositions.values()]) {
      if (now < position.endTime) continue;
      const winner = this.currentWinner(position.coin, position.baseline, position.endTime);
      if (!winner) continue;
      this.settlePosition(position, winner === position.side ? 1 : 0);
    }
  }

  private currentWinner(coin: Coin, baseline: number, notBeforeTs: number): Side | null {
    const spot = this.binance.get(coin);
    if (!spot || spot.timestamp < notBeforeTs) return null;
    const delta = toBps(spot.price, baseline);
    if (delta > 0) return 'UP';
    if (delta < 0) return 'DOWN';
    return null;
  }

  private closePosition(position: OpenPosition, exitPrice: number, reason: string, now: number): void {
    const payout = position.shares * exitPrice;
    const realizedPnl = payout - position.stake;
    this.paperBalance += payout;
    this.openPositions.delete(position.conditionId);
    this.closedTrades.push({
      ...position,
      payout,
      realizedPnl,
      exitPrice,
      settledAt: now,
      closedBy: 'intraday',
      closeReason: reason,
    });
  }

  private settlePosition(position: OpenPosition, payoutPerShare: number): void {
    const payout = position.shares * payoutPerShare;
    const realizedPnl = payout - position.stake;
    this.paperBalance += payout;
    this.openPositions.delete(position.conditionId);
    this.closedTrades.push({
      ...position,
      payout,
      realizedPnl,
      exitPrice: payoutPerShare,
      settledAt: position.endTime,
      closedBy: 'settlement',
      closeReason: 'settled',
    });
  }

  private getBinancePulseBps(coin: Coin): number {
    const history = this.binanceHistory.get(coin);
    const latest = this.binance.get(coin);
    if (!history || history.length === 0 || !latest) return 0;
    const targetTs = latest.timestamp - this.config.binanceLookbackMs;
    let reference = history[0];
    for (const tick of history) {
      if (tick.timestamp <= targetTs) reference = tick;
      else break;
    }
    if (reference.price <= 0) return 0;
    return ((latest.price - reference.price) / reference.price) * 10_000;
  }

  private getBinanceTrendBps(coin: Coin): number {
    const history = this.binanceHistory.get(coin);
    const latest = this.binance.get(coin);
    if (!history || history.length === 0 || !latest) return 0;
    const targetTs = latest.timestamp - this.config.trendLookbackMs;
    let reference = history[0];
    for (const tick of history) {
      if (tick.timestamp <= targetTs) reference = tick;
      else break;
    }
    if (reference.price <= 0) return 0;
    return ((latest.price - reference.price) / reference.price) * 10_000;
  }
}

async function main(): Promise<void> {
  const filePath = resolveFilePath(process.argv.slice(2));
  const backtester = new StrictBacktester(config);
  let hasBookTop = false;
  let hasBinancePrice = false;
  const input = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as TapeEvent;
    if (event.type === 'book_top') hasBookTop = true;
    if (event.type === 'binance_price') hasBinancePrice = true;
    backtester.process(event);
  }
  if (!hasBookTop || !hasBinancePrice) {
    throw new Error('No collector tape events found. Use a file produced by `npm run collect-market-data`.');
  }
  backtester.finish();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ file: filePath, ...backtester.getSummary() }, null, 2));
  } else {
    backtester.printSummary(filePath);
  }
}

function resolveFilePath(args: string[]): string {
  const fileArg = args.find((arg) => arg.startsWith('--file='));
  const raw = fileArg ? fileArg.slice('--file='.length) : args[0];
  if (!raw) throw new Error('Usage: npm run backtest-run -- --file=/path/to/tape.jsonl');
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  return resolved;
}

function summarize<T>(items: T[], keyFn: (item: T) => string): string[] {
  const groups = new Map<string, { n: number; pnl: number }>();
  for (const item of items) {
    const key = keyFn(item);
    const current = groups.get(key) || { n: 0, pnl: 0 };
    current.n += 1;
    current.pnl += (item as ClosedTrade).realizedPnl || 0;
    groups.set(key, current);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .map(([key, value]) => `${key} n=${value.n} pnl=${value.pnl.toFixed(3)}`);
}

const config = loadConfig();

main().catch((error) => {
  console.error('Backtest failed:', error);
  process.exit(1);
});
