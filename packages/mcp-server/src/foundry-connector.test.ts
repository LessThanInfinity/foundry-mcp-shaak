import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { FoundryConnector, parseIdentity } from './foundry-connector.js';

const NAMESPACE = '/foundry-mcp';

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

/** A fake Foundry world: a WebSocket client that records what the server sends it. */
class FakeWorld {
  messages: any[] = [];
  private waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];

  constructor(private ws: WebSocket) {
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      this.waiters = this.waiters.filter(w => {
        if (w.pred(message)) {
          w.resolve(message);
          return false;
        }
        return true;
      });
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  hello(data: Record<string, unknown>): void {
    this.send({ type: 'hello', data });
  }

  async next(pred: (m: any) => boolean, timeoutMs = 2000): Promise<any> {
    const existing = this.messages.find(pred);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: m => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** Waits for a status message newer than the ones already seen that satisfies `pred`. */
  async nextStatus(pred: (data: any) => boolean = () => true): Promise<any> {
    const seen = this.messages.length;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for status')), 2000);
      const check = () => {
        const m = this.messages.slice(seen).find(x => x.type === 'bridge-status' && pred(x.data));
        if (m) {
          clearTimeout(timer);
          resolve(m.data);
          return true;
        }
        return false;
      };
      if (check()) return;
      const interval = setInterval(() => check() && clearInterval(interval), 10);
    });
  }

  /** Answers every mcp-query with the given handler's result. */
  answerQueries(handler: (method: string, data: any) => unknown): void {
    this.ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'mcp-query') return;
      this.send({
        type: 'mcp-response',
        id: message.id,
        data: { success: true, data: handler(message.data.method, message.data.data) },
      });
    });
  }

  queriesReceived(): any[] {
    return this.messages.filter(m => m.type === 'mcp-query');
  }

  close(): void {
    this.ws.close();
  }
}

let connector: FoundryConnector;
let worlds: FakeWorld[] = [];

async function connectWorld(): Promise<FakeWorld> {
  const port = connector.getPort();
  const ws = new WebSocket(`ws://127.0.0.1:${port}${NAMESPACE}`);
  // Listen from the start: the server sends its first status the moment we connect.
  const world = new FakeWorld(ws);
  worlds.push(world);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return world;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 60));

beforeEach(async () => {
  connector = new FoundryConnector({
    config: { port: 0, namespace: NAMESPACE, protocol: 'ws', remoteMode: false, webrtc: {} } as any,
    logger: makeLogger(),
    serverVersion: '9.9.9',
    webrtcSignalingPort: 0,
  });
  await connector.start();
});

afterEach(async () => {
  worlds.forEach(w => w.close());
  worlds = [];
  await connector.stop();
});

