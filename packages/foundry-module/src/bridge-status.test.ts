import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildStatusViewModel,
  collectHello,
  formatDiagnostics,
  type BridgeStatus,
  type BridgeWorld,
  type StatusInput,
} from './bridge-status.js';

function world(over: Partial<BridgeWorld> = {}): BridgeWorld {
  return {
    connectionId: 'c1',
    active: true,
    transport: 'websocket',
    connectedAt: '2026-11-15T00:00:00.000Z',
    identified: true,
    label: 'Ruby (local)',
    worldId: 'ruby',
    worldTitle: 'Ruby (local)',
    systemId: 'pf2e',
    systemVersion: '7.12.2',
    foundryVersion: '13.351',
    moduleVersion: '0.8.6',
    userName: 'GM',
    toolCount: 51,
    ...over,
  };
}

function input(over: Partial<StatusInput> = {}): StatusInput {
  const bridgeStatus: BridgeStatus = {
    connectionId: 'c1',
    active: true,
    activeConnectionId: 'c1',
    serverVersion: '0.8.6',
    worlds: [world()],
  };
  return {
    enabled: true,
    connectionState: 'connected',
    connectionType: 'websocket',
    host: 'localhost',
    port: 31415,
    world: {
      title: 'Ruby (local)',
      id: 'ruby',
      systemId: 'pf2e',
      systemVersion: '7.12.2',
      foundry: '13.351',
    },
    moduleVersion: '0.8.6',
    methods: ['manageFlags', 'applyCutInTemplate'],
    bridgeStatus,
    ...over,
  };
}

describe('buildStatusViewModel', () => {
  it('shows an active, connected world', () => {
    const vm = buildStatusViewModel(input());
    expect(vm).toMatchObject({
      tone: 'ok',
      headline: 'Connected — this world is ACTIVE',
      canMakeActive: false,
      canConnect: false,
      canDisconnect: true,
      hasCutInTool: true,
      toolCount: 2,
    });
    expect(vm.server).toMatchObject({ version: '0.8.6', transport: 'websocket' });
  });

  it('shows standby and names the world Claude is actually talking to', () => {
    const bridgeStatus: BridgeStatus = {
      connectionId: 'c2',
      active: false,
      activeConnectionId: 'c1',
      serverVersion: '0.8.6',
      worlds: [
        world({ connectionId: 'c1', active: true, label: 'Ruby (remote)' }),
        world({ connectionId: 'c2', active: false, label: 'Ruby (local)' }),
      ],
    };
    const vm = buildStatusViewModel(input({ bridgeStatus }));
    expect(vm.tone).toBe('standby');
    expect(vm.headline).toBe('Connected — STANDBY');
    expect(vm.detail).toContain('Ruby (remote)');
    expect(vm.canMakeActive).toBe(true);
    expect(vm.worlds.find(w => w.you)?.connectionId).toBe('c2');
    expect(vm.worlds.find(w => w.active)?.connectionId).toBe('c1');
  });

  it('explains when the bridge is turned off', () => {
    const vm = buildStatusViewModel(input({ enabled: false, connectionState: 'disconnected' }));
    expect(vm.tone).toBe('off');
    expect(vm.canConnect).toBe(true);
  });

  it('says the server cannot be reached, with the address', () => {
    const vm = buildStatusViewModel(
      input({ connectionState: 'disconnected', bridgeStatus: null, host: 'myhost', port: 1234 })
    );
    expect(vm.tone).toBe('warn');
    expect(vm.detail).toContain('myhost:1234');
    expect(vm).toMatchObject({ canConnect: true, canDisconnect: false, canMakeActive: false });
  });

  it('treats reconnecting as a state that can be cancelled', () => {
    const vm = buildStatusViewModel(input({ connectionState: 'reconnecting', bridgeStatus: null }));
    expect(vm.headline).toBe('Reconnecting…');
    expect(vm.canDisconnect).toBe(true);
  });

  it('copes with an older server that never sends status', () => {
    const vm = buildStatusViewModel(input({ bridgeStatus: null }));
    expect(vm).toMatchObject({ tone: 'ok', headline: 'Connected', canMakeActive: false });
    expect(vm.server.version).toBe('unknown');
    expect(vm.worlds).toEqual([]);
  });

  it('flags a module without the cut-in tool', () => {
    expect(buildStatusViewModel(input({ methods: ['manageFlags'] })).hasCutInTool).toBe(false);
  });

  it('shows where each world is open and which one is remembered', () => {
    const bridgeStatus: BridgeStatus = {
      connectionId: 'c3',
      active: true,
      activeConnectionId: 'c3',
      serverVersion: '0.8.6',
      worlds: [
        world({ connectionId: 'c2', active: false, origin: null, moduleVersion: null }),
        world({
          connectionId: 'c3',
          active: true,
          preferred: true,
          origin: 'http://localhost:30000',
        }),
      ],
    };
    const vm = buildStatusViewModel(input({ bridgeStatus }));
    const [remote, local] = vm.worlds;
    expect(remote).toMatchObject({ address: '', remembered: false });
    expect(local).toMatchObject({ address: 'localhost:30000', remembered: true, you: true });
    expect(formatDiagnostics(vm)).toContain('@ localhost:30000 [this world] [ACTIVE] [remembered]');
  });

  it('labels a world on an older module', () => {
    const bridgeStatus: BridgeStatus = {
      connectionId: 'c1',
      active: true,
      activeConnectionId: 'c1',
      serverVersion: null,
      worlds: [world({ moduleVersion: null, systemId: null, systemVersion: null })],
    };
    const row = buildStatusViewModel(input({ bridgeStatus })).worlds[0]!;
    expect(row.moduleVersion).toBe('unknown (older module)');
    expect(row.system).toBe('—');
  });
});

describe('formatDiagnostics', () => {
  it('includes the facts needed to debug a connection', () => {
    const text = formatDiagnostics(buildStatusViewModel(input()));
    expect(text).toContain('Foundry MCP Bridge 0.8.6');
    expect(text).toContain('This world: Ruby (local) (ruby)');
    expect(text).toContain('Server: localhost:31415');
    expect(text).toContain('cut-in tool: yes');
    expect(text).toContain('c1 Ruby (local) [this world] [ACTIVE]');
  });
});

describe('collectHello', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads this world and lists only this module’s registered queries', () => {
    vi.stubGlobal('game', {
      world: { id: 'ruby', title: 'Ruby Phoenix' },
      system: { id: 'pf2e', version: '7.12.2' },
      version: '13.351',
      modules: { get: () => ({ version: '0.8.6' }) },
      user: { name: 'Gamemaster' },
    });
    vi.stubGlobal('window', { location: { origin: 'http://localhost:30000' } });
    vi.stubGlobal('CONFIG', {
      queries: {
        'foundry-mcp-bridge.manageFlags': () => 1,
        'foundry-mcp-bridge.applyCutInTemplate': () => 1,
        'someone-else.thing': () => 1,
      },
    });
    expect(collectHello()).toEqual({
      worldId: 'ruby',
      worldTitle: 'Ruby Phoenix',
      systemId: 'pf2e',
      systemVersion: '7.12.2',
      foundryVersion: '13.351',
      moduleVersion: '0.8.6',
      userName: 'Gamemaster',
      origin: 'http://localhost:30000',
      methods: ['manageFlags', 'applyCutInTemplate'],
    });
  });
});
