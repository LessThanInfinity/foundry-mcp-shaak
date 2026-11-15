import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_CONFIG_PRESET_ID,
  DEFAULT_CRIT_SFX,
  applyCutInTemplate,
  CUT_IN_MODULE_ID,
} from './cut-ins.js';
import { FALLBACK_COLOR } from './cut-in-color.js';

const SCOPE = CUT_IN_MODULE_ID;

function makeActor(
  id: string,
  name: string,
  opts: { type?: string; folder?: any; img?: string; flags?: Record<string, any> } = {}
) {
  const flags: Record<string, any> = { ...(opts.flags ?? {}) };
  return {
    id,
    name,
    type: opts.type ?? 'npc',
    img: opts.img ?? `tokenizer/npc-images/${id}.Avatar.webp`,
    folder: opts.folder ?? null,
    flags,
    getFlag: (_scope: string, key: string) => flags[key],
    setFlag: vi.fn(async (_scope: string, key: string, value: any) => {
      flags[key] = structuredClone(value);
    }),
    unsetFlag: vi.fn(async (_scope: string, key: string) => {
      delete flags[key];
    }),
  };
}

function makeFolder(id: string, name: string, parent: any = null) {
  const folder: any = { id, name, type: 'Actor', folder: parent, children: [] as any[] };
  if (parent) parent.children.push({ folder });
  return folder;
}

// 400 saturated blue pixels
const BLUE = new Uint8ClampedArray(400 * 4).map((_, i) => [30, 90, 200, 255][i % 4]!);
// fully grey pixels -> fallback colour
const GREY = new Uint8ClampedArray(400 * 4).map((_, i) => [128, 128, 128, 255][i % 4]!);

function stubWorld(actors: any[], folders: any[] = [], moduleActive = true) {
  vi.stubGlobal('foundry', { utils: { deepClone: (v: unknown) => structuredClone(v) } });
  vi.stubGlobal('game', {
    modules: { get: () => (moduleActive ? { active: true } : undefined) },
    actors: {
      contents: actors,
      find: (fn: (a: any) => boolean) => actors.find(fn),
    },
    folders: { filter: (fn: (f: any) => boolean) => folders.filter(fn) },
  });
}

const critTrigger = (a: any) => a.flags.triggers.chat.filter((t: any) => t.trigger === 'onCrit');

