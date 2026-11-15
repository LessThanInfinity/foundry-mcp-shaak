import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilePreferredWorldStore, defaultPreferredWorldPath } from './preferred-world-store.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-mcp-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('FilePreferredWorldStore', () => {
  it('returns null when nothing was saved', () => {
    expect(new FilePreferredWorldStore(path.join(dir, 'none.json')).load()).toBeNull();
  });

  it('saves and loads the choice, creating folders as needed', () => {
    const file = path.join(dir, 'deep', 'er', 'preferred-world.json');
    const store = new FilePreferredWorldStore(file);
    store.save('http://localhost:30000|ruby');
    expect(new FilePreferredWorldStore(file).load()).toBe('http://localhost:30000|ruby');
  });

  it('forgets the choice when given null', () => {
    const file = path.join(dir, 'p.json');
    const store = new FilePreferredWorldStore(file);
    store.save('x|y');
    store.save(null);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.load()).toBeNull();
  });

  it('treats a corrupt or unexpected file as nothing saved', () => {
    const file = path.join(dir, 'bad.json');
    for (const content of ['not json', '{"preferredWorld": 5}', '{"preferredWorld": ""}', '[]']) {
      fs.writeFileSync(file, content);
      expect(new FilePreferredWorldStore(file).load()).toBeNull();
    }
  });

  it('never throws when the location cannot be written', () => {
    const blocker = path.join(dir, 'file-not-folder');
    fs.writeFileSync(blocker, 'x');
    const store = new FilePreferredWorldStore(path.join(blocker, 'sub', 'p.json'));
    expect(() => store.save('a|b')).not.toThrow();
    expect(store.load()).toBeNull();
  });

  it('defaults to the home folder and can be redirected with FOUNDRY_MCP_STATE_DIR', () => {
    const original = process.env.FOUNDRY_MCP_STATE_DIR;
    try {
      delete process.env.FOUNDRY_MCP_STATE_DIR;
      expect(defaultPreferredWorldPath()).toBe(
        path.join(os.homedir(), '.foundry-mcp', 'preferred-world.json')
      );
      process.env.FOUNDRY_MCP_STATE_DIR = dir;
      expect(defaultPreferredWorldPath()).toBe(path.join(dir, 'preferred-world.json'));
    } finally {
      if (original === undefined) delete process.env.FOUNDRY_MCP_STATE_DIR;
      else process.env.FOUNDRY_MCP_STATE_DIR = original;
    }
  });
});
