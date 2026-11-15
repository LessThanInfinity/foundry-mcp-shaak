/**
 * Foundry MCP Bridge: give one actor a crit cut-in animation.
 *
 * HOW TO USE
 *   1. In Foundry, create a new macro, set its Type to "Script", and paste this whole file in.
 *   2. Change the settings just below, then run it as a GM.
 *
 * It does the same thing as Claude's apply-cut-in-template tool, for a single actor:
 * the actor gets a Cinematic Cut-ins active configuration (their own portrait, their name,
 * a theme colour picked from the portrait) and an "onCrit" trigger, so a critical-success
 * attack plays it.
 *
 * Needs: Cinematic Cut-ins and Foundry MCP Bridge active, and "Allow Write Operations"
 * turned on in the bridge's settings (unless PREVIEW_ONLY is true).
 */

// ================================ SETTINGS ================================

// Which actor: an actor id, an "Actor.xxxx" UUID, or the exact name.
// Leave empty ("") to use the actor of the token you have selected.
const ACTOR = '';

// How the theme colour is chosen from the portrait:
//   "prominent" - the biggest colour in the portrait, pushed bright so it pops (default)
//   "natural"   - the same colour, calmer
//   "highlight" - the brightest accent in the portrait (a glow, trim, eyes)
const STYLE = 'prominent';

// Force a colour instead, e.g. "#f5980c". Leave empty ("") to pick from the portrait.
const COLOR = '';

// true  = replace the actor's existing cut-in settings
// false = leave the actor alone if it already has cut-in settings
const OVERWRITE = true;

// true = only show the colour each style would pick, and change nothing
const PREVIEW_ONLY = false;

// How long the cut-in plays (seconds) and the sound that plays with it.
const DURATION = 2.5;
const SFX = 'upload/Sounds/persona_5_crit_sound.mp3';

// ==========================================================================

const STYLES = ['prominent', 'natural', 'highlight'];
const api = game.modules.get('foundry-mcp-bridge')?.api;

if (!api?.applyCutIn) {
  ui.notifications.error(
    'Foundry MCP Bridge is not active, or is too old to apply cut-ins. Update the module.'
  );
  return;
}
if (!STYLES.includes(STYLE)) {
  ui.notifications.error(`STYLE must be one of: ${STYLES.join(', ')} (got "${STYLE}")`);
  return;
}
if (COLOR && !/^#[0-9a-fA-F]{6}$/.test(COLOR)) {
  ui.notifications.error(`COLOR must look like #f5980c, or be empty (got "${COLOR}")`);
  return;
}

let actor = null;
if (ACTOR) {
  actor = game.actors.get(ACTOR.replace(/^Actor\./, '')) ?? game.actors.getName(ACTOR);
} else {
  actor = canvas.tokens?.controlled?.[0]?.actor ?? null;
}
if (!actor) {
  ui.notifications.warn(
    ACTOR
      ? `No actor found for "${ACTOR}".`
      : 'No actor: set ACTOR at the top of the macro, or select a token first.'
  );
  return;
}

let result;
try {
  result = await api.applyCutIn({
    actors: [actor.id],
    colorStyle: STYLE,
    colorOverrides: COLOR ? { [actor.id]: COLOR } : undefined,
    onExisting: OVERWRITE ? 'overwrite' : 'skip',
    dryRun: PREVIEW_ONLY,
    detail: 'full',
    overrides: { customDuration: DURATION, sfx: SFX, sfxList: { 0: SFX } },
  });
} catch (error) {
  ui.notifications.error(`Cut-in failed: ${error?.message ?? error}`);
  return;
}

if (!result?.success) {
  ui.notifications.error(`Cut-in failed: ${result?.error ?? 'unknown error'}`);
  return;
}

const row = result.results?.[0];
if (!row) {
  ui.notifications.warn(`${actor.name}: nothing was done.`);
} else if (row.status === 'skipped') {
  ui.notifications.warn(`${actor.name}: ${row.reason}. Set OVERWRITE = true to replace it.`);
} else if (row.status === 'error') {
  ui.notifications.error(`${actor.name}: ${row.reason}`);
} else if (PREVIEW_ONLY) {
  const o = row.options;
  ui.notifications.info(
    o
      ? `${actor.name} would get ${row.color}. Prominent ${o.prominent}, natural ${o.natural}, highlight ${o.highlight}.`
      : `${actor.name} would get ${row.color}.`
  );
} else {
  const note = row.reason ? ` (${row.reason})` : '';
  ui.notifications.info(`${actor.name}: crit cut-in applied, colour ${row.color}${note}.`);
}
