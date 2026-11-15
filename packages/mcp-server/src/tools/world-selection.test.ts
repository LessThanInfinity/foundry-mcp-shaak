import { describe, expect, it, vi } from 'vitest';
import { WorldSelectionTools } from './world-selection.js';

function summary(over: Record<string, unknown> = {}) {
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
    userName: 'Gamemaster',
    origin: 'http://localhost:30000',
    preferred: true,
    toolCount: 51,
    ...over,
  };
}

function makeTools(client: Record<string, any>) {
  const logger: any = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  return new WorldSelectionTools({ foundryClient: client as any, logger });
}

describe('world selection tools', () => {
  it('registers both tools', () => {
    const names = makeTools({})
      .getToolDefinitions()
      .map(d => d.name);
    expect(names).toEqual(['list-foundry-worlds', 'select-foundry-world']);
  });

  it('lists worlds and names the active one', async () => {
    const worlds = [summary(), summary({ connectionId: 'c2', active: false, label: 'Ruby' })];
    const tools = makeTools({ listWorlds: vi.fn().mockResolvedValue(worlds) });
    const res: any = await tools.handleListWorlds({});
    expect(res).toMatchObject({ success: true, count: 2, active: 'Ruby (local) (c1)' });
    expect(res.note).toContain('select-foundry-world');
  });

  it('says so when nothing is connected', async () => {
    const tools = makeTools({ listWorlds: vi.fn().mockResolvedValue([]) });
    const res: any = await tools.handleListWorlds({});
    expect(res).toMatchObject({ success: true, count: 0, active: null });
    expect(res.note).toContain('No Foundry world is connected');
  });

  it('rejects arguments for the list tool', async () => {
    const res: any = await makeTools({}).handleListWorlds({ extra: 1 });
    expect(res.success).toBe(false);
  });

  it('selects a world and returns the new state', async () => {
    const selected = summary({ connectionId: 'c2', label: 'Ruby' });
    const client = {
      listWorlds: vi.fn().mockResolvedValue([selected]),
      selectWorld: vi.fn().mockReturnValue(selected),
    };
    const res: any = await makeTools(client).handleSelectWorld({ world: 'ruby' });
    expect(client.selectWorld).toHaveBeenCalledWith('ruby');
    expect(res).toMatchObject({ success: true });
    expect(res.message).toContain('Now talking to "Ruby" (c2).');
    expect(res.message).toContain('remembered across reloads and restarts');
  });

  it('refreshes world names before selecting so older modules can be chosen by title', async () => {
    const order: string[] = [];
    const client = {
      listWorlds: vi.fn().mockImplementation(async () => {
        order.push('list');
        return [];
      }),
      selectWorld: vi.fn().mockImplementation(() => {
        order.push('select');
        return summary();
      }),
    };
    await makeTools(client).handleSelectWorld({ world: 'x' });
    expect(order.slice(0, 2)).toEqual(['list', 'select']);
  });

  it('returns the readable error when no world matches', async () => {
    const client = {
      listWorlds: vi.fn().mockResolvedValue([]),
      selectWorld: vi.fn().mockImplementation(() => {
        throw new Error('No connected world matches "x". Connected worlds: none connected.');
      }),
    };
    const res: any = await makeTools(client).handleSelectWorld({ world: 'x' });
    expect(res).toEqual({
      success: false,
      error: 'No connected world matches "x". Connected worlds: none connected.',
    });
  });

  it('requires a world', async () => {
    const res: any = await makeTools({}).handleSelectWorld({});
    expect(res.success).toBe(false);
    expect(res.error).toContain('world');
  });
});
