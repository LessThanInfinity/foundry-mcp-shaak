/**
 * The "stay on the world I chose" behaviour, against real WebSocket clients: a reload, a
 * server restart, and an older module that never says hello.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { FoundryConnector } from './foundry-connector.js';
import type { PreferredWorldStore } from './preferred-world-store.js';

const NAMESPACE = '/foundry-mcp';
const LOCAL = 'http://localhost:30000';
const REMOTE = 'https://play.example.com';

function makeLogger(): any {
  const logger: any = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

class MemoryStore implements PreferredWorldStore {
  saves: Array<string | null> = [];
  constructor(public value: string | null = null) {}
  load(): string | null {
    return this.value;
  }
  save(key: string | null): void {
    this.value = key;
    this.saves.push(key);
  }
}

class FakeWorld {
  messages: any[] = [];
  constructor(private ws: WebSocket) {
    ws.on('message', raw => this.messages.push(JSON.parse(raw.toString())));
  }
  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }
  hello(origin: string | undefined, title = 'Ruby'): void {
    this.send({ type: 'hello', data: { worldId: 'ruby', worldTitle: title, origin } });
  }
  lastStatus(): any {
    return [...this.messages].reverse().find(m => m.type === 'bridge-status')?.data;
  }
  close(): void {
    this.ws.close();
  }
}

const connectors: FoundryConnector[] = [];
const worlds: FakeWorld[] = [];

async function startConnector(store?: PreferredWorldStore): Promise<FoundryConnector> {
  const connector = new FoundryConnector({
    config: { port: 0, namespace: NAMESPACE, protocol: 'ws', remoteMode: false, webrtc: {} } as any,
    logger: makeLogger(),
    webrtcSignalingPort: 0,
    preferredWorldStore: store,
  });
  await connector.start();
  connectors.push(connector);
  return connector;
}

async function connect(connector: FoundryConnector): Promise<FakeWorld> {
  const ws = new WebSocket(`ws://127.0.0.1:${connector.getPort()}${NAMESPACE}`);
  const world = new FakeWorld(ws);
  worlds.push(world);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return world;
}

const settle = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
const activeLabel = (c: FoundryConnector) => c.listConnections().find(w => w.active)?.label;

afterEach(async () => {
  worlds.splice(0).forEach(w => w.close());
  await Promise.all(connectors.splice(0).map(c => c.stop()));
});

describe('keeping the world you chose', () => {
  it('saves the choice when you select a world, by page address', async () => {
    const store = new MemoryStore();
    const connector = await startConnector(store);
    const remote = await connect(connector);
    const local = await connect(connector);
    remote.hello(REMOTE);
    local.hello(LOCAL);
    await settle();

    connector.selectConnection('localhost');
    expect(store.saves).toEqual([`${LOCAL}|ruby`]);
    expect(activeLabel(connector)).toBe('Ruby (localhost:30000)');
  });

  it('saves the choice when a world asks to become active from its own panel', async () => {
    const store = new MemoryStore();
    const connector = await startConnector(store);
    const first = await connect(connector);
    const second = await connect(connector);
    first.hello(REMOTE);
    second.hello(LOCAL);
    await settle();

    second.send({ type: 'select-world' });
    await settle();
    expect(store.value).toBe(`${LOCAL}|ruby`);
    expect(second.lastStatus().active).toBe(true);
  });

  it('puts the chosen world back in charge after it reloads', async () => {
    const store = new MemoryStore();
    const connector = await startConnector(store);
    const remote = await connect(connector);
    const local = await connect(connector);
    remote.hello(REMOTE);
    local.hello(LOCAL);
    await settle();
    connector.selectConnection('localhost');

    // The local page reloads: the remote world is promoted while it is away.
    local.close();
    await settle();
    expect(activeLabel(connector)).toBe('Ruby (play.example.com)');

    // It comes back and says hello: it is active again, and is told so.
    const reloaded = await connect(connector);
    reloaded.hello(LOCAL);
    await settle();
    expect(activeLabel(connector)).toBe('Ruby (localhost:30000)');
    expect(reloaded.lastStatus()).toMatchObject({ active: true });
    expect(remote.lastStatus()).toMatchObject({ active: false });
  });

  it('keeps the chosen world across a server restart', async () => {
    const store = new MemoryStore(`${LOCAL}|ruby`);
    const connector = await startConnector(store); // as if just restarted
    const remote = await connect(connector); // the remote world reconnects first
    remote.hello(REMOTE);
    await settle();
    expect(activeLabel(connector)).toBe('Ruby (play.example.com)');

    const local = await connect(connector);
    local.hello(LOCAL);
    await settle();
    expect(activeLabel(connector)).toBe('Ruby (localhost:30000)');
  });

  it('takes the active slot back from an older module that cannot identify itself', async () => {
    const store = new MemoryStore(`${LOCAL}|ruby`);
    const connector = await startConnector(store);
    const legacy = await connect(connector); // never says hello
    await settle();
    expect(connector.listConnections()[0]).toMatchObject({ active: true, identified: false });

    const local = await connect(connector);
    local.hello(LOCAL);
    await settle();
    const worldsNow = connector.listConnections();
    expect(worldsNow.find(w => w.active)).toMatchObject({ origin: LOCAL, preferred: true });
    expect(legacy.lastStatus()).toMatchObject({ active: false });
  });

  it('does not let a world you did not choose take over', async () => {
    const store = new MemoryStore();
    const connector = await startConnector(store);
    const local = await connect(connector);
    local.hello(LOCAL);
    await settle();
    connector.selectConnection('localhost');

    const remote = await connect(connector);
    remote.hello(REMOTE);
    await settle();
    expect(activeLabel(connector)).toBe('Ruby (localhost:30000)');
  });

  it('forgets the choice when you select a world that cannot be remembered', async () => {
    const store = new MemoryStore();
    const connector = await startConnector(store);
    const local = await connect(connector);
    const legacy = await connect(connector); // no hello: cannot be remembered
    local.hello(LOCAL);
    await settle();
    connector.selectConnection('localhost');
    expect(store.value).toBe(`${LOCAL}|ruby`);

    connector.selectConnection(connector.listConnections().find(w => !w.identified)!.connectionId);
    expect(store.value).toBeNull();
    void legacy;
  });

  it('works without a store: the first world stays active', async () => {
    const connector = await startConnector();
    const a = await connect(connector);
    const b = await connect(connector);
    a.hello(REMOTE);
    b.hello(LOCAL);
    await settle();
    expect(activeLabel(connector)).toBe('Ruby (play.example.com)');
  });
});
