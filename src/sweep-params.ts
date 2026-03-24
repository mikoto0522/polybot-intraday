import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface SweepResult {
  file: string;
  signals: number;
  rejects: number;
  closedTrades: number;
  realizedPnl: number;
  paperBalance: number;
  openUnresolved: number;
  byReason: string[];
  bySide: string[];
  byCoin: string[];
  topRejects: string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const filePath = resolveRequiredArg(args, '--file');
  const gridArg = resolveRequiredArg(args, '--grid');
  const variants = buildVariants(gridArg);
  if (variants.length === 0) {
    throw new Error('Grid is empty. Example: --grid="MAX_ASK_5M_UP=0.55,0.60;MIN_EDGE_5M_UP=0.02,0.03"');
  }

  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const results: Array<{ env: Record<string, string>; summary: SweepResult }> = [];

  for (const env of variants) {
    const child = spawnSync(
      command,
      ['tsx', 'src/backtest-run.ts', `--file=${filePath}`, '--json'],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (child.status !== 0) {
      console.error(`Variant failed: ${JSON.stringify(env)}`);
      console.error(child.stderr || child.stdout);
      continue;
    }
    results.push({
      env,
      summary: JSON.parse(child.stdout) as SweepResult,
    });
  }

  results.sort((a, b) => b.summary.realizedPnl - a.summary.realizedPnl);
  console.log(`Variants run: ${results.length}`);
  for (const result of results.slice(0, 10)) {
    console.log(`${result.summary.realizedPnl.toFixed(3).padStart(10)} ${JSON.stringify(result.env)}`);
  }
}

function resolveRequiredArg(args: string[], key: string): string {
  const arg = args.find((item) => item.startsWith(`${key}=`));
  if (!arg) throw new Error(`Missing ${key}=...`);
  const raw = arg.slice(key.length + 1);
  if (key === '--file') {
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
    return resolved;
  }
  return raw;
}

function buildVariants(grid: string): Array<Record<string, string>> {
  const dimensions = grid
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [key, rawValues] = part.split('=');
      return {
        key: key.trim(),
        values: (rawValues || '').split(',').map((value) => value.trim()).filter(Boolean),
      };
    })
    .filter((dimension) => dimension.key && dimension.values.length > 0);

  let variants: Array<Record<string, string>> = [{}];
  for (const dimension of dimensions) {
    const next: Array<Record<string, string>> = [];
    for (const variant of variants) {
      for (const value of dimension.values) {
        next.push({ ...variant, [dimension.key]: value });
      }
    }
    variants = next;
  }
  return variants;
}

main().catch((error) => {
  console.error('Sweep failed:', error);
  process.exit(1);
});
