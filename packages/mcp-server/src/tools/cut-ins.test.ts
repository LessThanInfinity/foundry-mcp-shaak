import { describe, expect, it, vi } from 'vitest';
import { CutInTools } from './cut-ins.js';

function makeTools(query = vi.fn().mockResolvedValue({ success: true })) {
  const logger: any = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  const tools = new CutInTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

describe('apply-cut-in-template', () => {
  it('is registered with a dry-run-first description', () => {
    const [def] = makeTools().tools.getToolDefinitions();
    expect(def!.name).toBe('apply-cut-in-template');
    expect(def!.description).toContain('DRY RUN BY DEFAULT');
  });

  it('routes the arguments to the applyCutInTemplate query', async () => {
    const { tools, query } = makeTools();
    const args = {
      folder: 'Villains',
      types: ['npc'],
      onExisting: 'overwrite',
      dryRun: false,
      colorOverrides: { Taka: '#439cbe' },
      overrides: { customDuration: 3 },
      colorStyle: 'highlight',
      detail: 'full',
      limit: 5,
    };

    await tools.handleApplyCutInTemplate(args);

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.applyCutInTemplate', args);
  });

  it('accepts no arguments (all characters and NPCs, dry run)', async () => {
    const { tools, query } = makeTools();
    await tools.handleApplyCutInTemplate(undefined);
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.applyCutInTemplate', {});
  });

  it('does not add dryRun: false on its own', async () => {
    const { tools, query } = makeTools();
    await tools.handleApplyCutInTemplate({ folder: 'X' });
    expect((query.mock.calls[0]![1] as any).dryRun).toBeUndefined();
  });

  it.each([
    [{ colorOverrides: { Taka: 'blue' } }, 'must be "#rrggbb"'],
    [{ onExisting: 'merge' }, 'onExisting'],
    [{ colorStyle: 'neon' }, 'colorStyle'],
    [{ colorStyle: 'vivid' }, 'colorStyle'],
    [{ detail: 'huge' }, 'detail'],
    [{ dryRun: 'no' }, 'dryRun'],
    [{ limit: 0 }, 'limit'],
    [{ limit: 1.5 }, 'limit'],
    [{ unknown: true }, 'Unrecognized'],
    [{ folder: '' }, 'folder'],
    [{ types: [] }, 'types'],
  ])('rejects invalid arguments %j', async (args, fragment) => {
    const { tools, query } = makeTools();
    const res: any = await tools.handleApplyCutInTemplate(args);
    expect(res.success).toBe(false);
    expect(res.error).toContain(fragment);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns a clean error when the bridge call fails', async () => {
    const { tools } = makeTools(vi.fn().mockRejectedValue(new Error('not connected')));
    const res: any = await tools.handleApplyCutInTemplate({});
    expect(res).toEqual({ success: false, error: 'not connected' });
  });
});
