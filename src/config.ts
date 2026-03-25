import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotMode, Coin, Duration, Side } from './types.js';

export interface SideStrategyProfile {
  binanceTriggerBps: number;
  minBinancePulseBps: number;
  minLeadGapBps: number;
  chainlinkOpposeBps: number;
  minEdge: number;
  minMarketLag: number;
  maxAsk: number;
}

export interface StrategyProfile {
  closeWindowSec: number;
  maxExternalAgeMs: number;
  maxBookAgeMs: number;
  chainlinkConfirmBps: number;
  fairScaleBps: number;
  executionBuffer: number;
  maxSpread: number;
  minTopBookValue: number;
  sides: Record<Side, SideStrategyProfile>;
}

export interface Config {
  mode: BotMode;
  privateKey: string;
  rpcUrl: string;
  chainId: number;
  signatureType: number;
  funderAddress: string;
  budget: number;
  paperBalance: number;
  dataDir: string;
  replayDir: string;
  replayEnabled: boolean;
  replayTicksEnabled: boolean;
  replayTickMinMs: number;
  paperExecutionDelayMinMs: number;
  paperExecutionDelayMaxMs: number;
  scanSec: number;
  evalMs: number;
  statusSec: number;
  intradayCheckMs: number;
  settleSec: number;
  settleDelaySec: number;
  baselineCaptureGraceSec: number;
  maxOpenPositions: number;
  maxOpenPositionsPerCoin: number;
  coinCooldownSec: number;
  binanceLookbackMs: number;
  trendLookbackMs: number;
  trendBiasBps: number;
  takeProfitMinPriceDelta: number;
  takeProfitEdgeFactor: number;
  takeProfitLagFactor: number;
  minHoldSec: number;
  forceExitSec: number;
  hardExitSec: number;
  lotteryEnabled: boolean;
  lotteryBudget: number;
  lotteryCloseWindowSec: number;
  lotteryMinSignalAsk: number;
  lotteryMaxSignalAsk: number;
  lotteryMinEdge: number;
  lotteryMinLag: number;
  lotteryMinScore: number;
  lotteryMinPulseBps: number;
  lotteryMinTrendBps: number;
  lotteryMinBinanceDeltaBps: number;
  lotteryMinLeadGapBps: number;
  lotteryMaxTopBookValue: number;
  lotteryMaxSpread: number;
  settlementGuardSec: number;
  settlementMaxAsk: number;
  settlementMinEdge: number;
  settlementMinLag: number;
  countertrendExitSec: number;
  countertrendExitBps: number;
  forceExitMinRoi: number;
  strategyProfiles: Record<Duration, StrategyProfile>;
  coins: Coin[];
  durations: Duration[];
}