describe('FoundryConnector with more than one world', () => {
  it('keeps the first world active and tells each world its own state', async () => {
    const a = await connectWorld();
    await a.next(m => m.type === 'bridge-status');
    const b = await connectWorld();
    const bStatus = await b.next(m => m.type === 'bridge-status');

    expect(bStatus.data.active).toBe(false);
    expect(bStatus.data.serverVersion).toBe('9.9.9');
    expect(bStatus.data.worlds).toHaveLength(2);

    const aUpdate = await a.nextStatus(d => d.worlds.length === 2);
    expect(aUpdate.active).toBe(true);
    expect(connector.isConnected()).toBe(true);
  });

  it('identifies each world from its hello and shares the names with both', async () => {
    const a = await connectWorld();
    const b = await connectWorld();
    a.hello({
      worldId: 'ruby',
      worldTitle: 'Ruby (local)',
      moduleVersion: '0.8.6',
      methods: ['x'],
    });
    b.hello({ worldId: 'ruby', worldTitle: 'Ruby (remote)', moduleVersion: '0.8.5' });

    const status = await a.nextStatus(d => d.worlds.every((w: any) => w.identified));
    expect(status.worlds.map((w: any) => w.worldTitle).sort()).toEqual([
      'Ruby (local)',
      'Ruby (remote)',
    ]);
    expect(connector.listConnections().find(w => w.worldTitle === 'Ruby (local)')).toMatchObject({
      active: true,
      moduleVersion: '0.8.6',
      toolCount: 1,
    });
  });

  it('sends queries only to the active world', async () => {
    const a = await connectWorld();
    const b = await connectWorld();
    a.answerQueries(() => ({ from: 'a' }));
    b.answerQueries(() => ({ from: 'b' }));
    await settle();

    expect(await connector.query('foundry-mcp-bridge.getWorldInfo')).toEqual({ from: 'a' });
    expect(a.queriesReceived()).toHaveLength(1);
    expect(b.queriesReceived()).toHaveLength(0);
  });

  it('ignores a standby world answering a query it was never sent', async () => {
    const a = await connectWorld();
    const b = await connectWorld();
    await settle();

    const pending = connector.query('foundry-mcp-bridge.getWorldInfo', {}, 400);
    const query = await a.next(m => m.type === 'mcp-query');
    // The standby world tries to answer the active world's query.
    b.send({ type: 'mcp-response', id: query.id, data: { success: true, data: { from: 'b' } } });
    await expect(pending).rejects.toThrow(/Query timeout/);
  });

  it('switches worlds when one asks to become active', async () => {
    const a = await connectWorld();
    const b = await connectWorld();
    a.answerQueries(() => ({ from: 'a' }));
    b.answerQueries(() => ({ from: 'b' }));
    await settle();

    b.send({ type: 'select-world' });
    const status = await b.nextStatus(d => d.active === true);
    expect(status.activeConnectionId).toBe(status.connectionId);

    expect(await connector.query('foundry-mcp-bridge.getWorldInfo')).toEqual({ from: 'b' });
  });

  it('switches worlds by title from the server side', async () => {
    const a = await connectWorld();
    const b = await connectWorld();
    a.hello({ worldId: 'w1', worldTitle: 'Alpha' });
    b.hello({ worldId: 'w2', worldTitle: 'Beta' });
    b.answerQueries(() => ({ from: 'b' }));
    await b.nextStatus(d => d.worlds.every((w: any) => w.identified));

    const selected = connector.selectConnection('beta');
    expect(selected).toMatchObject({ worldTitle: 'Beta', active: true });
    expect(await connector.query('foundry-mcp-bridge.getWorldInfo')).toEqual({ from: 'b' });
    expect(() => connector.selectConnection('gamma')).toThrow(/No connected world matches/);
  });

  it('promotes the other world when the active one disconnects and fails its pending query', async () => {
    const a = await connectWorld();
    const b = await connectWorld();
    b.answerQueries(() => ({ from: 'b' }));
    await settle();

    const pending = connector.query('foundry-mcp-bridge.getWorldInfo', {}, 2000);
    await a.next(m => m.type === 'mcp-query');
    a.close();
    await expect(pending).rejects.toThrow('Connection closed');

    const status = await b.nextStatus(d => d.active === true);
    expect(status.worlds).toHaveLength(1);
    expect(await connector.query('foundry-mcp-bridge.getWorldInfo')).toEqual({ from: 'b' });
  });

  it('reports not connected once every world has gone', async () => {
    const a = await connectWorld();
    await settle();
    a.close();
    await settle();
    expect(connector.isConnected()).toBe(false);
    await expect(connector.query('foundry-mcp-bridge.getWorldInfo')).rejects.toThrow(
      'Not connected to Foundry VTT module'
    );
  });

  it('explains when the active world has a module without the requested tool', async () => {
    const a = await connectWorld();
    const b = await connectWorld();
    a.hello({
      worldId: 'old',
      worldTitle: 'Remote Ruby',
      moduleVersion: '0.8.5',
      methods: ['manageFlags'],
    });
    b.hello({ worldId: 'new', worldTitle: 'Local Ruby', methods: ['applyCutInTemplate'] });
    await b.nextStatus(d => d.worlds.every((w: any) => w.identified));

    await expect(connector.query('foundry-mcp-bridge.applyCutInTemplate')).rejects.toThrow(
      /"Remote Ruby" runs Foundry MCP Bridge module 0\.8\.5.*"applyCutInTemplate".*Local Ruby/
    );
    expect(a.queriesReceived()).toHaveLength(0);
  });

  it('names a world on an older module by asking it directly', async () => {
    const legacy = await connectWorld(); // never sends hello
    legacy.answerQueries(method =>
      method === 'foundry-mcp-bridge.getWorldInfo'
        ? {
            id: 'ruby',
            title: 'Ruby Phoenix',
            system: 'pf2e',
            systemVersion: '7.12.2',
            foundryVersion: '13.351',
          }
        : null
    );
    await settle();
    expect(connector.listConnections()[0]).toMatchObject({ identified: false });

    await connector.identifyConnections();
    expect(connector.listConnections()[0]).toMatchObject({
      identified: true,
      worldTitle: 'Ruby Phoenix',
      systemId: 'pf2e',
      foundryVersion: '13.351',
    });
  });

  it('leaves a world unidentified if it cannot answer', async () => {
    await connectWorld(); // never answers
    await settle();
    await connector.identifyConnections(150);
    expect(connector.listConnections()[0]).toMatchObject({ identified: false });
  });
});

describe('parseIdentity', () => {
  it('keeps only known string fields and a bounded method list', () => {
    const identity = parseIdentity({
      worldId: 'w',
      worldTitle: 'T',
      evil: 'x',
      moduleVersion: 5,
      methods: ['a', 3, 'b'],
    });
    expect(identity).toEqual({ worldId: 'w', worldTitle: 'T', methods: ['a', 'b'] });
  });

  it('copes with junk', () => {
    expect(parseIdentity(undefined)).toEqual({});
    expect(parseIdentity('nope')).toEqual({});
  });
});
