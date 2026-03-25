import type { StrategyProfile } from './config.js';
import type { Coin, Duration, OpenPosition, Side, SignalCandidate, TokenBook, TrackedMarket } from './types.js';

export interface SignalInput {
  market: TrackedMarket;
  strategy: StrategyProfile;
  upBook: TokenBook;
  downBook: TokenBook;
  baseline: number;
  timeRemainingSec: number;
  binanceDeltaBps: number;
  chainlinkDeltaBps: number;
  chainAvailable: boolean;
  binancePulseBps: number;
  macroTrendBps: number;
  stake?: number;
  maxBookAgeMs?: number;
}

export interface SignalFailure {
  reason: string;
  details: Record<string, unknown>;
}

export interface LotterySignalConfig {
  enabled: boolean;
  budget: number;
  closeWindowSec: number;
  minSignalAsk: number;
  maxSignalAsk: number;
  minEdge: number;
  minLag: number;
  minScore: number;
  minPulseBps: number;
  minTrendBps: number;
  minBinanceDeltaBps: number;
  minLeadGapBps: number;
  maxTopBookValue: number;
  maxSpread: number;
}

export function evaluateSignal(input: SignalInput, trendBiasBps: number): { signal: SignalCandidate; sideStrategy: StrategyProfile['sides'][Side] } | { failure: SignalFailure } {
  const {
    market,
    strategy,
    upBook,
    downBook,
    baseline,
    timeRemainingSec,
    binanceDeltaBps,
    chainlinkDeltaBps,
    chainAvailable,
    binancePulseBps,
    macroTrendBps,
    stake,
  } = input;

  const direction = chooseDirection(
    binanceDeltaBps,
    chainlinkDeltaBps,
    binancePulseBps,
    strategy,
    macroTrendBps,
    trendBiasBps,
  );
  if (!direction) {
    return { failure: { reason: 'direction_rejected', details: { binanceDeltaBps, chainlinkDeltaBps, binancePulseBps, macroTrendBps } } };
  }
  const sideStrategy = applyTrendToSideStrategy(strategy.sides[direction], direction, macroTrendBps, trendBiasBps);
  if (Math.abs(binancePulseBps) < sideStrategy.minBinancePulseBps) {
    return { failure: { reason: 'binance_pulse_too_small', details: { side: direction, binancePulseBps } } };
  }
  const leadGapBps = Math.abs(binanceDeltaBps - chainlinkDeltaBps);
  if (leadGapBps < sideStrategy.minLeadGapBps) {
    return { failure: { reason: 'lead_gap_too_small', details: { side: direction, leadGapBps } } };
  }
  const coinSideRejectReason = getCoinSideRejectReason(
    market.coin,
    market.duration,
    direction,
    binancePulseBps,
    chainlinkDeltaBps,
    macroTrendBps,
  );
  if (coinSideRejectReason) {
    return { failure: { reason: coinSideRejectReason, details: { side: direction, binancePulseBps, chainlinkDeltaBps, macroTrendBps } } };
  }

  const askBook = direction === 'UP' ? upBook : downBook;
  const ask = askBook.bestAsk;
  const topBookValue = askBook.askSize * ask;
  if (topBookValue < strategy.minTopBookValue) {
    return { failure: { reason: 'top_book_value_too_small', details: { topBookValue } } };
  }
  if (askBook.spread > strategy.maxSpread) {
    return { failure: { reason: 'spread_too_wide', details: { spread: askBook.spread } } };
  }
  if (ask <= 0 || ask > sideStrategy.maxAsk) {
    return { failure: { reason: 'ask_out_of_range', details: { side: direction, ask } } };
  }
  const coinBookRejectReason = getCoinBookRejectReason(market.coin, market.duration, direction, ask, askBook.spread, topBookValue);
  if (coinBookRejectReason) {
    return { failure: { reason: coinBookRejectReason, details: { side: direction, ask, spread: askBook.spread, topBookValue } } };
  }

  const chainAligned = !chainAvailable || Math.sign(chainlinkDeltaBps) === 0 || Math.sign(chainlinkDeltaBps) === Math.sign(binanceDeltaBps);
  const anchorBonusBps = chainAligned ? Math.min(Math.abs(chainlinkDeltaBps), strategy.chainlinkConfirmBps * 2) : 0;
  const pulseBonus = Math.abs(binancePulseBps) * 0.9;
  const strengthBps = Math.abs(binanceDeltaBps) + leadGapBps * 0.7 + anchorBonusBps * 0.4 + pulseBonus;
  const certainty = clamp(1 - (timeRemainingSec / strategy.closeWindowSec), 0.2, 1);
  const impliedProb = clamp(0.5 + (strengthBps / strategy.fairScaleBps) * 0.47 * certainty, 0.5, 0.97);
  const oppositeBid = direction === 'UP' ? downBook.bestBid : upBook.bestBid;
  const marketMid = clamp((ask + (1 - oppositeBid)) / 2, 0, 1);
  const marketLag = impliedProb - marketMid;
  const edge = impliedProb - ask - strategy.executionBuffer;
  if (marketLag < sideStrategy.minMarketLag) {
    return { failure: { reason: 'market_lag_too_small', details: { side: direction, marketLag, impliedProb, marketMid } } };
  }
  if (edge < sideStrategy.minEdge) {
    return { failure: { reason: 'edge_too_small', details: { side: direction, edge, impliedProb, ask } } };
  }

  const score = edge * 100
    + marketLag * 60
    + Math.abs(binancePulseBps) * 1.2
    + leadGapBps * 1.1
    + topBookValue * 0.02
    - askBook.spread * 30
    - ask * 4;
  const coinSignalQualityRejectReason = getCoinSignalQualityRejectReason(
    market.coin,
    market.duration,
    direction,
    score,
    edge,
  );
  if (coinSignalQualityRejectReason) {
    return { failure: { reason: coinSignalQualityRejectReason, details: { side: direction, score, edge, topBookValue } } };
  }

  return {
    signal: {
      strategyKind: 'main',
      stake: stake ?? 0,
      side: direction,
      score,
      ask,
      askSize: askBook.askSize,
      spread: askBook.spread,
      impliedProb,
      edge,
      marketMid,
      marketLag,
      chainlinkDeltaBps,
      chainAvailable,
      binanceDeltaBps,
      binancePulseBps,
      leadGapBps,
      marketToDecisionMs: 0,
    },
    sideStrategy,
  };
}