export function loadConfig(): Config {
  loadEnvFile();

  const args = process.argv.slice(2);
  const get = (key: string, envKey: string, fallback: string): string => {
    const cli = args.find((item: string) => item.startsWith(`--${key}=`));
    if (cli) return cli.split('=').slice(1).join('=');
    return process.env[envKey] || fallback;
  };
  const getScoped = (key: string, envKey: string, duration: Duration, fallback: string): string => {
    const suffix = duration === '5m' ? '5M' : '15M';
    const scopedKey = `${key}-${duration}`;
    const scopedEnv = `${envKey}_${suffix}`;
    const cli = args.find((item: string) => item.startsWith(`--${scopedKey}=`));
    if (cli) return cli.split('=').slice(1).join('=');
    return process.env[scopedEnv] || process.env[envKey] || fallback;
  };
  const getSideScoped = (key: string, envKey: string, duration: Duration, side: Side, fallback: string): string => {
    const durationSuffix = duration === '5m' ? '5M' : '15M';
    const sideSuffix = side;
    const scopedKey = `${key}-${duration}-${side.toLowerCase()}`;
    const scopedEnv = `${envKey}_${durationSuffix}_${sideSuffix}`;
    const cli = args.find((item: string) => item.startsWith(`--${scopedKey}=`));
    if (cli) return cli.split('=').slice(1).join('=');
    return process.env[scopedEnv] || process.env[`${envKey}_${sideSuffix}`] || process.env[envKey] || fallback;
  };

  const mode: BotMode = args.includes('--paper')
    ? 'paper'
    : args.includes('--live')
      ? 'live'
      : 'dry-run';

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY || '';
  if (mode === 'live' && !privateKey) {
    throw new Error('POLYMARKET_PRIVATE_KEY is required for live mode');
  }

  return {
    mode,
    privateKey,
    rpcUrl: get('rpc-url', 'POLYGON_RPC_URL', 'https://polygon-rpc.com'),
    chainId: parseFloat(get('chain-id', 'CHAIN_ID', '137')),
    signatureType: parseFloat(get('signature-type', 'POLYMARKET_SIGNATURE_TYPE', '0')),
    funderAddress: get('funder-address', 'POLYMARKET_FUNDER_ADDRESS', ''),
    budget: parseFloat(get('budget', 'BUDGET', '5')),
    paperBalance: parseFloat(get('paper-balance', 'PAPER_BALANCE', '100')),
    dataDir: get('data-dir', 'DATA_DIR', '.intraday-state'),
    replayDir: get('replay-dir', 'REPLAY_DIR', 'replay'),
    replayEnabled: get('replay-enabled', 'REPLAY_ENABLED', 'true') === 'true',
    replayTicksEnabled: get('replay-ticks-enabled', 'REPLAY_TICKS_ENABLED', mode === 'dry-run' ? 'true' : 'false') === 'true',
    replayTickMinMs: parseFloat(get('replay-tick-min-ms', 'REPLAY_TICK_MIN_MS', '250')),
    paperExecutionDelayMinMs: parseFloat(get('paper-execution-delay-min-ms', 'PAPER_EXECUTION_DELAY_MIN_MS', '100')),
    paperExecutionDelayMaxMs: parseFloat(get('paper-execution-delay-max-ms', 'PAPER_EXECUTION_DELAY_MAX_MS', '300')),
    scanSec: parseFloat(get('scan-sec', 'SCAN_SEC', '20')),
    evalMs: parseFloat(get('eval-ms', 'EVAL_MS', '500')),
    statusSec: parseFloat(get('status-sec', 'STATUS_SEC', '30')),
    intradayCheckMs: parseFloat(get('intraday-check-ms', 'INTRADAY_CHECK_MS', '1000')),
    settleSec: parseFloat(get('settle-sec', 'SETTLE_SEC', '10')),
    settleDelaySec: parseFloat(get('settle-delay-sec', 'SETTLE_DELAY_SEC', '8')),
    baselineCaptureGraceSec: parseFloat(get('baseline-grace-sec', 'BASELINE_GRACE_SEC', '20')),
    maxOpenPositions: parseFloat(get('max-open-positions', 'MAX_OPEN_POSITIONS', '24')),
    maxOpenPositionsPerCoin: parseFloat(get('max-open-positions-per-coin', 'MAX_OPEN_POSITIONS_PER_COIN', '6')),
    coinCooldownSec: parseFloat(get('coin-cooldown-sec', 'COIN_COOLDOWN_SEC', '3')),
    binanceLookbackMs: parseFloat(get('binance-lookback-ms', 'BINANCE_LOOKBACK_MS', '5000')),
    trendLookbackMs: parseFloat(get('trend-lookback-ms', 'TREND_LOOKBACK_MS', '900000')),
    trendBiasBps: parseFloat(get('trend-bias-bps', 'TREND_BIAS_BPS', '6')),
    takeProfitMinPriceDelta: parseFloat(get('take-profit-min-price-delta', 'TAKE_PROFIT_MIN_PRICE_DELTA', '0.025')),
    takeProfitEdgeFactor: parseFloat(get('take-profit-edge-factor', 'TAKE_PROFIT_EDGE_FACTOR', '0.4')),
    takeProfitLagFactor: parseFloat(get('take-profit-lag-factor', 'TAKE_PROFIT_LAG_FACTOR', '0.3')),
    minHoldSec: parseFloat(get('min-hold-sec', 'MIN_HOLD_SEC', '7')),
    forceExitSec: parseFloat(get('force-exit-sec', 'FORCE_EXIT_SEC', '30')),
    hardExitSec: parseFloat(get('hard-exit-sec', 'HARD_EXIT_SEC', '0')),
    lotteryEnabled: get('lottery-enabled', 'LOTTERY_ENABLED', 'true') === 'true',
    lotteryBudget: parseFloat(get('lottery-budget', 'LOTTERY_BUDGET', '1')),
    lotteryCloseWindowSec: parseFloat(get('lottery-close-window-sec', 'LOTTERY_CLOSE_WINDOW_SEC', '3')),
    lotteryMinSignalAsk: parseFloat(get('lottery-min-signal-ask', 'LOTTERY_MIN_SIGNAL_ASK', '0.18')),
    lotteryMaxSignalAsk: parseFloat(get('lottery-max-signal-ask', 'LOTTERY_MAX_SIGNAL_ASK', '0.30')),
    lotteryMinEdge: parseFloat(get('lottery-min-edge', 'LOTTERY_MIN_EDGE', '0.45')),
    lotteryMinLag: parseFloat(get('lottery-min-lag', 'LOTTERY_MIN_LAG', '0.45')),
    lotteryMinScore: parseFloat(get('lottery-min-score', 'LOTTERY_MIN_SCORE', '80')),
    lotteryMinPulseBps: parseFloat(get('lottery-min-pulse-bps', 'LOTTERY_MIN_PULSE_BPS', '1.0')),
    lotteryMinTrendBps: parseFloat(get('lottery-min-trend-bps', 'LOTTERY_MIN_TREND_BPS', '20')),
    lotteryMinBinanceDeltaBps: parseFloat(get('lottery-min-binance-delta-bps', 'LOTTERY_MIN_BINANCE_DELTA_BPS', '3.0')),
    lotteryMinLeadGapBps: parseFloat(get('lottery-min-lead-gap-bps', 'LOTTERY_MIN_LEAD_GAP_BPS', '4.0')),
    lotteryMaxTopBookValue: parseFloat(get('lottery-max-top-book-value', 'LOTTERY_MAX_TOP_BOOK_VALUE', '10')),
    lotteryMaxSpread: parseFloat(get('lottery-max-spread', 'LOTTERY_MAX_SPREAD', '0.18')),
    settlementGuardSec: parseFloat(get('settlement-guard-sec', 'SETTLEMENT_GUARD_SEC', '8')),
    settlementMaxAsk: parseFloat(get('settlement-max-ask', 'SETTLEMENT_MAX_ASK', '0.10')),
    settlementMinEdge: parseFloat(get('settlement-min-edge', 'SETTLEMENT_MIN_EDGE', '0.20')),
    settlementMinLag: parseFloat(get('settlement-min-lag', 'SETTLEMENT_MIN_LAG', '0.20')),
    countertrendExitSec: parseFloat(get('countertrend-exit-sec', 'COUNTERTREND_EXIT_SEC', '15')),
    countertrendExitBps: parseFloat(get('countertrend-exit-bps', 'COUNTERTREND_EXIT_BPS', '2.5')),
    forceExitMinRoi: parseFloat(get('force-exit-min-roi', 'FORCE_EXIT_MIN_ROI', '0.005')),
    strategyProfiles: {
      '5m': loadStrategyProfile('5m', getScoped, getSideScoped, {
        closeWindowSec: 60,
        maxExternalAgeMs: 3500,
        maxBookAgeMs: 5000,
        chainlinkConfirmBps: 1,
        fairScaleBps: 12,
        executionBuffer: 0.01,
        maxSpread: 0.22,
        minTopBookValue: 2,
        sides: {
          UP: {
            binanceTriggerBps: 1.95,
            minBinancePulseBps: 0.55,
            minLeadGapBps: 0.32,
            chainlinkOpposeBps: 2.6,
            minEdge: 0.025,
            minMarketLag: 0.018,
            maxAsk: 0.65,
          },
          DOWN: {
            binanceTriggerBps: 1.4,
            minBinancePulseBps: 0.32,
            minLeadGapBps: 0.18,
            chainlinkOpposeBps: 2.0,
            minEdge: 0.01,
            minMarketLag: 0.004,
            maxAsk: 0.75,
          },
        },
      }),
      '15m': loadStrategyProfile('15m', getScoped, getSideScoped, {
        closeWindowSec: 75,
        maxExternalAgeMs: 3000,
        maxBookAgeMs: 4500,
        chainlinkConfirmBps: 1,
        fairScaleBps: 12,
        executionBuffer: 0.015,
        maxSpread: 0.14,
        minTopBookValue: 4,
        sides: {
          UP: {
            binanceTriggerBps: 2.9,
            minBinancePulseBps: 0.75,
            minLeadGapBps: 0.5,
            chainlinkOpposeBps: 1.9,
            minEdge: 0.024,
            minMarketLag: 0.01,
            maxAsk: 0.78,
          },
          DOWN: {
            binanceTriggerBps: 3.1,
            minBinancePulseBps: 0.8,
            minLeadGapBps: 0.5,
            chainlinkOpposeBps: 1.6,
            minEdge: 0.024,
            minMarketLag: 0.01,
            maxAsk: 0.76,
          },
        },
      }),
    },
    coins: parseCoins(get('coins', 'COINS', 'BTC,ETH')),
    durations: parseDurations(get('durations', 'DURATIONS', '5m')),
  };
}

