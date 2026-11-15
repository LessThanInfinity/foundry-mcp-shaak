/**
 * Cinematic Cut-ins tools
 *
 *   - apply-cut-in-template: bulk-give actors a crit animation (the "active configuration"
 *                            plus an onCrit trigger), with a theme colour picked from each
 *                            actor's portrait. Dry run by default.
 *
 * For one-off reads and edits of an actor's cut-in data use manage-flags with scope
 * "cinematic-cut-ins".
 */

import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface CutInToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be "#rrggbb"');

const applyCutInTemplateSchema = z
  .object({
    folder: z.string().min(1).optional(),
    actors: z.array(z.string().min(1)).min(1).optional(),
    types: z.array(z.string().min(1)).min(1).optional(),
    templateActor: z.string().min(1).optional(),
    overrides: z.record(z.unknown()).optional(),
    autoColor: z.boolean().optional(),
    colorStyle: z.enum(['prominent', 'natural', 'highlight']).optional(),
    detail: z.enum(['compact', 'full']).optional(),
    colorOverrides: z.record(hexColor).optional(),
    onExisting: z.enum(['skip', 'overwrite']).optional(),
    dryRun: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export class CutInTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: CutInToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'CutInTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'apply-cut-in-template',
        description:
          'Bulk-add a Cinematic Cut-ins crit animation to many actors at once. Each actor gets an ' +
          "active configuration (the actor's own portrait, main text = {{name}}, sub text hidden, " +
          '2.5 s, the Persona-5 crit SFX) and one "onCrit" trigger that plays it on a PF2e ' +
          'critical-success attack. The theme colour is picked automatically from each ' +
          "actor's portrait (see colorStyle).\n" +
          'DRY RUN BY DEFAULT: nothing is written unless dryRun is false, so call it once to review ' +
          'the per-actor colours, fix any with colorOverrides, then call again with dryRun false. ' +
          'Actors that already have cut-in data are skipped unless onExisting is "overwrite". ' +
          'Target all actors (default: characters and NPCs) or a folder (includes subfolders). ' +
          'Writing is GM-only and needs Allow Write Operations; requires Cinematic Cut-ins to be ' +
          'active. For one-off edits of a single actor use manage-flags instead.',
        inputSchema: {
          type: 'object',
          properties: {
            folder: {
              type: 'string',
              description:
                'Actor folder name, id or "Parent/Child" path. Includes subfolders. Omit for all actors.',
            },
            actors: {
              type: 'array',
              items: { type: 'string' },
              description: 'Only these actor names or ids. With folder, an actor must match both.',
            },
            types: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Actor types to include. Default ["character","npc"]. Use ["*"] for every type (loot, hazards, ...).',
            },
            templateActor: {
              type: 'string',
              description:
                "Copy this actor's existing cut-in configuration as the base instead of the built-in default.",
            },
            overrides: {
              type: 'object',
              description:
                'Cut-in config fields applied last, e.g. {"customDuration": 3, "theme": "cleave"}.',
            },
            autoColor: {
              type: 'boolean',
              description: 'Pick the theme colour from each portrait. Default true.',
            },
            colorStyle: {
              type: 'string',
              enum: ['prominent', 'natural', 'highlight'],
              description:
                'How the theme colour is chosen. prominent (default): the biggest colour in the portrait, pushed bright and saturated so it pops. natural: the same colour, calmer. highlight: the brightest accent in the portrait (glow, trim, eyes), which tends to contrast with the character.',
            },
            detail: {
              type: 'string',
              enum: ['compact', 'full'],
              description:
                'compact (default): only actors that change, skipped ones counted by reason. full: every actor with its portrait path and the colour each style would pick (large for a whole world; use limit or a folder).',
            },
            colorOverrides: {
              type: 'object',
              description:
                'Actor name or id -> "#rrggbb". Wins over the picked colour, e.g. {"Taka": "#439cbe"}.',
            },
            onExisting: {
              type: 'string',
              enum: ['skip', 'overwrite'],
              description:
                'skip (default) leaves actors that already have cut-in data untouched; overwrite replaces their config and crit trigger (other triggers are kept).',
            },
            dryRun: {
              type: 'boolean',
              description: 'Default true. Set false to actually write.',
            },
            limit: {
              type: 'number',
              description: 'Process at most this many matching actors (useful for a first trial).',
            },
          },
        },
      },
    ];
  }

  async handleApplyCutInTemplate(args: unknown) {
    const parsed = applyCutInTemplateSchema.safeParse(args ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    this.logger.info('Applying cut-in template', {
      folder: parsed.data.folder,
      types: parsed.data.types,
      onExisting: parsed.data.onExisting,
      dryRun: parsed.data.dryRun !== false,
      limit: parsed.data.limit,
    });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.applyCutInTemplate', parsed.data);
    } catch (error) {
      this.logger.error('Failed to apply cut-in template', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