export function evaluateLotterySignal(
  input: SignalInput,
  config: LotterySignalConfig,
): { signal: SignalCandidate } | { failure: SignalFailure } {
  const {
    market,
    strategy,
    upBook,
    downBook,
    timeRemainingSec,
    binanceDeltaBps,
    chainlinkDeltaBps,
    chainAvailable,
    binancePulseBps,
    macroTrendBps,
    stake,
  } = input;

  if (!config.enabled) {
    return { failure: { reason: 'lottery_disabled', details: {} } };
  }
  if (market.duration !== '5m') {
    return { failure: { reason: 'lottery_duration_unsupported', details: { duration: market.duration } } };
  }
  if (timeRemainingSec > config.closeWindowSec || timeRemainingSec <= 1) {
    return { failure: { reason: 'lottery_window_miss', details: { timeRemainingSec } } };
  }
  if (binanceDeltaBps < config.minBinanceDeltaBps) {
    return { failure: { reason: 'lottery_binance_delta_too_small', details: { binanceDeltaBps } } };
  }
  if (binancePulseBps < config.minPulseBps) {
    return { failure: { reason: 'lottery_pulse_too_small', details: { binancePulseBps } } };
  }
  if (macroTrendBps < config.minTrendBps) {
    return { failure: { reason: 'lottery_trend_too_small', details: { macroTrendBps } } };
  }

  const ask = upBook.bestAsk;
  const topBookValue = upBook.askSize * ask;
  if (ask < config.minSignalAsk || ask > config.maxSignalAsk) {
    return { failure: { reason: 'lottery_signal_ask_out_of_range', details: { ask } } };
  }
  if (upBook.spread > config.maxSpread) {
    return { failure: { reason: 'lottery_spread_too_wide', details: { spread: upBook.spread } } };
  }
  if (topBookValue <= 0 || topBookValue > config.maxTopBookValue) {
    return { failure: { reason: 'lottery_top_book_out_of_range', details: { topBookValue } } };
  }

  const leadGapBps = Math.abs(binanceDeltaBps - chainlinkDeltaBps);
  if (leadGapBps < config.minLeadGapBps) {
    return { failure: { reason: 'lottery_lead_gap_too_small', details: { leadGapBps } } };
  }

  const chainAligned = !chainAvailable || Math.sign(chainlinkDeltaBps) >= 0;
  const anchorBonusBps = chainAligned ? Math.min(Math.abs(chainlinkDeltaBps), strategy.chainlinkConfirmBps * 2) : 0;
  const pulseBonus = Math.abs(binancePulseBps) * 0.9;
  const strengthBps = Math.abs(binanceDeltaBps) + leadGapBps * 0.7 + anchorBonusBps * 0.4 + pulseBonus;
  const certainty = clamp(1 - (timeRemainingSec / strategy.closeWindowSec), 0.2, 1);
  const impliedProb = clamp(0.5 + (strengthBps / strategy.fairScaleBps) * 0.47 * certainty, 0.5, 0.97);
  const oppositeBid = downBook.bestBid;
  const marketMid = clamp((ask + (1 - oppositeBid)) / 2, 0, 1);
  const marketLag = impliedProb - marketMid;
  const edge = impliedProb - ask - strategy.executionBuffer;
  if (marketLag < config.minLag) {
    return { failure: { reason: 'lottery_market_lag_too_small', details: { marketLag, impliedProb, marketMid } } };
  }
  if (edge < config.minEdge) {
    return { failure: { reason: 'lottery_edge_too_small', details: { edge, impliedProb, ask } } };
  }

  const score = edge * 100
    + marketLag * 60
    + Math.abs(binancePulseBps) * 1.2
    + leadGapBps * 1.1
    + topBookValue * 0.02
    - upBook.spread * 30
    - ask * 4;
  if (score < config.minScore) {
    return { failure: { reason: 'lottery_score_too_small', details: { score } } };
  }

  return {
    signal: {
      strategyKind: 'lottery',
      stake: stake ?? config.budget,
      side: 'UP',
      score,
      ask,
      askSize: upBook.askSize,
      spread: upBook.spread,
      impliedProb,
      edge,
      marketMid,
      marketLag,
      chainlinkDeltaBps,
      chainAvailable,
      binanceDeltaBps,
      binancePulseBps,
      leadGapBps,
      marketToDecisionMs: 0,
    },
  };
}

