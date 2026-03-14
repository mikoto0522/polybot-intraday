export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export class LatencyTracker {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly maxSamples = 2048) {}

  record(name: string, valueMs: number): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;
    const bucket = this.buckets.get(name) || [];
    bucket.push(valueMs);
    if (bucket.length > this.maxSamples) {
      bucket.splice(0, bucket.length - this.maxSamples);
    }
    this.buckets.set(name, bucket);
  }

  summarize(name: string): LatencySummary | null {
    const bucket = this.buckets.get(name);
    if (!bucket || bucket.length === 0) return null;
    const sorted = [...bucket].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted[sorted.length - 1],
    };
  }
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx];
}
