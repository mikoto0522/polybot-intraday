import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, type StrategyProfile } from './config.js';
import type { Coin, Duration, Side } from './types.js';

type Json = Record<string, unknown>;

interface ReplayEvent<T = Json> {
  ts: number;
  type: string;
  payload: T;
}

interface EntryPayload {
  conditionId: string;
  slug: string;
  side: 'UP' | 'DOWN';
  score: number;
  ask: number;
  stake: number;
  shares: number;
  edge: number;
  marketLag: number;
  impliedProb?: number;
  marketMid?: number;
  binanceDeltaBps?: number;
  binancePulseBps?: number;
  leadGapBps?: number;
  macroTrendBps?: number;
}

interface ExitPayload {
  conditionId: string;
  side?: 'UP' | 'DOWN';
  stake: number;
  shares: number;
  realizedPnl: number;
  payout: number;
  reason?: string;
}

interface SignalPayload {
  conditionId: string;
  slug: string;
  coin: Coin;
  duration: Duration;
  side: Side;
  score: number;
  ask: number;
  spread: number;
  edge: number;
  marketLag: number;
  chainlinkDeltaBps: number;
  binanceDeltaBps: number;
  binancePulseBps: number;
  leadGapBps: number;
  macroTrendBps: number;
  [key: string]: unknown;
}

interface ClosedTrade extends EntryPayload, Omit<ExitPayload, 'side'> {
  coin: string;
  closeType: string;
  closeReason: string;
}

function main(): void {
  const filePath = resolveInputPath(process.argv.slice(2));
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean);
  const entries = new Map<string, EntryPayload>();
  const closed: ClosedTrade[] = [];
  const signals: SignalPayload[] = [];
  const rejects: Json[] = [];
  let runStart: Json | null = null;

  for (const line of lines) {
    const event = JSON.parse(line) as ReplayEvent;
    if (event.type === 'run_start') {
      runStart = event.payload;
      continue;
    }
    if (event.type === 'signal') {
      signals.push(event.payload as unknown as SignalPayload);
      continue;
    }
    if (event.type === 'signal_reject') {
      rejects.push(event.payload);
      continue;
    }
    if (event.type === 'entry_paper' || event.type === 'entry_live') {
      const payload = event.payload as unknown as EntryPayload;
      entries.set(payload.conditionId, payload);
      continue;
    }
    if (event.type === 'exit_paper' || event.type === 'exit_live' || event.type === 'settled') {
      const payload = event.payload as unknown as ExitPayload;
      const entry = entries.get(payload.conditionId);
      if (!entry) continue;
      const closeReason = payload.reason || 'settled';
      closed.push({
        ...entry,
        ...payload,
        coin: inferCoin(entry.slug),
        closeType: event.type,
        closeReason,
      });
      entries.delete(payload.conditionId);
    }
  }

  printHeader(filePath, runStart);
  printSummary(closed, signals, rejects);
  printBreakdown('By Coin', closed, (trade) => trade.coin);
  printBreakdown('By Side', closed, (trade) => trade.side);
  printBreakdown('By Close Reason', closed, (trade) => trade.closeReason);
  printAskBuckets(closed);
  printScoreBuckets(closed);
  printParamSimulation(closed, signals);
  printWorstBest(closed);
  printHeuristics(closed, signals);
}

function resolveInputPath(args: string[]): string {
  const fileArg = args.find((arg) => arg.startsWith('--file='));
  const raw = fileArg ? fileArg.slice('--file='.length) : args[0];
  if (!raw) {
    throw new Error('Usage: npm run analyze-run -- --file="C:\\path\\to\\run.jsonl"');
  }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return resolved;
}