export function computeTakeProfitPrice(config: { takeProfitMinPriceDelta: number; takeProfitEdgeFactor: number; takeProfitLagFactor: number }, market: TrackedMarket, entryPrice: number, signal: SignalCandidate): number {
  let delta = Math.max(
    config.takeProfitMinPriceDelta,
    signal.edge * config.takeProfitEdgeFactor,
    signal.marketLag * config.takeProfitLagFactor,
  );
  if (market.coin === 'ETH' && market.duration === '5m' && signal.side === 'UP') {
    delta = Math.min(0.09, Math.max(config.takeProfitMinPriceDelta, delta * 0.55));
  }
  return clamp(entryPrice + delta, Math.min(0.99, entryPrice + 0.01), 0.97);
}

export function computeLateExitPrice(position: OpenPosition, timeRemainingSec: number, forceExitSec: number, forceExitMinRoi: number): number | null {
  if (timeRemainingSec > forceExitSec) return null;
  const urgency = clamp(1 - (timeRemainingSec / Math.max(forceExitSec, 1)), 0, 1);
  const maxLossRoi = Math.min(
    0.08,
    Math.max(
      0.025,
      (position.entryEdge || 0) * 0.7 + (position.entryLag || 0) * 0.35,
    ),
  );
  const targetRoi = forceExitMinRoi * (1 - urgency) - maxLossRoi * urgency;
  return clamp(position.entryPrice * (1 + targetRoi), 0.01, 0.99);
}

