/**
 * Registry of the Foundry worlds currently connected to the MCP server.
 *
 * More than one Foundry world can be open at once (for example a hosted world and a
 * local copy). Each one is a separate bridge connection; exactly one of them is
 * "active" and receives the queries Claude makes. This class holds that state and the
 * rules for it, with no sockets involved so it can be tested directly:
 *
 *   - the first connection becomes active, and a newly connected world never takes over
 *   - the active connection changes only when someone selects another one
 *   - that choice is remembered (as a "preferred" world), so a reload, a dropped
 *     connection or a server restart puts the chosen world back in charge when it returns
 *   - if the active connection drops, the preferred world (if connected), otherwise the
 *     oldest remaining one, is promoted
 */

export type BridgeTransport = 'websocket' | 'webrtc';

/** What a world says about itself in its `hello` message (or what we learn by asking). */
export interface WorldIdentity {
  worldId?: string;
  worldTitle?: string;
  systemId?: string;
  systemVersion?: string;
  foundryVersion?: string;
  moduleVersion?: string;
  userName?: string;
  /** The address of the Foundry page, e.g. "http://localhost:30000". Tells copies of a world apart. */
  origin?: string;
  /** Query method names the world's module has registered, without the module prefix. */
  methods?: string[];
}

export interface BridgeConnection {
  id: string;
  transport: BridgeTransport;
  connectedAt: number;
  remoteAddress?: string | undefined;
  identity: WorldIdentity | null;
}

export interface ConnectionSummary {
  connectionId: string;
  active: boolean;
  /** true when this is the world you last chose, so it is restored when it reconnects */
  preferred: boolean;
  transport: BridgeTransport;
  connectedAt: string;
  /** false for older modules that never announced which world they belong to */
  identified: boolean;
  label: string;
  worldId: string | null;
  worldTitle: string | null;
  /** Page address of the Foundry this world is open in, when it said so. */
  origin: string | null;
  systemId: string | null;
  systemVersion: string | null;
  foundryVersion: string | null;
  moduleVersion: string | null;
  userName: string | null;
  toolCount: number | null;
}

export interface RemoveResult {
  removed: boolean;
  wasActive: boolean;
  promoted: BridgeConnection | null;
}

/** "http://localhost:30000" -> "localhost:30000"; anything unparseable is returned as is. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/**
 * Stable identity of a world across reconnects: the world id plus where it is open.
 * Null for worlds that did not say both (older modules), which therefore cannot be remembered.
 */
export function worldKey(c: BridgeConnection): string | null {
  const i = c.identity;
  return i?.worldId && i.origin ? `${i.origin}|${i.worldId}` : null;
}

export class ConnectionRegistry {
  private connections = new Map<string, BridgeConnection>();
  private activeId: string | null = null;
  private counter = 0;

  constructor(
    private now: () => number = Date.now,
    private preferredKey: string | null = null
  ) {}

  add(transport: BridgeTransport, remoteAddress?: string): BridgeConnection {
    const connection: BridgeConnection = {
      id: `c${++this.counter}`,
      transport,
      connectedAt: this.now(),
      remoteAddress,
      identity: null,
    };
    this.connections.set(connection.id, connection);
    if (this.activeId === null) this.activeId = connection.id;
    return connection;
  }

  remove(id: string): RemoveResult {
    if (!this.connections.delete(id)) {
      return { removed: false, wasActive: false, promoted: null };
    }
    const wasActive = this.activeId === id;
    let promoted: BridgeConnection | null = null;
    if (wasActive) {
      promoted = this.preferredConnection() ?? this.oldest();
      this.activeId = promoted?.id ?? null;
    }
    return { removed: true, wasActive, promoted };
  }

  /**
   * Records what a world said about itself. Returns true if this made it the active world,
   * which happens when it is the world the user last chose.
   */
  setIdentity(id: string, identity: WorldIdentity): boolean {
    const connection = this.connections.get(id);
    if (!connection) return false;
    connection.identity = { ...(connection.identity ?? {}), ...identity };

    const key = worldKey(connection);
    if (key !== null && key === this.preferredKey && this.activeId !== id) {
      this.activeId = id;
      return true;
    }
    return false;
  }

  get(id: string): BridgeConnection | undefined {
    return this.connections.get(id);
  }

  getActive(): BridgeConnection | null {
    return this.activeId ? (this.connections.get(this.activeId) ?? null) : null;
  }