describe('applyCutInTemplate', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('is a dry run by default and writes nothing', async () => {
    const a = makeActor('a1', 'Goblin');
    stubWorld([a]);
    const res = await applyCutInTemplate({}, { readPixels: async () => BLUE });
    expect(res.dryRun).toBe(true);
    expect(res.summary).toMatchObject({ matched: 1, wouldApply: 1, applied: 0 });
    expect(res.results[0]).toMatchObject({ status: 'would-apply', colorSource: 'portrait' });
    expect(a.setFlag).not.toHaveBeenCalled();
  });

  it('writes the config and an onCrit trigger that uses the active configuration', async () => {
    const a = makeActor('a1', 'Goblin', { img: 'tokenizer/npc-images/goblin.Avatar.webp' });
    stubWorld([a]);
    const res = await applyCutInTemplate({ dryRun: false }, { readPixels: async () => BLUE });

    expect(res.summary.applied).toBe(1);
    const cfg = a.flags.config;
    expect(cfg).toMatchObject({
      text: '{{name}}',
      hideSubText: true,
      customDuration: 2.5,
      characterImageSource: 'actor',
      img: 'tokenizer/npc-images/goblin.Avatar.webp',
      sfx: DEFAULT_CRIT_SFX,
      sfxList: { '0': DEFAULT_CRIT_SFX },
    });
    expect(cfg.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(cfg.color).not.toBe(FALLBACK_COLOR);
    expect(critTrigger(a)).toEqual([
      {
        trigger: 'onCrit',
        value: 'Critical Hit',
        rollIndex: null,
        operator: '>=',
        presetId: ACTIVE_CONFIG_PRESET_ID,
        macroId: '',
      },
    ]);
  });

  it('skips actors that already have cut-in data, and says why', async () => {
    const withTrigger = makeActor('a1', 'Taka', {
      flags: { config: { theme: 'brush' }, triggers: { chat: [{ trigger: 'onCrit' }] } },
    });
    const configOnly = makeActor('a2', 'GLC 2', { flags: { config: { theme: 'brush' } } });
    const fresh = makeActor('a3', 'Fresh');
    stubWorld([withTrigger, configOnly, fresh]);

    const res = await applyCutInTemplate(
      { dryRun: false, detail: 'full' },
      { readPixels: async () => BLUE }
    );
    const by = (n: string) => res.results.find((r: any) => r.name === n);
    expect(by('Taka')).toMatchObject({ status: 'skipped', reason: 'already has a crit trigger' });
    expect(by('GLC 2').reason).toContain('no crit trigger');
    expect(by('Fresh').status).toBe('applied');
    expect(withTrigger.setFlag).not.toHaveBeenCalled();
    expect(configOnly.setFlag).not.toHaveBeenCalled();
  });

  it('overwrite replaces the crit trigger but keeps other triggers', async () => {
    const a = makeActor('a1', 'Taka', {
      flags: {
        config: { theme: 'old' },
        triggers: {
          chat: [
            { trigger: 'onCrit', presetId: 'old' },
            { trigger: 'onAttack', presetId: 'keep-me' },
          ],
          turnStart: [{ keep: true }],
        },
      },
    });
    stubWorld([a]);
    await applyCutInTemplate(
      { dryRun: false, onExisting: 'overwrite' },
      { readPixels: async () => BLUE }
    );
    expect(a.flags.config.theme).toBe('brush');
    expect(critTrigger(a)).toHaveLength(1);
    expect(critTrigger(a)[0].presetId).toBe(ACTIVE_CONFIG_PRESET_ID);
    expect(a.flags.triggers.chat.some((t: any) => t.presetId === 'keep-me')).toBe(true);
    expect(a.flags.triggers.turnStart).toEqual([{ keep: true }]);
  });

  it('defaults to characters and NPCs; "*" includes every type', async () => {
    const npc = makeActor('a1', 'Goblin');
    const pc = makeActor('a2', 'Hero', { type: 'character' });
    const loot = makeActor('a3', 'Chest', { type: 'loot' });
    stubWorld([npc, pc, loot]);
    const def = await applyCutInTemplate({}, { readPixels: async () => BLUE });
    expect(def.results.map((r: any) => r.name).sort()).toEqual(['Goblin', 'Hero']);
    const all = await applyCutInTemplate({ types: ['*'] }, { readPixels: async () => BLUE });
    expect(all.summary.matched).toBe(3);
  });

  it('filters by folder, including subfolders, by name or path', async () => {
    const root = makeFolder('f1', 'Villains');
    const child = makeFolder('f2', 'Bosses', root);
    const other = makeFolder('f3', 'Townsfolk');
    const a = makeActor('a1', 'Grunt', { folder: root });
    const b = makeActor('a2', 'Boss', { folder: child });
    const c = makeActor('a3', 'Baker', { folder: other });
    const d = makeActor('a4', 'Loose');
    stubWorld([a, b, c, d], [root, child, other]);

    const res = await applyCutInTemplate({ folder: 'villains' }, { readPixels: async () => BLUE });
    expect(res.results.map((r: any) => r.name)).toEqual(['Boss', 'Grunt']);
    expect(res.results.find((r: any) => r.name === 'Boss').folder).toBe('Villains/Bosses');

    const byPath = await applyCutInTemplate(
      { folder: 'Villains/Bosses' },
      { readPixels: async () => BLUE }
    );
    expect(byPath.results.map((r: any) => r.name)).toEqual(['Boss']);
  });

  it('reports available folders when the folder is not found', async () => {
    stubWorld([makeActor('a1', 'X')], [makeFolder('f1', 'Villains')]);
    const res = await applyCutInTemplate({ folder: 'Nope' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Villains');
  });

  it('filters by explicit actor names or ids and honours limit', async () => {
    const actors = ['A', 'B', 'C'].map((n, i) => makeActor(`id${i}`, n));
    stubWorld(actors);
    const byName = await applyCutInTemplate(
      { actors: ['b', 'id2'] },
      { readPixels: async () => BLUE }
    );
    expect(byName.results.map((r: any) => r.name)).toEqual(['B', 'C']);
    const limited = await applyCutInTemplate({ limit: 1 }, { readPixels: async () => BLUE });
    expect(limited.results).toHaveLength(1);
  });

  it('colour overrides win, and bad hex values are rejected up front', async () => {
    const a = makeActor('a1', 'Goblin');
    stubWorld([a]);
    const ok = await applyCutInTemplate(
      { dryRun: false, colorOverrides: { Goblin: '#112233' } },
      { readPixels: async () => BLUE }
    );
    expect(ok.results[0]).toMatchObject({ color: '#112233', colorSource: 'override' });
    expect(a.flags.config.color).toBe('#112233');

    const bad = await applyCutInTemplate({ colorOverrides: { Goblin: 'red' } });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('#rrggbb');
  });

  it('autoColor false keeps the template colour', async () => {
    const a = makeActor('a1', 'Goblin');
    stubWorld([a]);
    const res = await applyCutInTemplate({ autoColor: false }, { readPixels: async () => BLUE });
    expect(res.results[0]).toMatchObject({ color: FALLBACK_COLOR, colorSource: 'template' });
  });

  it('falls back to the default colour for greyscale or unreadable portraits', async () => {
    const grey = makeActor('a1', 'Ghost');
    const broken = makeActor('a2', 'Broken');
    stubWorld([grey, broken]);
    const res = await applyCutInTemplate(
      {},
      {
        readPixels: async (path: string) => {
          if (path.includes('a2')) throw new Error('image load timed out');
          return GREY;
        },
      }
    );
    expect(res.results.find((r: any) => r.name === 'Ghost')).toMatchObject({
      color: FALLBACK_COLOR,
      colorSource: 'fallback',
    });
    const b = res.results.find((r: any) => r.name === 'Broken');
    expect(b).toMatchObject({ status: 'would-apply', colorSource: 'fallback' });
    expect(b.reason).toContain('unreadable');
  });

  it('uses a template actor config as the base and applies overrides last', async () => {
    const tpl = makeActor('t1', 'Template', {
      flags: { config: { theme: 'cleave', customDuration: 4, text: 'Fixed', hideSubText: false } },
    });
    const a = makeActor('a1', 'Goblin');
    stubWorld([tpl, a]);
    await applyCutInTemplate(
      {
        dryRun: false,
        templateActor: 'Template',
        actors: ['Goblin'],
        overrides: { customDuration: 3 },
      },
      { readPixels: async () => BLUE }
    );
    expect(a.flags.config.theme).toBe('cleave'); // from the template
    expect(a.flags.config.customDuration).toBe(3); // overrides win
    expect(a.flags.config.text).toBe('{{name}}'); // our default beats the template's fixed name
    expect(a.flags.config.hideSubText).toBe(true);
  });

  it('errors when the template actor is missing or has no config', async () => {
    stubWorld([makeActor('a1', 'Plain')]);
    expect((await applyCutInTemplate({ templateActor: 'Ghost' })).error).toContain('not found');
    expect((await applyCutInTemplate({ templateActor: 'Plain' })).error).toContain('no cut-in');
  });

  it('errors when Cinematic Cut-ins is not active', async () => {
    stubWorld([makeActor('a1', 'X')], [], false);
    const res = await applyCutInTemplate({});
    expect(res.success).toBe(false);
    expect(res.error).toContain('not installed or not active');
  });

  it('reports a per-actor error without aborting the batch', async () => {
    const bad = makeActor('a1', 'Bad');
    bad.setFlag.mockRejectedValue(new Error('permission denied'));
    const good = makeActor('a2', 'Good');
    stubWorld([bad, good]);
    const res = await applyCutInTemplate({ dryRun: false }, { readPixels: async () => BLUE });
    expect(res.summary).toMatchObject({ applied: 1, errors: 1 });
    expect(res.results.find((r: any) => r.name === 'Bad')).toMatchObject({
      status: 'error',
      reason: 'permission denied',
    });
  });

  it('is compact by default: skipped actors are counted by reason, not listed', async () => {
    const taka = makeActor('a1', 'Taka', {
      flags: { triggers: { chat: [{ trigger: 'onCrit' }] } },
    });
    const glc = makeActor('a2', 'GLC 2', { flags: { config: { theme: 'brush' } } });
    const fresh = makeActor('a3', 'Fresh');
    stubWorld([taka, glc, fresh]);
    const res = await applyCutInTemplate({}, { readPixels: async () => BLUE });
    expect(res.results.map((r: any) => r.name)).toEqual(['Fresh']);
    expect(res.results[0].image).toBeUndefined();
    expect(res.results[0].options).toBeUndefined();
    expect(res.summary.skipped).toBe(2);
    expect(res.summary.skippedReasons).toEqual({
      'already has a crit trigger': 1,
      'already has a cut-in config but no crit trigger': 1,
    });
  });

  it('full detail lists every actor with its portrait and what each style would pick', async () => {
    const taka = makeActor('a1', 'Taka', {
      flags: { triggers: { chat: [{ trigger: 'onCrit' }] } },
    });
    const fresh = makeActor('a3', 'Fresh');
    stubWorld([taka, fresh]);
    const res = await applyCutInTemplate({ detail: 'full' }, { readPixels: async () => BLUE });
    expect(res.results).toHaveLength(2);
    const row = res.results.find((r: any) => r.name === 'Fresh');
    expect(row.image).toBe('tokenizer/npc-images/a3.Avatar.webp');
    expect(Object.keys(row.options).sort()).toEqual(['highlight', 'natural', 'prominent']);
  });

  it('colorStyle picks which colour is used', async () => {
    const accented = Uint8ClampedArray.from(
      [
        ...Array.from({ length: 700 }, () => [70, 85, 140, 255]),
        ...Array.from({ length: 45 }, () => [255, 140, 10, 255]),
        ...Array.from({ length: 100 }, () => [20, 20, 20, 255]),
      ].flat()
    );
    const a = makeActor('a1', 'Goblin');
    stubWorld([a]);
    const prominent = await applyCutInTemplate(
      { detail: 'full' },
      { readPixels: async () => accented }
    );
    const highlight = await applyCutInTemplate(
      { colorStyle: 'highlight', detail: 'full' },
      { readPixels: async () => accented }
    );
    expect(highlight.colorStyle).toBe('highlight');
    expect(prominent.colorStyle).toBe('prominent');
    expect(highlight.results[0].color).toBe(highlight.results[0].options.highlight);
    expect(prominent.results[0].color).toBe(prominent.results[0].options.prominent);
    expect(highlight.results[0].color).not.toBe(prominent.results[0].color);
  });
});