export function applyCoinStrategyAdjustments(strategy: StrategyProfile, coin: Coin, duration: Duration): StrategyProfile {
  const up = { ...strategy.sides.UP };
  const down = { ...strategy.sides.DOWN };

  if (coin === 'BTC') {
    up.binanceTriggerBps += duration === '5m' ? 0.25 : 0.2;
    up.minBinancePulseBps += duration === '5m' ? 0.08 : 0.1;
    up.minLeadGapBps += duration === '5m' ? 0.05 : 0.06;
    up.minEdge += duration === '5m' ? 0.015 : 0.006;
    up.minMarketLag += duration === '5m' ? 0.004 : 0.0015;
    up.maxAsk = Math.max(0.5, up.maxAsk - (duration === '5m' ? 0.1 : 0.03));
  }

  if (coin === 'ETH') {
    up.binanceTriggerBps += duration === '5m' ? 0.55 : 0.5;
    up.minBinancePulseBps += duration === '5m' ? 0.22 : 0.24;
    up.minLeadGapBps += duration === '5m' ? 0.14 : 0.14;
    up.minEdge += duration === '5m' ? 0.012 : 0.008;
    up.minMarketLag += duration === '5m' ? 0.006 : 0.004;
    up.maxAsk = Math.max(0.45, up.maxAsk - (duration === '5m' ? 0.2 : 0.06));
  }

  return { ...strategy, sides: { UP: up, DOWN: down } };
}

export function applyTrendToSideStrategy(sideStrategy: StrategyProfile['sides'][Side], side: Side, macroTrendBps: number, trendBiasBps: number): StrategyProfile['sides'][Side] {
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
  } else if (macroTrendBps >= trendBiasBps && side === 'DOWN') {
    adjusted.binanceTriggerBps += 0.3;
    adjusted.minBinancePulseBps += 0.1;
    adjusted.minLeadGapBps += 0.08;
    adjusted.minEdge += 0.003;
    adjusted.minMarketLag += 0.0015;
    adjusted.maxAsk = Math.max(0.5, adjusted.maxAsk - 0.02);
  }
  return adjusted;
}

export function getCoinSideRejectReason(
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

export function getCoinBookRejectReason(
  coin: Coin,
  duration: Duration,
  side: Side,
  ask: number,
  spread: number,
  topBookValue: number,
): string | null {
  if (duration === '5m' && side === 'DOWN') {
    if (spread > 0.02) return 'down_spread_too_wide';
    if (topBookValue < 5) return 'down_top_book_too_small';
  }
  if (coin === 'BTC' && duration === '5m' && side === 'UP') {
    if (ask > 0.5) return 'btc_up_ask_too_high';
    if (spread > 0.05) return 'btc_up_spread_too_wide';
    if (topBookValue < 15) return 'btc_up_top_book_too_small';
  }
  if (coin === 'ETH' && duration === '5m' && side === 'UP') {
    if (ask > 0.45) return 'eth_up_ask_too_high';
    if (topBookValue < 15) return 'eth_up_top_book_too_small';
  }
  return null;
}

export function getCoinSignalQualityRejectReason(
  coin: Coin,
  duration: Duration,
  side: Side,
  score: number,
  edge: number,
): string | null {
  if (duration === '5m' && side === 'DOWN' && edge < 0.015) {
    return 'down_edge_too_small';
  }
  if (coin === 'BTC' && duration === '5m' && side === 'UP' && score < 15) {
    return 'btc_up_score_too_small';
  }
  return null;
}

export function chooseDirection(
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
  if (upMargin >= 0 || downMargin >= 0) direction = upMargin >= downMargin ? 'UP' : 'DOWN';
  else return null;

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

export function toBps(price: number, baseline: number): number {
  return ((price - baseline) / baseline) * 10_000;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