  /** The remembered choice (see worldKey), for saving between runs. */
  getPreferredKey(): string | null {
    return this.preferredKey;
  }

  get size(): number {
    return this.connections.size;
  }

  all(): BridgeConnection[] {
    return [...this.connections.values()].sort((a, b) => a.connectedAt - b.connectedAt);
  }

  /**
   * Finds a connection by connection id, world id, world title or page address (exact,
   * case-insensitive, then a unique fragment). Throws a readable error if nothing or
   * several match.
   */
  resolve(query: string): BridgeConnection {
    const q = query.trim().toLowerCase();
    if (!q) throw new Error('A world name, world id or connection id is required');
    const all = this.all();

    const tiers: Array<(c: BridgeConnection) => boolean> = [
      c => c.id.toLowerCase() === q,
      c => c.identity?.worldId?.toLowerCase() === q,
      c => c.identity?.worldTitle?.toLowerCase() === q,
      c => !!c.identity?.worldTitle?.toLowerCase().includes(q),
      c => !!c.identity?.origin?.toLowerCase().includes(q),
    ];
    for (const matches of tiers) {
      const found = all.filter(matches);
      if (found.length === 1) return found[0];
      if (found.length > 1) {
        const names = found.map(c => `${c.id} (${labelOf(c)})`).join(', ');
        throw new Error(
          `"${query}" matches more than one connected world: ${names}. Use a connection id such as "${found[0].id}".`
        );
      }
    }

    const known = all.length
      ? all.map(c => `${c.id} (${labelOf(c)})`).join(', ')
      : 'none connected';
    throw new Error(`No connected world matches "${query}". Connected worlds: ${known}.`);
  }

  /**
   * Makes the matching connection the active one, and remembers it as the preferred world
   * (or forgets the preference, if that world cannot be told apart from others).
   */
  select(query: string): BridgeConnection {
    const connection = this.resolve(query);
    this.choose(connection);
    return connection;
  }

  /** Same as select, for a connection that asked to become active itself. */
  selectById(id: string): BridgeConnection | null {
    const connection = this.connections.get(id);
    if (!connection) return null;
    this.choose(connection);
    return connection;
  }

  /**
   * True unless the world announced its method list and this method is not on it.
   * Worlds on older modules never announce one, so they are always assumed to support it.
   */
  supports(connection: BridgeConnection, method: string, modulePrefix: string): boolean {
    const methods = connection.identity?.methods;
    if (!methods || methods.length === 0) return true;
    const bare = method.startsWith(`${modulePrefix}.`)
      ? method.slice(modulePrefix.length + 1)
      : method;
    return methods.includes(bare);
  }

  list(): ConnectionSummary[] {
    return this.all().map(c => this.summarise(c));
  }

  summarise(c: BridgeConnection): ConnectionSummary {
    const i = c.identity;
    const key = worldKey(c);
    return {
      connectionId: c.id,
      active: c.id === this.activeId,
      preferred: key !== null && key === this.preferredKey,
      transport: c.transport,
      connectedAt: new Date(c.connectedAt).toISOString(),
      identified: !!(i?.worldId || i?.worldTitle),
      label: labelOf(c),
      worldId: i?.worldId ?? null,
      worldTitle: i?.worldTitle ?? null,
      origin: i?.origin ?? null,
      systemId: i?.systemId ?? null,
      systemVersion: i?.systemVersion ?? null,
      foundryVersion: i?.foundryVersion ?? null,
      moduleVersion: i?.moduleVersion ?? null,
      userName: i?.userName ?? null,
      toolCount: i?.methods ? i.methods.length : null,
    };
  }

  private choose(connection: BridgeConnection): void {
    this.activeId = connection.id;
    this.preferredKey = worldKey(connection);
  }

  private preferredConnection(): BridgeConnection | null {
    if (this.preferredKey === null) return null;
    return this.all().find(c => worldKey(c) === this.preferredKey) ?? null;
  }

  private oldest(): BridgeConnection | null {
    return this.all()[0] ?? null;
  }
}

/** A readable name: the world's title, plus where it is open when that is known. */
export function labelOf(c: BridgeConnection): string {
  const title = c.identity?.worldTitle ?? c.identity?.worldId;
  if (!title) return `unidentified world on ${c.transport}`;
  return c.identity?.origin ? `${title} (${hostOf(c.identity.origin)})` : title;
}
