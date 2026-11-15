/**
 * Bulk-apply a Cinematic Cut-ins "crit animation" to many actors.
 *
 * Each target actor gets, under flags.cinematic-cut-ins:
 *   - config:        the actor's active configuration (a full template, with the actor's own
 *                    portrait and a theme colour picked from that portrait)
 *   - triggers.chat: one `onCrit` trigger pointing at the built-in active-config preset, so
 *                    a PF2e critical-success attack plays the animation
 *
 * Runs in the Foundry client because reading a portrait's pixels needs a browser canvas.
 * Dry run is the default and writes nothing.
 */

import {
  FALLBACK_COLOR,
  pickAllPortraitColors,
  type ColorStyle,
  type PortraitColor,
} from './cut-in-color.js';

export const CUT_IN_MODULE_ID = 'cinematic-cut-ins';
/** Preset id the module resolves to the actor's own active configuration. */
export const ACTIVE_CONFIG_PRESET_ID = 'cinematic-cut-ins:active-config';

export const DEFAULT_CRIT_SFX = 'upload/Sounds/persona_5_crit_sound.mp3';

/**
 * Full config as saved by Cinematic Cut-ins 3.x for a hand-made actor, minus the
 * per-actor fields (img, color). Used when no template actor is given.
 */
export const DEFAULT_CUT_IN_CONFIG: Record<string, unknown> = {
  sequence: {
    version: 1,
    enabled: false,
    background: '',
    music: '',
    musicVolume: 60,
    exitTransition: 'fade',
    exitDuration: 0.35,
    scenes: [],
  },
  groupId: '',
  inheritGroupTriggers: true,
  characterImageSource: 'actor',
  theme: 'brush',
  tarotNumeral: 'XVII',
  customDuration: 2.5,
  format: 'popout',
  hideBackground: false,
  hideCharacter: false,
  videoLoop: true,
  screenPosX: 50,
  screenPos: 50,
  charScale: 1,
  charOffsetX: 0,
  charOffsetY: 0,
  charRotation: 0,
  charMirror: false,
  characterMotion: 'none',
  characterMotionDuration: 3,
  characterMotionIntensity: 100,
  characterMotionStart: null,
  characterMotionEnd: null,
  textOffsetMode: 'independent',
  text: '{{name}}',
  hideMainText: false,
  preserveMainTextCase: false,
  mainFontSize: 8,
  mainOffsetX: 0,
  mainOffsetY: 0,
  mainTextRotation: 0,
  subText: '',
  hideSubText: true,
  subFontSize: 2,
  subOffsetX: 0,
  subOffsetY: 0,
  subTextRotation: 0,
  fontFamily: 'Teko',
  fontBold: true,
  fontItalic: false,
  subFontFamily: 'Teko',
  subFontBold: true,
  subFontItalic: false,
  mainTextColor: '#ffffff',
  subTextColor: '#000000',
  color: FALLBACK_COLOR,
  borderWidth: 0,
  borderColor: '#ffffff',
  charShadowColor: '#000000',
  hideCharShadow: false,
  shakeIntensity: 0,
  dimIntensity: 0,
  screenMood: 'none',
  screenMoodOpacity: 60,
  cinematicEffect: 'none',
  cinematicEffectStrength: '2',
  cinematicEffectOffsetX: 0,
  cinematicEffectOffsetY: 0,
  cinematicEffectScale: 101,
  soundList: { '0': '' },
  sfxList: { '0': DEFAULT_CRIT_SFX },
  soundVolume: 80,
  sfxVolume: 80,
  keepAudioPlaying: false,
  audioOnly: false,
  localOnly: false,
  videoAudio: false,
  triggers: { defaultSpellPreset: '' },
  sound: '',
  sfx: DEFAULT_CRIT_SFX,
  variations: [],
  layers: [],
  triggerOnRoundStart: false,
  triggerOnCombatStart: false,
  triggerOnCombatEnd: false,
};

