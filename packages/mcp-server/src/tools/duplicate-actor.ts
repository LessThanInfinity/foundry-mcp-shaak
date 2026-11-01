/**
 * Duplicate Actor Tool
 *
 * Exact clones of an actor, including items, effects and flags, as named copies
 * placed in (nested) folders. manage-actors "create" only copies name/img/system.
 */

import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface DuplicateActorToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const DUPLICATE_ACTOR_TIMEOUT_MS = 90000;

const copySchema = z
  .object({
    name: z.string().min(1),
    folder: z.string().min(1).optional(),
    notes: z.string().optional(),
    img: z.string().min(1).optional(),
    system: z.record(z.unknown()).optional(),
  })
  .strict();

const duplicateActorSchema = z
  .object({
    source: z.string().min(1),
    copies: z.array(copySchema).min(1).max(50),
    folder: z.string().min(1).optional(),
    notesField: z.enum(['private', 'public', 'biography']).default('private'),
  })
  .strict();

export class DuplicateActorTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: DuplicateActorToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'DuplicateActorTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'duplicate-actor',
        description:
          'Create exact clones of an existing actor, keeping its items (strikes, abilities, ' +
          'spells), effects and module flags. Each copy gets its own name, optional folder, ' +
          'notes, image and system overrides. The source actor is not modified. GM-only, needs ' +
          'Allow Write Operations.\n' +
          '- "source": actor UUID, id or name.\n' +
          '- "copies": 1 to 50 of { name, folder?, notes?, img?, system? }.\n' +
          '- "folder": a path like "racing drakes/Racing Event"; each level is found or created ' +
          'as a nested Actor folder. A copy\'s own "folder" overrides the top-level default.\n' +
          '- "notes": HTML appended to the copy\'s existing notes, in the field chosen by ' +
          '"notesField" (PF2e: private = system.details.privateNotes, public = publicNotes, ' +
          'biography = biography.value; default private).\n' +
          '- "system": deep-merged over the copy\'s system data (e.g. {"details":{"level":' +
          '{"value":13}}}).',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Actor UUID, id or name to clone.' },
            copies: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  folder: { type: 'string', description: 'Folder path, e.g. "a/b/c".' },
                  notes: { type: 'string', description: 'HTML appended to existing notes.' },
                  img: { type: 'string' },
                  system: { type: 'object', description: 'Deep-merge overrides for system.' },
                },
                required: ['name'],
              },
            },
            folder: { type: 'string', description: 'Default folder path for copies without one.' },
            notesField: { type: 'string', enum: ['private', 'public', 'biography'] },
          },
          required: ['source', 'copies'],
        },
      },
    ];
  }

  async handleDuplicateActor(args: unknown) {
    const parsed = duplicateActorSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    this.logger.info('Duplicating actor', {
      source: parsed.data.source,
      copies: parsed.data.copies.length,
    });
    try {
      return await this.foundryClient.query(
        'foundry-mcp-bridge.duplicateActor',
        parsed.data,
        DUPLICATE_ACTOR_TIMEOUT_MS
      );
    } catch (error) {
      this.logger.error('Failed to duplicate actor', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
