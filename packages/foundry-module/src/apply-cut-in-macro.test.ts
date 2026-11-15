/**
 * Runs macros/apply-cut-in.js against stubbed Foundry globals.
 *
 * The macro is meant to be pasted into a Foundry Script macro, where the code runs inside an
 * async function (so a top-level `return` is legal). The same shape is used here, with the
 * settings block at the top edited per test the way a user would edit it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const MACRO = readFileSync(
  fileURLToPath(new URL('../macros/apply-cut-in.js', import.meta.url)),
  'utf-8'
);

type Settings = Partial<{
  ACTOR: string;
  STYLE: string;
  COLOR: string;
  OVERWRITE: boolean;
  PREVIEW_ONLY: boolean;
  DURATION: number;
  SFX: string;
}>;

/** Edits the settings block like a user would. */
function withSettings(settings: Settings): string {
  let code = MACRO;
  for (const [name, value] of Object.entries(settings)) {
    const re = new RegExp(`^const ${name} = .*;$`, 'm');
    expect(code).toMatch(re);
    code = code.replace(re, `const ${name} = ${JSON.stringify(value)};`);
  }
  return code;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

interface Env {
  applyCutIn?: (input: any) => Promise<any> | any;
  actors?: Array<{ id: string; name: string }>;
  selected?: { id: string; name: string } | null;
  moduleApi?: boolean;
}

async function run(settings: Settings, env: Env = {}) {
  const actors = env.actors ?? [{ id: 'abc123', name: 'Ledger' }];
  const applyCutIn = vi.fn(
    env.applyCutIn ??
      (async () => ({
        success: true,
        results: [
          {
            status: 'applied',
            color: '#dc8018',
            options: { prominent: '#dc8018', natural: '#a66e30', highlight: '#f38a16' },
          },
        ],
      }))
  );
  const ui = { notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  const game = {
    modules: {
      get: () => (env.moduleApi === false ? { api: undefined } : { api: { applyCutIn } }),
    },
    actors: {
      get: (id: string) => actors.find(a => a.id === id),
      getName: (name: string) => actors.find(a => a.name === name),
    },
  };
  const selected = env.selected === undefined ? actors[0] : env.selected;
  const canvas = { tokens: { controlled: selected ? [{ actor: selected }] : [] } };

  await new AsyncFunction('game', 'ui', 'canvas', withSettings(settings))(game, ui, canvas);
  return { applyCutIn, ui };
}

describe('apply-cut-in macro', () => {
  it('ships with the documented settings at the top', () => {
    for (const name of [
      'ACTOR',
      'STYLE',
      'COLOR',
      'OVERWRITE',
      'PREVIEW_ONLY',
      'DURATION',
      'SFX',
    ]) {
      expect(MACRO).toMatch(new RegExp(`^const ${name} = `, 'm'));
    }
    expect(MACRO).toMatch(/^const STYLE = ['"]prominent['"];$/m);
  });

  it('with the defaults, applies to the selected token’s actor', async () => {
    const { applyCutIn, ui } = await run({});
    expect(applyCutIn).toHaveBeenCalledWith({
      actors: ['abc123'],
      colorStyle: 'prominent',
      colorOverrides: undefined,
      onExisting: 'overwrite',
      dryRun: false,
      detail: 'full',
      overrides: {
        customDuration: 2.5,
        sfx: 'upload/Sounds/persona_5_crit_sound.mp3',
        sfxList: { 0: 'upload/Sounds/persona_5_crit_sound.mp3' },
      },
    });
    expect(ui.notifications.info).toHaveBeenCalledWith(
      'Ledger: crit cut-in applied, colour #dc8018.'
    );
  });

  it.each([
    ['an actor id', 'abc123'],
    ['an Actor UUID', 'Actor.abc123'],
    ['an exact name', 'Ledger'],
  ])('finds the actor by %s', async (_label, ACTOR) => {
    const { applyCutIn } = await run({ ACTOR }, { selected: null });
    expect(applyCutIn.mock.calls[0]![0].actors).toEqual(['abc123']);
  });

  it('passes the chosen style, duration and sound through', async () => {
    const { applyCutIn } = await run({
      STYLE: 'highlight',
      DURATION: 4,
      SFX: 'upload/Sounds/boom.mp3',
    });
    const input = applyCutIn.mock.calls[0]![0];
    expect(input.colorStyle).toBe('highlight');
    expect(input.overrides).toEqual({
      customDuration: 4,
      sfx: 'upload/Sounds/boom.mp3',
      sfxList: { 0: 'upload/Sounds/boom.mp3' },
    });
  });

  it('forces the colour for that actor when COLOR is set', async () => {
    const { applyCutIn } = await run({ COLOR: '#f5980c' });
    expect(applyCutIn.mock.calls[0]![0].colorOverrides).toEqual({ abc123: '#f5980c' });
  });

  it('OVERWRITE = false asks to skip actors that already have cut-in data', async () => {
    const { applyCutIn } = await run({ OVERWRITE: false });
    expect(applyCutIn.mock.calls[0]![0].onExisting).toBe('skip');
  });

  it('PREVIEW_ONLY is a dry run and reports every style’s colour', async () => {
    const { applyCutIn, ui } = await run({ PREVIEW_ONLY: true });
    expect(applyCutIn.mock.calls[0]![0].dryRun).toBe(true);
    expect(ui.notifications.info).toHaveBeenCalledWith(
      'Ledger would get #dc8018. Prominent #dc8018, natural #a66e30, highlight #f38a16.'
    );
  });

  it('tells the user when the actor was skipped and how to replace it', async () => {
    const { ui } = await run(
      { OVERWRITE: false },
      {
        applyCutIn: async () => ({
          success: true,
          results: [{ status: 'skipped', reason: 'already has a crit trigger' }],
        }),
      }
    );
    expect(ui.notifications.warn).toHaveBeenCalledWith(
      'Ledger: already has a crit trigger. Set OVERWRITE = true to replace it.'
    );
  });

  it('mentions an unreadable portrait but still reports success', async () => {
    const { ui } = await run(
      {},
      {
        applyCutIn: async () => ({
          success: true,
          results: [{ status: 'applied', color: '#324453', reason: 'portrait unreadable: x' }],
        }),
      }
    );
    expect(ui.notifications.info).toHaveBeenCalledWith(
      'Ledger: crit cut-in applied, colour #324453 (portrait unreadable: x).'
    );
  });

  it('stops with a clear message for a bad STYLE or COLOR, without calling the module', async () => {
    const bad = await run({ STYLE: 'neon' });
    expect(bad.applyCutIn).not.toHaveBeenCalled();
    expect(bad.ui.notifications.error).toHaveBeenCalledWith(
      'STYLE must be one of: prominent, natural, highlight (got "neon")'
    );
    const badColor = await run({ COLOR: 'orange' });
    expect(badColor.applyCutIn).not.toHaveBeenCalled();
    expect(badColor.ui.notifications.error).toHaveBeenCalledWith(
      expect.stringContaining('COLOR must look like #f5980c')
    );
  });

  it('asks for an actor when none is set or selected, or the name is unknown', async () => {
    const none = await run({}, { selected: null });
    expect(none.applyCutIn).not.toHaveBeenCalled();
    expect(none.ui.notifications.warn).toHaveBeenCalledWith(
      'No actor: set ACTOR at the top of the macro, or select a token first.'
    );
    const unknown = await run({ ACTOR: 'Nobody' });
    expect(unknown.ui.notifications.warn).toHaveBeenCalledWith('No actor found for "Nobody".');
  });

  it('explains when the bridge module is missing or too old', async () => {
    const { applyCutIn, ui } = await run({}, { moduleApi: false });
    expect(applyCutIn).not.toHaveBeenCalled();
    expect(ui.notifications.error).toHaveBeenCalledWith(expect.stringContaining('too old'));
  });

  it('reports a failure from the module instead of throwing', async () => {
    const thrown = await run(
      {},
      {
        applyCutIn: async () => {
          throw new Error('Only a GM can apply cut-ins');
        },
      }
    );
    expect(thrown.ui.notifications.error).toHaveBeenCalledWith(
      'Cut-in failed: Only a GM can apply cut-ins'
    );
    const failed = await run(
      {},
      { applyCutIn: async () => ({ success: false, error: 'Cinematic Cut-ins is not active' }) }
    );
    expect(failed.ui.notifications.error).toHaveBeenCalledWith(
      'Cut-in failed: Cinematic Cut-ins is not active'
    );
  });
});