/** The settings that make up "our" default, applied over the base config or a template. */
export const CRIT_DEFAULTS: Record<string, unknown> = {
  characterImageSource: 'actor',
  customDuration: 2.5,
  text: '{{name}}',
  hideMainText: false,
  subText: '',
  hideSubText: true,
  soundList: { '0': '' },
  sfxList: { '0': DEFAULT_CRIT_SFX },
  sound: '',
  sfx: DEFAULT_CRIT_SFX,
};

const EMPTY_TRIGGERS = {
  defaultSpellPreset: '',
  chat: [] as any[],
  conditions: [] as any[],
  resources: [] as any[],
  turnStart: [] as any[],
  turnEnd: [] as any[],
  turnStartPreset: null,
  turnStartRound: null,
  turnEndPreset: null,
  turnEndRound: null,
};

export const CRIT_TRIGGER = {
  trigger: 'onCrit',
  value: 'Critical Hit',
  rollIndex: null,
  operator: '>=',
  presetId: ACTIVE_CONFIG_PRESET_ID,
  macroId: '',
};

export interface ApplyCutInTemplateInput {
  /** Folder name, id or "Parent/Child" path. Includes subfolders. */
  folder?: string;
  /** Actor names or ids. When combined with folder, an actor must match both. */
  actors?: string[];
  /** Actor types to include. Default character + npc. Use ["*"] for every type. */
  types?: string[];
  /** Copy this actor's active configuration as the base instead of the built-in default. */
  templateActor?: string;
  /** Config fields applied last, over the template and defaults. */
  overrides?: Record<string, unknown>;
  /** Pick the theme colour from each portrait. Default true. */
  autoColor?: boolean;
  /**
   * prominent (default): the biggest colour area, pushed vivid. natural: the same, calmer.
   * highlight: the brightest accent in the portrait.
   */
  colorStyle?: ColorStyle;
  /** Actor name or id -> "#rrggbb", wins over the picked colour. */
  colorOverrides?: Record<string, string>;
  /** skip (default) leaves actors that already have cut-in data untouched. */
  onExisting?: 'skip' | 'overwrite';
  /** Default true: report what would change without writing. */
  dryRun?: boolean;
  /** Process at most this many matching actors. */
  limit?: number;
  /**
   * compact (default): only actors that change, without images, skipped ones counted by reason.
   * full: every actor, with its portrait path and the colour each style would pick.
   */
  detail?: 'compact' | 'full';
}

export interface CutInActorResult {
  id: string;
  name: string;
  type: string;
  folder: string | null;
  status: 'would-apply' | 'applied' | 'skipped' | 'error';
  reason?: string;
  color?: string;
  colorSource?: 'portrait' | 'fallback' | 'override' | 'template' | 'overrides';
  /** Only with detail "full": the colour each style would pick for this portrait. */
  options?: Record<ColorStyle, string>;
  /** Only with detail "full". */
  image?: string;
}