function printHeader(filePath: string, runStart: Json | null): void {
  console.log('=== Replay Analysis ===');
  console.log(`File: ${filePath}`);
  if (!runStart) {
    console.log('Run start: missing');
    console.log('');
    return;
  }
  const mode = String(runStart.mode || 'unknown');
  const budget = formatNumber(runStart.budget);
  const durations = Array.isArray(runStart.durations) ? runStart.durations.join(',') : 'unknown';
  const coins = Array.isArray(runStart.coins) ? runStart.coins.join(',') : 'unknown';
  console.log(`Mode: ${mode} | Budget: ${budget} | Coins: ${coins} | Durations: ${durations}`);
  console.log('');
}

function printSummary(closed: ClosedTrade[], signals: SignalPayload[], rejects: Json[]): void {
  const pnl = sum(closed.map((trade) => trade.realizedPnl));
  const settledLoss = sum(closed.filter((trade) => trade.closeReason === 'settled').map((trade) => trade.realizedPnl));
  const takeProfitPnl = sum(closed.filter((trade) => trade.closeReason === 'take_profit').map((trade) => trade.realizedPnl));
  console.log('Summary');
  console.log(`Trades: ${closed.length} | Signals: ${signals.length} | Rejects: ${rejects.length}`);
  console.log(`PnL: ${pnl.toFixed(3)} | Wins: ${count(closed, (trade) => trade.realizedPnl > 0)} | Losses: ${count(closed, (trade) => trade.realizedPnl < 0)}`);
  console.log(`Take-profit PnL: ${takeProfitPnl.toFixed(3)} | Settled PnL: ${settledLoss.toFixed(3)}`);
  console.log('');
}

function printBreakdown(title: string, closed: ClosedTrade[], keyFn: (trade: ClosedTrade) => string): void {
  console.log(title);
  const groups = groupBy(closed, keyFn);
  for (const [key, trades] of [...groups.entries()].sort((a, b) => sum(b[1].map((trade) => trade.realizedPnl)) - sum(a[1].map((trade) => trade.realizedPnl)))) {
    const pnl = sum(trades.map((trade) => trade.realizedPnl));
    console.log(`${pad(key, 16)} n=${String(trades.length).padStart(2)} pnl=${pnl.toFixed(3).padStart(8)} winrate=${ratio(count(trades, (trade) => trade.realizedPnl > 0), trades.length)}`);
  }
  console.log('');
}

function printAskBuckets(closed: ClosedTrade[]): void {
  console.log('Ask Buckets');
  const buckets: Array<[number, number]> = [
    [0, 0.45],
    [0.45, 0.55],
    [0.55, 0.65],
    [0.65, 1],
  ];
  for (const [low, high] of buckets) {
    const trades = closed.filter((trade) => trade.ask > low && trade.ask <= high);
    if (trades.length === 0) continue;
    const pnl = sum(trades.map((trade) => trade.realizedPnl));
    const settled = count(trades, (trade) => trade.closeReason === 'settled');
    console.log(`(${low.toFixed(2)}, ${high.toFixed(2)}] n=${String(trades.length).padStart(2)} pnl=${pnl.toFixed(3).padStart(8)} settled=${settled}`);
  }
  console.log('');
}

function printScoreBuckets(closed: ClosedTrade[]): void {
  console.log('Score Quartiles');
  const sorted = [...closed].sort((a, b) => a.score - b.score);
  for (let index = 0; index < 4; index += 1) {
    const start = Math.floor((sorted.length * index) / 4);
    const end = Math.floor((sorted.length * (index + 1)) / 4);
    const trades = sorted.slice(start, end);
    if (trades.length === 0) continue;
    const pnl = sum(trades.map((trade) => trade.realizedPnl));
    console.log(`${trades[0].score.toFixed(2)}..${trades[trades.length - 1].score.toFixed(2)} n=${String(trades.length).padStart(2)} pnl=${pnl.toFixed(3).padStart(8)}`);
  }
  console.log('');
}

