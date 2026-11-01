import { describe, expect, it, vi } from 'vitest';
import { ModuleDataTools } from './module-data.js';

function makeTools(query = vi.fn().mockResolvedValue({ success: true })) {
  const logger: any = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  const tools = new ModuleDataTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

describe('manage-flags', () => {
  it('routes get to the manageFlags query', async () => {
    const { tools, query } = makeTools();

    await tools.handleManageFlags({
      action: 'get',
      uuid: 'Actor.KEinmzpxY3CnAD2W',
      scope: 'cinematic-cut-ins',
    });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.manageFlags', {
      action: 'get',
      uuid: 'Actor.KEinmzpxY3CnAD2W',
      scope: 'cinematic-cut-ins',
    });
  });

  it('passes set with value and replace through', async () => {
    const { tools, query } = makeTools();
    const value = [{ trigger: 'onCrit', presetId: 'abc' }];

    await tools.handleManageFlags({
      action: 'set',
      actor: 'Tino Tung',
      scope: 'cinematic-cut-ins',
      key: 'triggers.chat',
      value,
      replace: true,
    });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.manageFlags', {
      action: 'set',
      actor: 'Tino Tung',
      scope: 'cinematic-cut-ins',
      key: 'triggers.chat',
      value,
      replace: true,
    });
  });

  it('refuses the core scope', async () => {
    const { tools, query } = makeTools();

    const result = await tools.handleManageFlags({
      action: 'get',
      uuid: 'Actor.x',
      scope: 'core',
    });

    expect(result.success).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('requires a target, a key for writes and a value for set', async () => {
    const { tools, query } = makeTools();

    const noTarget = await tools.handleManageFlags({ action: 'get', scope: 'm' });
    const unsetNoKey = await tools.handleManageFlags({
      action: 'unset',
      uuid: 'Actor.x',
      scope: 'm',
    });
    const setNoValue = await tools.handleManageFlags({
      action: 'set',
      uuid: 'Actor.x',
      scope: 'm',
      key: 'k',
    });

    expect(noTarget.success).toBe(false);
    expect(unsetNoKey.success).toBe(false);
    expect(setNoValue.success).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('manage-module-settings', () => {
  it('routes list without a key', async () => {
    const { tools, query } = makeTools();

    await tools.handleManageModuleSettings({ action: 'list', scope: 'cinematic-cut-ins' });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.manageModuleSettings', {
      action: 'list',
      scope: 'cinematic-cut-ins',
    });
  });

  it('refuses core and requires key/value where needed', async () => {
    const { tools, query } = makeTools();

    const core = await tools.handleManageModuleSettings({ action: 'list', scope: 'core' });
    const getNoKey = await tools.handleManageModuleSettings({ action: 'get', scope: 'm' });
    const setNoValue = await tools.handleManageModuleSettings({
      action: 'set',
      scope: 'm',
      key: 'k',
    });

    expect(core.success).toBe(false);
    expect(getNoKey.success).toBe(false);
    expect(setNoValue.success).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