export interface ApplyCutInTemplateDeps {
  /** Reads RGBA pixels of a portrait. Injected in tests. */
  readPixels?: (path: string) => Promise<ArrayLike<number>>;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function isEmpty(v: unknown): boolean {
  return v == null || (typeof v === 'object' && Object.keys(v).length === 0);
}

function clone<T>(v: T): T {
  return foundry.utils.deepClone(v);
}

function folderPath(folder: any): string | null {
  const parts: string[] = [];
  for (let f = folder, guard = 0; f && guard < 20; f = f.folder, guard++) parts.unshift(f.name);
  return parts.length ? parts.join('/') : null;
}

function resolveFolderIds(query: string): { ids: Set<string> } | { error: string } {
  const all: any[] = (game as any).folders?.filter((f: any) => f.type === 'Actor') ?? [];
  const q = query.trim().toLowerCase();
  const matches = all.filter(
    f => f.id === query || f.name.toLowerCase() === q || (folderPath(f) ?? '').toLowerCase() === q
  );
  if (matches.length === 0) {
    const names = all
      .map(f => folderPath(f))
      .filter(Boolean)
      .sort()
      .slice(0, 40);
    return {
      error: `Actor folder not found: "${query}". Folders: ${names.join(', ') || '(none)'}`,
    };
  }
  const ids = new Set<string>();
  for (const m of matches) {
    ids.add(m.id);
    // Descendants: walk children rather than relying on a version-specific helper.
    const stack: any[] = [m];
    while (stack.length) {
      const f = stack.pop();
      for (const child of f.children ?? []) {
        const folder = child.folder ?? child;
        if (folder?.id && !ids.has(folder.id)) {
          ids.add(folder.id);
          stack.push(folder);
        }
      }
    }
  }
  return { ids };
}

/** Loads a portrait in the browser and returns its pixels at a small size. */
export async function readPortraitPixels(path: string): Promise<ArrayLike<number>> {
  if (/^[a-z]+:\/\//i.test(path) && !path.startsWith(window.location.origin)) {
    throw new Error('external image (cannot be read)');
  }
  const url = foundry.utils.getRoute(path.replace(/^\/+/, ''));
  const img = new Image();
  img.src = url;
  await Promise.race([
    img.decode(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('image load timed out')), 8000)),
  ]);
  const max = 96;
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas context');
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