function printWorstBest(closed: ClosedTrade[]): void {
  const sorted = [...closed].sort((a, b) => a.realizedPnl - b.realizedPnl);
  console.log('Worst 5');
  for (const trade of sorted.slice(0, 5)) {
    console.log(`${trade.slug} ${trade.side} ask=${trade.ask.toFixed(3)} edge=${trade.edge.toFixed(3)} lag=${trade.marketLag.toFixed(3)} close=${trade.closeReason} pnl=${trade.realizedPnl.toFixed(3)}`);
  }
  console.log('');
  console.log('Best 5');
  for (const trade of sorted.slice(-5)) {
    console.log(`${trade.slug} ${trade.side} ask=${trade.ask.toFixed(3)} edge=${trade.edge.toFixed(3)} lag=${trade.marketLag.toFixed(3)} close=${trade.closeReason} pnl=${trade.realizedPnl.toFixed(3)}`);
  }
  console.log('');
}

function printParamSimulation(closed: ClosedTrade[], signals: SignalPayload[]): void {
  const config = loadConfig();
  const simulatedSignals = signals.filter((signal) => passesCurrentConfig(signal, config.strategyProfiles[signal.duration], config.trendBiasBps));
  const simulatedConditionIds = new Set(simulatedSignals.map((signal) => signal.conditionId));
  const keptTrades = closed.filter((trade) => simulatedConditionIds.has(trade.conditionId));
  const keptDown = simulatedSignals.filter((signal) => signal.side === 'DOWN').length;
  const keptUp = simulatedSignals.filter((signal) => signal.side === 'UP').length;

  console.log('Current Param Simulation');
  console.log(`Accepted old signals under current params: ${simulatedSignals.length}/${signals.length}`);
  console.log(`Simulated side mix: UP=${keptUp} DOWN=${keptDown}`);
  console.log(`Simulated kept-trade PnL: ${sum(keptTrades.map((trade) => trade.realizedPnl)).toFixed(3)}`);
  console.log('');
}

function printHeuristics(closed: ClosedTrade[], signals: SignalPayload[]): void {
  console.log('Heuristics');
  const highAsk = closed.filter((trade) => trade.ask > 0.65);
  const highAskPnl = sum(highAsk.map((trade) => trade.realizedPnl));
  const settled = closed.filter((trade) => trade.closeReason === 'settled');
  const downSignals = signals.filter((signal) => signal.side === 'DOWN').length;
  const signalCount = signals.length || 1;
  if (highAsk.length > 0) {
    console.log(`High-ask trades (>0.65): n=${highAsk.length}, pnl=${highAskPnl.toFixed(3)}.`);
  }
  if (settled.length > 0) {
    console.log(`Settled trades: n=${settled.length}, pnl=${sum(settled.map((trade) => trade.realizedPnl)).toFixed(3)}.`);
  }
  console.log(`DOWN signal share: ${(downSignals / signalCount * 100).toFixed(1)}%.`);

  const recommendations: string[] = [];
  if (highAskPnl < -5) recommendations.push('Tighten 5m UP maxAsk; high-price entries are a major loss source.');
  if (sum(settled.map((trade) => trade.realizedPnl)) < -10) recommendations.push('Lower take-profit targets and keep late-exit logic aggressive; too many positions reach settlement.');
  if ((downSignals / signalCount) < 0.15) recommendations.push('Bias direction selection harder toward DOWN in negative trend regimes.');
  if (recommendations.length === 0) recommendations.push('No strong single-parameter failure mode detected from this run.');

  for (const recommendation of recommendations) {
    console.log(`- ${recommendation}`);
  }
  console.log('');
}

function inferCoin(slug: string): string {
  return slug.split('-')[0]?.toUpperCase() || 'UNKNOWN';
}

