import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TapeEvent<T = Record<string, unknown>> {
  ts: number;
  type: string;
  payload: T;
}

export class JsonlTapeWriter {
  private readonly filePath: string;
  private readonly stream: fs.WriteStream;

  constructor(baseDir: string, subdir: string, prefix: string) {
    const dir = path.join(baseDir, subdir);
    fs.mkdirSync(dir, { recursive: true });
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(dir, `${prefix}-${runId}.jsonl`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  record<T extends Record<string, unknown>>(type: string, payload: T, ts = Date.now()): void {
    const event: TapeEvent<T> = { ts, type, payload };
    this.stream.write(JSON.stringify(event) + '\n');
  }

  getPath(): string {
    return this.filePath;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }
}
