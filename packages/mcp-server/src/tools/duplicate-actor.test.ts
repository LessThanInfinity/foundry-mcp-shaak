import { describe, expect, it, vi } from 'vitest';
import { DuplicateActorTools } from './duplicate-actor.js';

function makeTools(query = vi.fn().mockResolvedValue({ success: true })) {
  const logger: any = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  const tools = new DuplicateActorTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

describe('duplicate-actor', () => {
  it('routes to the duplicateActor query with a 90s timeout and default notesField', async () => {
    const { tools, query } = makeTools();

    await tools.handleDuplicateActor({
      source: 'Actor.TVwyzwrPNkJ6uQnm',
      copies: [{ name: 'Swift', folder: 'racing drakes/Test', notes: '<p>hi</p>' }],
    });

    expect(query).toHaveBeenCalledWith(
      'foundry-mcp-bridge.duplicateActor',
      {
        source: 'Actor.TVwyzwrPNkJ6uQnm',
        copies: [{ name: 'Swift', folder: 'racing drakes/Test', notes: '<p>hi</p>' }],
        notesField: 'private',
      },
      90000
    );
  });

  it('rejects empty and oversized copies, bad notesField and unknown keys', async () => {
    const { tools, query } = makeTools();

    const empty = await tools.handleDuplicateActor({ source: 'a', copies: [] });
    const tooMany = await tools.handleDuplicateActor({
      source: 'a',
      copies: Array.from({ length: 51 }, (_, i) => ({ name: `c${i}` })),
    });
    const badField = await tools.handleDuplicateActor({
      source: 'a',
      copies: [{ name: 'x' }],
      notesField: 'secret',
    });
    const unknown = await tools.handleDuplicateActor({
      source: 'a',
      copies: [{ name: 'x', bogus: 1 }],
    });
    const noSource = await tools.handleDuplicateActor({ copies: [{ name: 'x' }] });

    for (const r of [empty, tooMany, badField, unknown, noSource]) {
      expect(r).toMatchObject({ success: false });
      expect(r.error).toContain('Invalid arguments');
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the error when the query fails', async () => {
    const { tools } = makeTools(vi.fn().mockRejectedValue(new Error('timeout')));
    const result = await tools.handleDuplicateActor({ source: 'a', copies: [{ name: 'x' }] });
    expect(result).toEqual({ success: false, error: 'timeout' });
  });
});