function passesCurrentConfig(signal: SignalPayload, baseStrategy: StrategyProfile, trendBiasBps: number): boolean {
  const strategy = applyCoinStrategyAdjustments(baseStrategy, signal.coin, signal.duration);
  const chosenSide = chooseDirection(
    signal.binanceDeltaBps,
    signal.chainlinkDeltaBps,
    signal.binancePulseBps,
    strategy,
    signal.macroTrendBps,
    trendBiasBps,
  );
  if (chosenSide !== signal.side) return false;
  if (getCoinSideRejectReason(signal.coin, signal.duration, signal.side, signal.binancePulseBps, signal.chainlinkDeltaBps, signal.macroTrendBps)) {
    return false;
  }
  const sideStrategy = applyTrendToSideStrategy(strategy.sides[signal.side], signal.side, signal.macroTrendBps, trendBiasBps);

  const binanceSign = signal.side === 'UP' ? 1 : -1;
  const chainSign = Math.sign(signal.chainlinkDeltaBps);
  if (chainSign !== 0 && chainSign !== binanceSign && Math.abs(signal.chainlinkDeltaBps) >= sideStrategy.chainlinkOpposeBps) {
    return false;
  }

  if (Math.abs(signal.binancePulseBps) < sideStrategy.minBinancePulseBps) return false;
  if (signal.leadGapBps < sideStrategy.minLeadGapBps) return false;
  if (signal.ask <= 0 || signal.ask > sideStrategy.maxAsk) return false;
  if (signal.marketLag < sideStrategy.minMarketLag) return false;
  if (signal.edge < sideStrategy.minEdge) return false;

  return true;
}

function getCoinSideRejectReason(
  coin: Coin,
  duration: Duration,
  side: Side,
  binancePulseBps: number,
  chainlinkDeltaBps: number,
  macroTrendBps: number,
): string | null {
  if (coin === 'ETH' && duration === '5m' && side === 'UP') {
    if (binancePulseBps <= 0) return 'eth_up_pulse_negative';
    if (chainlinkDeltaBps < 0 && macroTrendBps < 18) return 'eth_up_needs_trend_confirmation';
    if (macroTrendBps <= -12 && (chainlinkDeltaBps < 3 || binancePulseBps < 2.2)) {
      return 'eth_up_countertrend_too_weak';
    }
  }
  return null;
}

function applyCoinStrategyAdjustments(strategy: StrategyProfile, coin: Coin, duration: Duration): StrategyProfile {
  const up = { ...strategy.sides.UP };
  const down = { ...strategy.sides.DOWN };

  if (coin === 'BTC') {
    up.binanceTriggerBps += duration === '5m' ? 0.25 : 0.2;
    up.minBinancePulseBps += duration === '5m' ? 0.08 : 0.1;
    up.minLeadGapBps += duration === '5m' ? 0.05 : 0.06;
    up.minEdge += duration === '5m' ? 0.015 : 0.006;
    up.minMarketLag += duration === '5m' ? 0.004 : 0.0015;
    up.maxAsk = Math.max(0.55, up.maxAsk - (duration === '5m' ? 0.05 : 0.03));
  }

  if (coin === 'ETH') {
    up.binanceTriggerBps += duration === '5m' ? 0.55 : 0.5;
    up.minBinancePulseBps += duration === '5m' ? 0.22 : 0.24;
    up.minLeadGapBps += duration === '5m' ? 0.14 : 0.14;
    up.minEdge += duration === '5m' ? 0.012 : 0.008;
    up.minMarketLag += duration === '5m' ? 0.006 : 0.004;
    up.maxAsk = Math.max(0.48, up.maxAsk - (duration === '5m' ? 0.12 : 0.06));
  }

  return {
    ...strategy,
    sides: {
      UP: up,
      DOWN: down,
    },
  };
}

