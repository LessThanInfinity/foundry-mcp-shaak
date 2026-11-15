/**
 * What this world tells the MCP server about itself, and how the Connection Status panel
 * describes the connection. Kept free of Foundry globals (except in collectHello) so the
 * wording and the rules are unit-testable.
 */

import { MODULE_ID } from './constants.js';

/** Hook fired whenever the bridge's connection or status changes (the panel re-renders on it). */
export const STATUS_CHANGED_HOOK = `${MODULE_ID}.statusChanged`;

export interface HelloData {
  worldId: string;
  worldTitle: string;
  systemId: string;
  systemVersion: string;
  foundryVersion: string;
  moduleVersion: string;
  userName: string;
  /** The address this Foundry page is open at, so copies of the same world can be told apart. */
  origin: string;
  /** Registered query names without the module prefix; lets the server explain a missing tool. */
  methods: string[];
}

/** One connected world, as reported by the MCP server (mirrors the server's summary). */
export interface BridgeWorld {
  connectionId: string;
  active: boolean;
  /** the world you last chose; it is restored when it reconnects */
  preferred?: boolean;
  transport: string;
  connectedAt: string;
  identified: boolean;
  label: string;
  worldId: string | null;
  worldTitle: string | null;
  /** Page address this world is open at, when it said so. */
  origin?: string | null;
  systemId: string | null;
  systemVersion: string | null;
  foundryVersion: string | null;
  moduleVersion: string | null;
  userName: string | null;
  toolCount: number | null;
}

/** The server's `bridge-status` message payload. */
export interface BridgeStatus {
  connectionId: string;
  active: boolean;
  activeConnectionId: string | null;
  serverVersion: string | null;
  worlds: BridgeWorld[];
}

/** Reads this world's identity from Foundry. Only called in the browser. */
export function collectHello(): HelloData {
  const g = game as any;
  const prefix = `${MODULE_ID}.`;
  return {
    worldId: String(g.world?.id ?? ''),
    worldTitle: String(g.world?.title ?? g.world?.id ?? ''),
    systemId: String(g.system?.id ?? ''),
    systemVersion: String(g.system?.version ?? ''),
    foundryVersion: String(g.version ?? g.release?.version ?? ''),
    moduleVersion: String(g.modules?.get(MODULE_ID)?.version ?? ''),
    userName: String(g.user?.name ?? ''),
    origin: typeof window !== 'undefined' ? String(window.location?.origin ?? '') : '',
    methods: Object.keys((CONFIG as any).queries ?? {})
      .filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length)),
  };
}

/** "http://localhost:30000" -> "localhost:30000"; anything unparseable is returned as is. */
function hostOfOrigin(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

export type StatusTone = 'ok' | 'standby' | 'warn' | 'off';

export interface StatusInput {
  enabled: boolean;
  connectionState: string;
  connectionType: string | null;
  host: string;
  port: number;
  world: { title: string; id: string; systemId: string; systemVersion: string; foundry: string };
  moduleVersion: string;
  methods: string[];
  bridgeStatus: BridgeStatus | null;
}

export interface StatusWorldRow {
  connectionId: string;
  label: string;
  you: boolean;
  active: boolean;
  /** the world you last chose */
  remembered: boolean;
  /** where it is open, e.g. localhost:30000 (empty for older modules) */
  address: string;
  transport: string;
  system: string;
  moduleVersion: string;
}

export interface StatusViewModel {
  tone: StatusTone;
  headline: string;
  detail: string;
  world: StatusInput['world'];
  moduleVersion: string;
  server: { host: string; port: number; version: string; transport: string };
  toolCount: number;
  hasCutInTool: boolean;
  worlds: StatusWorldRow[];
  canMakeActive: boolean;
  canConnect: boolean;
  canDisconnect: boolean;
}

export function buildStatusViewModel(input: StatusInput): StatusViewModel {
  const { bridgeStatus: bs } = input;
  const connected = input.connectionState === 'connected';
  const other = bs?.worlds.find(w => w.active && w.connectionId !== bs.connectionId);

  let tone: StatusTone;
  let headline: string;
  let detail: string;

  if (!input.enabled) {
    tone = 'off';
    headline = 'Bridge turned off';
    detail = 'Enable the bridge in this world’s module settings, or use Connect below.';
  } else if (!connected) {
    tone = 'warn';
    headline = input.connectionState === 'reconnecting' ? 'Reconnecting…' : 'Not connected';
    detail =
      `Can’t reach the MCP server at ${input.host}:${input.port}. ` +
      'Check that Claude has the foundry-mcp server running, then press Connect.';
  } else if (!bs) {
    tone = 'ok';
    headline = 'Connected';
    detail =
      'The MCP server did not report which world is active. It is probably an older version, ' +
      'so only one world can be connected at a time.';
  } else if (bs.active) {
    tone = 'ok';
    headline = 'Connected — this world is ACTIVE';
    detail =
      bs.worlds.length > 1
        ? 'Claude is talking to this world. Other connected worlds are on standby.'
        : 'Claude is talking to this world.';
  } else {
    tone = 'standby';
    headline = 'Connected — STANDBY';
    detail =
      `Claude is currently talking to “${other?.label ?? 'another world'}”, not this one. ` +
      'Use Make this world active to switch.';
  }

  return {
    tone,
    headline,
    detail,
    world: input.world,
    moduleVersion: input.moduleVersion,
    server: {
      host: input.host,
      port: input.port,
      version: bs?.serverVersion ?? 'unknown',
      transport: input.connectionType ?? '—',
    },
    toolCount: input.methods.length,
    hasCutInTool: input.methods.includes('applyCutInTemplate'),
    worlds: (bs?.worlds ?? []).map(w => ({
      connectionId: w.connectionId,
      label: w.label,
      you: w.connectionId === bs?.connectionId,
      active: w.active,
      remembered: !!w.preferred,
      address: w.origin ? hostOfOrigin(w.origin) : '',
      transport: w.transport,
      system: [w.systemId, w.systemVersion].filter(Boolean).join(' ') || '—',
      moduleVersion: w.moduleVersion ?? 'unknown (older module)',
    })),
    canMakeActive: connected && !!bs && !bs.active,
    canConnect: !connected,
    canDisconnect: connected || input.connectionState === 'reconnecting',
  };
}

/** Plain-text copy of the status, for pasting into a bug report or to Claude. */
export function formatDiagnostics(vm: StatusViewModel): string {
  const lines = [
    `Foundry MCP Bridge ${vm.moduleVersion}`,
    `Status: ${vm.headline}`,
    vm.detail,
    '',
    `This world: ${vm.world.title} (${vm.world.id})`,
    `System: ${vm.world.systemId} ${vm.world.systemVersion}, Foundry ${vm.world.foundry}`,
    `Server: ${vm.server.host}:${vm.server.port} (version ${vm.server.version}, ${vm.server.transport})`,
    `Tools in this world’s module: ${vm.toolCount} (cut-in tool: ${vm.hasCutInTool ? 'yes' : 'no'})`,
    '',
    'Connected worlds:',
    ...(vm.worlds.length
      ? vm.worlds.map(
          w =>
            `- ${w.connectionId} ${w.label}${w.address ? ` @ ${w.address}` : ''}${w.you ? ' [this world]' : ''}${w.active ? ' [ACTIVE]' : ''}${w.remembered ? ' [remembered]' : ''}` +
            ` — ${w.system}, module ${w.moduleVersion}, ${w.transport}`
        )
      : ['(none reported)']),
  ];
  return lines.join('\n');
}