export async function applyCutInTemplate(
  input: ApplyCutInTemplateInput,
  deps: ApplyCutInTemplateDeps = {}
): Promise<any> {
  const dryRun = input.dryRun !== false;
  const autoColor = input.autoColor !== false;
  const onExisting = input.onExisting ?? 'skip';
  const readPixels = deps.readPixels ?? readPortraitPixels;

  if (!(game as any).modules?.get(CUT_IN_MODULE_ID)?.active) {
    return { success: false, error: 'Cinematic Cut-ins is not installed or not active' };
  }

  for (const [key, hex] of Object.entries(input.colorOverrides ?? {})) {
    if (!HEX.test(hex)) {
      return { success: false, error: `colorOverrides["${key}"] must be "#rrggbb", got "${hex}"` };
    }
  }

  // Base config: a template actor's active configuration, or the built-in default.
  let base: Record<string, unknown>;
  let templateName: string | null = null;
  if (input.templateActor) {
    const ident = input.templateActor.toLowerCase();
    const tpl = (game as any).actors.find(
      (a: any) => a.id === input.templateActor || a.name.toLowerCase() === ident
    );
    const tplConfig = tpl?.getFlag(CUT_IN_MODULE_ID, 'config');
    if (!tpl) return { success: false, error: `Template actor not found: ${input.templateActor}` };
    if (isEmpty(tplConfig)) {
      return { success: false, error: `Template actor "${tpl.name}" has no cut-in configuration` };
    }
    base = clone(tplConfig);
    templateName = tpl.name;
  } else {
    base = clone(DEFAULT_CUT_IN_CONFIG);
  }
  const baseConfig = { ...base, ...clone(CRIT_DEFAULTS), ...clone(input.overrides ?? {}) };
  const overridesColor = !!input.overrides && 'color' in input.overrides;

  // Which actors.
  let candidates: any[] = (game as any).actors.contents.slice();
  const types = input.types ?? ['character', 'npc'];
  if (!types.includes('*')) candidates = candidates.filter(a => types.includes(a.type));
  if (input.folder) {
    const folders = resolveFolderIds(input.folder);
    if ('error' in folders) return { success: false, error: folders.error };
    candidates = candidates.filter(a => a.folder && folders.ids.has(a.folder.id));
  }
  if (input.actors?.length) {
    const wanted = new Set(input.actors.map(s => s.toLowerCase()));
    candidates = candidates.filter(
      a => wanted.has(a.id.toLowerCase()) || wanted.has(a.name.toLowerCase())
    );
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  if (input.limit && input.limit > 0) candidates = candidates.slice(0, input.limit);

  const results: CutInActorResult[] = [];
  for (const actor of candidates) {
    const row: CutInActorResult = {
      id: actor.id,
      name: actor.name,
      type: actor.type,
      folder: folderPath(actor.folder),
      status: dryRun ? 'would-apply' : 'applied',
    };
    try {
      const existingConfig = actor.getFlag(CUT_IN_MODULE_ID, 'config');
      const existingTriggers = actor.getFlag(CUT_IN_MODULE_ID, 'triggers');
      const existingChat: any[] = Array.isArray(existingTriggers?.chat)
        ? existingTriggers.chat
        : Object.values(existingTriggers?.chat ?? {});
      const hasCrit = existingChat.some(t => t?.trigger === 'onCrit');

      if (onExisting === 'skip' && (hasCrit || !isEmpty(existingConfig))) {
        row.status = 'skipped';
        row.reason = hasCrit
          ? 'already has a crit trigger'
          : 'already has a cut-in config but no crit trigger';
        results.push(row);
        continue;
      }

      // Colour: explicit override > portrait > template/default colour.
      const manual = input.colorOverrides?.[actor.name] ?? input.colorOverrides?.[actor.id];
      let color = baseConfig.color as string;
      if (manual) {
        color = manual;
        row.colorSource = 'override';
      } else if (overridesColor) {
        row.colorSource = 'overrides';
      } else if (autoColor) {
        try {
          const all = pickAllPortraitColors(await readPixels(actor.img));
          const picked: PortraitColor = all[input.colorStyle ?? 'prominent'];
          color = picked.hex;
          row.colorSource = picked.fallback ? 'fallback' : 'portrait';
          row.options = {
            prominent: all.prominent.hex,
            natural: all.natural.hex,
            highlight: all.highlight.hex,
          };
        } catch (err) {
          color = FALLBACK_COLOR;
          row.colorSource = 'fallback';
          row.reason = `portrait unreadable: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        row.colorSource = 'template';
      }
      row.color = color;
      row.image = actor.img;

      const config = { ...clone(baseConfig), img: actor.img, color };
      const triggers = {
        ...clone(EMPTY_TRIGGERS),
        ...clone(existingTriggers ?? {}),
        chat: [
          ...existingChat.filter(t => t?.trigger !== 'onCrit').map(clone),
          clone(CRIT_TRIGGER),
        ],
      };

      if (!dryRun) {
        if (!isEmpty(existingConfig)) await actor.unsetFlag(CUT_IN_MODULE_ID, 'config');
        await actor.setFlag(CUT_IN_MODULE_ID, 'config', config);
        await actor.setFlag(CUT_IN_MODULE_ID, 'triggers', triggers);
      }
    } catch (err) {
      row.status = 'error';
      row.reason = err instanceof Error ? err.message : String(err);
    }
    results.push(row);
  }

  const count = (s: CutInActorResult['status']) => results.filter(r => r.status === s).length;

  const skippedReasons: Record<string, number> = {};
  for (const r of results) {
    if (r.status === 'skipped') {
      const key = r.reason ?? 'skipped';
      skippedReasons[key] = (skippedReasons[key] ?? 0) + 1;
    }
  }

  // Compact by default: a whole-world run is hundreds of actors, and most are skipped.
  const full = input.detail === 'full';
  const rows = full
    ? results
    : results
        .filter(r => r.status !== 'skipped')
        .map(({ image: _image, options: _options, ...rest }) => rest);

  return {
    success: true,
    dryRun,
    colorStyle: input.colorStyle ?? 'prominent',
    template: templateName ?? 'built-in default',
    summary: {
      matched: results.length,
      applied: count('applied'),
      wouldApply: count('would-apply'),
      skipped: count('skipped'),
      errors: count('error'),
      skippedReasons,
    },
    results: rows,
  };
}