function applyTrendToSideStrategy(sideStrategy: StrategyProfile['sides'][Side], side: Side, macroTrendBps: number, trendBiasBps: number): StrategyProfile['sides'][Side] {
  const adjusted = { ...sideStrategy };
  if (macroTrendBps <= -trendBiasBps) {
    if (side === 'UP') {
      adjusted.binanceTriggerBps += 0.45;
      adjusted.minBinancePulseBps += 0.15;
      adjusted.minLeadGapBps += 0.1;
      adjusted.minEdge += 0.006;
      adjusted.minMarketLag += 0.003;
      adjusted.maxAsk = Math.max(0.5, adjusted.maxAsk - 0.04);
    } else {
      adjusted.binanceTriggerBps = Math.max(0.55, adjusted.binanceTriggerBps - 0.2);
      adjusted.minBinancePulseBps = Math.max(0.14, adjusted.minBinancePulseBps - 0.08);
      adjusted.minLeadGapBps = Math.max(0.06, adjusted.minLeadGapBps - 0.06);
      adjusted.minEdge = Math.max(0.006, adjusted.minEdge - 0.003);
      adjusted.minMarketLag = Math.max(0.002, adjusted.minMarketLag - 0.0015);
      adjusted.maxAsk = Math.min(0.82, adjusted.maxAsk + 0.01);
    }
  } else if (macroTrendBps >= trendBiasBps) {
    if (side === 'DOWN') {
      adjusted.binanceTriggerBps += 0.3;
      adjusted.minBinancePulseBps += 0.1;
      adjusted.minLeadGapBps += 0.08;
      adjusted.minEdge += 0.003;
      adjusted.minMarketLag += 0.0015;
      adjusted.maxAsk = Math.max(0.5, adjusted.maxAsk - 0.02);
    }
  }
  return adjusted;
}

function chooseDirection(
  binanceDeltaBps: number,
  chainlinkDeltaBps: number,
  binancePulseBps: number,
  strategy: StrategyProfile,
  macroTrendBps: number,
  trendBiasBps: number,
): Side | null {
  const upStrategy = applyTrendToSideStrategy(strategy.sides.UP, 'UP', macroTrendBps, trendBiasBps);
  const downStrategy = applyTrendToSideStrategy(strategy.sides.DOWN, 'DOWN', macroTrendBps, trendBiasBps);
  const trendAssistBps = clamp(macroTrendBps * 0.22, -1.6, 1.6);
  const pulseAssistBps = clamp(binancePulseBps * 0.8, -1.2, 1.2);
  const chainAssistBps = clamp(chainlinkDeltaBps * 0.3, -0.8, 0.8);
  const adjustedDeltaBps = binanceDeltaBps + trendAssistBps + pulseAssistBps + chainAssistBps;
  const upMargin = adjustedDeltaBps - upStrategy.binanceTriggerBps;
  const downMargin = -adjustedDeltaBps - downStrategy.binanceTriggerBps;
  let direction: Side | null = null;
  if (upMargin >= 0 || downMargin >= 0) {
    direction = upMargin >= downMargin ? 'UP' : 'DOWN';
  } else {
    return null;
  }

  const binanceSign = direction === 'UP' ? 1 : -1;
  const chainSign = Math.sign(chainlinkDeltaBps);
  const sideStrategy = direction === 'UP' ? upStrategy : downStrategy;
  if (chainSign !== 0 && chainSign !== binanceSign && Math.abs(chainlinkDeltaBps) >= sideStrategy.chainlinkOpposeBps) {
    return null;
  }

  if (macroTrendBps <= -trendBiasBps && direction === 'UP') {
    const extraImpulseBps = Math.min(1.2, Math.abs(macroTrendBps) * 0.08);
    const strongBounce = binanceDeltaBps >= upStrategy.binanceTriggerBps + extraImpulseBps;
    if (!strongBounce || binancePulseBps <= 0) return null;
  }
  if (macroTrendBps >= trendBiasBps && direction === 'DOWN') {
    const extraImpulseBps = Math.min(1.2, Math.abs(macroTrendBps) * 0.08);
    const strongDump = binanceDeltaBps <= -(downStrategy.binanceTriggerBps + extraImpulseBps);
    if (!strongDump || binancePulseBps >= 0) return null;
  }

  return direction;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function count<T>(items: T[], predicate: (item: T) => boolean): number {
  let total = 0;
  for (const item of items) {
    if (predicate(item)) total += 1;
  }
  return total;
}

function ratio(numerator: number, denominator: number): string {
  if (denominator <= 0) return 'n/a';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

function formatNumber(value: unknown): string {
  return typeof value === 'number' ? value.toFixed(2) : String(value ?? 'n/a');
}

main();
