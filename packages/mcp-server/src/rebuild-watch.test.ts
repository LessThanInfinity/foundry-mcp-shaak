import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchForRebuild } from './rebuild-watch.js';

const tmpFiles: string[] = [];

function tmpFile(): string {
  const file = path.join(
    os.tmpdir(),
    `rebuild-watch-${process.pid}-${Math.random().toString(36).slice(2)}.js`
  );
  fs.writeFileSync(file, 'v1');
  tmpFiles.push(file);
  return file;
}

function touch(file: string, secondsAhead: number): void {
  const t = new Date(Date.now() + secondsAhead * 1000);
  fs.utimesSync(file, t, t);
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
});

describe('watchForRebuild', () => {
  it('fires once after the file changes and settles', async () => {
    const file = tmpFile();
    const onRebuild = vi.fn();
    const stop = watchForRebuild(file, onRebuild, { intervalMs: 20, settleMs: 60 });

    touch(file, 5);
    await wait(40);
    touch(file, 10); // a second write during the build resets the settle timer
    await wait(250);

    expect(onRebuild).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not fire when the file is unchanged', async () => {
    const file = tmpFile();
    const onRebuild = vi.fn();
    const stop = watchForRebuild(file, onRebuild, { intervalMs: 20, settleMs: 30 });

    await wait(150);

    expect(onRebuild).not.toHaveBeenCalled();
    stop();
  });

  it('does not fire after stop()', async () => {
    const file = tmpFile();
    const onRebuild = vi.fn();
    const stop = watchForRebuild(file, onRebuild, { intervalMs: 20, settleMs: 30 });

    stop();
    touch(file, 5);
    await wait(150);

    expect(onRebuild).not.toHaveBeenCalled();
  });

  it('is a no-op for a missing file', () => {
    const stop = watchForRebuild(path.join(os.tmpdir(), 'does-not-exist-rebuild.js'), vi.fn());
    expect(typeof stop).toBe('function');
    stop();
  });
});