function loadStrategyProfile(
  duration: Duration,
  getScoped: (key: string, envKey: string, duration: Duration, fallback: string) => string,
  getSideScoped: (key: string, envKey: string, duration: Duration, side: Side, fallback: string) => string,
  defaults: StrategyProfile,
): StrategyProfile {
  const loadSide = (side: Side): SideStrategyProfile => ({
    binanceTriggerBps: parseFloat(getSideScoped('binance-trigger-bps', 'BINANCE_TRIGGER_BPS', duration, side, String(defaults.sides[side].binanceTriggerBps))),
    minBinancePulseBps: parseFloat(getSideScoped('min-binance-pulse-bps', 'MIN_BINANCE_PULSE_BPS', duration, side, String(defaults.sides[side].minBinancePulseBps))),
    minLeadGapBps: parseFloat(getSideScoped('min-lead-gap-bps', 'MIN_LEAD_GAP_BPS', duration, side, String(defaults.sides[side].minLeadGapBps))),
    chainlinkOpposeBps: parseFloat(getSideScoped('chainlink-oppose-bps', 'CHAINLINK_OPPOSE_BPS', duration, side, String(defaults.sides[side].chainlinkOpposeBps))),
    minEdge: parseFloat(getSideScoped('min-edge', 'MIN_EDGE', duration, side, String(defaults.sides[side].minEdge))),
    minMarketLag: parseFloat(getSideScoped('min-market-lag', 'MIN_MARKET_LAG', duration, side, String(defaults.sides[side].minMarketLag))),
    maxAsk: parseFloat(getSideScoped('max-ask', 'MAX_ASK', duration, side, String(defaults.sides[side].maxAsk))),
  });

  return {
    closeWindowSec: parseFloat(getScoped('close-window-sec', 'CLOSE_WINDOW_SEC', duration, String(defaults.closeWindowSec))),
    maxExternalAgeMs: parseFloat(getScoped('max-external-age-ms', 'MAX_EXTERNAL_AGE_MS', duration, String(defaults.maxExternalAgeMs))),
    maxBookAgeMs: parseFloat(getScoped('max-book-age-ms', 'MAX_BOOK_AGE_MS', duration, String(defaults.maxBookAgeMs))),
    chainlinkConfirmBps: parseFloat(getScoped('chainlink-confirm-bps', 'CHAINLINK_CONFIRM_BPS', duration, String(defaults.chainlinkConfirmBps))),
    fairScaleBps: parseFloat(getScoped('fair-scale-bps', 'FAIR_SCALE_BPS', duration, String(defaults.fairScaleBps))),
    executionBuffer: parseFloat(getScoped('execution-buffer', 'EXECUTION_BUFFER', duration, String(defaults.executionBuffer))),
    maxSpread: parseFloat(getScoped('max-spread', 'MAX_SPREAD', duration, String(defaults.maxSpread))),
    minTopBookValue: parseFloat(getScoped('min-top-book-value', 'MIN_TOP_BOOK_VALUE', duration, String(defaults.minTopBookValue))),
    sides: {
      UP: loadSide('UP'),
      DOWN: loadSide('DOWN'),
    },
  };
}

function parseCoins(value: string): Coin[] {
  return value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item): item is Coin => ['BTC', 'ETH'].includes(item));
}

function parseDurations(value: string): Duration[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is Duration => item === '5m' || item === '15m');
}

function loadEnvFile(): void {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // Ignore missing local env file.
  }
}
