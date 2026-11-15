import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { Logger } from './logger.js';
import { Config } from './config.js';
import { WebRTCPeer } from './webrtc-peer.js';
import {
  ConnectionRegistry,
  labelOf,
  type BridgeTransport,
  type ConnectionSummary,
  type WorldIdentity,
} from './connection-registry.js';
import type { PreferredWorldStore } from './preferred-world-store.js';

/** Prefix the Foundry module puts on every query method (see foundry-module constants). */
const MODULE_PREFIX = 'foundry-mcp-bridge';
const DEFAULT_WEBRTC_SIGNALING_PORT = 31416;
/** A WebRTC offer that never produces an open data channel is dropped after this long. */
const WEBRTC_OPEN_TIMEOUT_MS = 60_000;

export interface FoundryConnectorOptions {
  config: Config['foundry'];
  logger: Logger;
  /** Reported to connected worlds so their status panel can show it. */
  serverVersion?: string | undefined;
  /** Port for HTTP WebRTC signaling. Tests use 0; the module expects 31416. */
  webrtcSignalingPort?: number | undefined;
  /** Remembers the world the user last chose, between runs. Omit to not persist it. */
  preferredWorldStore?: PreferredWorldStore | undefined;
}

interface PendingQuery {
  connectionId: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/** How to talk to one connected world, whatever the transport. */
interface ConnectionHandle {
  send(message: any): void;
  isOpen(): boolean;
  close(): void;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, 200) : undefined;
}

/** Only keeps the fields we understand from a world's `hello`, with sane limits. */
export function parseIdentity(data: any): WorldIdentity {
  const identity: WorldIdentity = {};
  const set = <K extends keyof WorldIdentity>(key: K, value: WorldIdentity[K] | undefined) => {
    if (value !== undefined) identity[key] = value;
  };
  set('worldId', str(data?.worldId));
  set('worldTitle', str(data?.worldTitle));
  set('systemId', str(data?.systemId));
  set('systemVersion', str(data?.systemVersion));
  set('foundryVersion', str(data?.foundryVersion));
  set('moduleVersion', str(data?.moduleVersion));
  set('userName', str(data?.userName));
  set('origin', str(data?.origin));
  if (Array.isArray(data?.methods)) {
    set(
      'methods',
      data.methods.filter((m: unknown) => typeof m === 'string').slice(0, 1000) as string[]
    );
  }
  return identity;
}

export class FoundryConnector {
  private wss: WebSocketServer | null = null;
  private httpServer: any;
  private webrtcSignalingServer: any; // Separate HTTP server for WebRTC signaling
  private logger: Logger;
  private config: Config['foundry'];
  private serverVersion: string | undefined;
  private webrtcSignalingPort: number;
  private isStarted = false;
  private registry: ConnectionRegistry;
  private preferredWorldStore: PreferredWorldStore | undefined;
  private handles = new Map<string, ConnectionHandle>();
  private pendingQueries = new Map<string, PendingQuery>();
  private queryIdCounter = 0;

  constructor({
    config,
    logger,
    serverVersion,
    webrtcSignalingPort,
    preferredWorldStore,
  }: FoundryConnectorOptions) {
    this.config = config;
    this.logger = logger.child({ component: 'FoundryConnector' });
    this.serverVersion = serverVersion;
    this.webrtcSignalingPort = webrtcSignalingPort ?? DEFAULT_WEBRTC_SIGNALING_PORT;
    this.preferredWorldStore = preferredWorldStore;
    this.registry = new ConnectionRegistry(Date.now, preferredWorldStore?.load() ?? null);
  }

  /** The port the WebSocket server is actually listening on (useful when started on 0). */
  getPort(): number | null {
    return this.httpServer?.address?.()?.port ?? null;
  }

  getWebRTCSignalingPort(): number | null {
    return this.webrtcSignalingServer?.address?.()?.port ?? null;
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.debug('Foundry connector already started');
      return;
    }

    this.logger.info('Starting Foundry connector WebSocket server', {
      port: this.config.port,
      protocol: this.config.protocol || 'ws',
      remoteMode: this.config.remoteMode || false,
    });

    // Create HTTP server for WebSocket connections
    this.httpServer = createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });

    // Create SEPARATE HTTP server for WebRTC signaling
    this.webrtcSignalingServer = createServer(async (req, res) => {
      // Set CORS headers for all requests
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      // Handle OPTIONS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Only handle POST to /webrtc-offer
      if (req.method === 'POST' && req.url === '/webrtc-offer') {
        try {
          await this.handleWebRTCOfferHTTP(req, res);
        } catch (error) {
          this.logger.error('WebRTC offer handling failed', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    // Start WebRTC signaling server
    await new Promise<void>((resolve, reject) => {
      this.webrtcSignalingServer.listen(this.webrtcSignalingPort, '0.0.0.0', () => {
        this.logger.info(
          `WebRTC signaling server listening on port ${this.getWebRTCSignalingPort()}`
        );
        console.error(`[WebRTC] Server started on 0.0.0.0:${this.getWebRTCSignalingPort()}`);
        resolve();
      });
      this.webrtcSignalingServer.on('error', (error: Error) => {
        this.logger.error('Failed to start WebRTC signaling server', error);
        console.error(`[WebRTC] Server error:`, error);
        reject(error);
      });
    });

    // Create WebSocket server in noServer mode to avoid request consumption
    this.wss = new WebSocketServer({ noServer: true });

    // Manually handle upgrade for WebSocket connections
    this.httpServer.on('upgrade', (req: any, socket: any, head: any) => {
      const pathname = req.url || '/';

      // Only upgrade if path matches WebSocket namespace
      if (pathname === (this.config.namespace || '/')) {
        this.wss?.handleUpgrade(req, socket, head, ws => {
          this.wss?.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    // Handle WebSocket connections (both signaling and direct WebSocket)
    this.wss.on('connection', (ws, req) => {
      this.logger.info('Client connected via WebSocket');

      // Register the connection immediately on connect, not on first message
      // This fixes Issue #19: WebSocket handshake deadlock where both sides
      // waited for the other to send a message first
      let connectionId: string | null = this.registerConnection(
        'websocket',
        {
          send: message => ws.send(JSON.stringify(message)),
          isOpen: () => ws.readyState === WebSocket.OPEN,
          close: () => ws.close(),
        },
        req?.socket?.remoteAddress
      ).id;

      ws.on('close', () => {
        this.logger.info('Client disconnected');
        if (connectionId) this.unregisterConnection(connectionId);
      });

      ws.on('message', async data => {
        try {
          const message = JSON.parse(data.toString());

          // Check if this is WebRTC signaling
          if (message.type === 'webrtc-offer') {
            // This socket only carries the handshake; the world will be the WebRTC peer.
            if (connectionId) this.unregisterConnection(connectionId);
            connectionId = null;
            await this.handleWebRTCOffer(message.offer, ws);
          } else if (connectionId) {
            // Regular WebSocket message - process it directly
            await this.handleMessage(connectionId, message);
          }
        } catch (error) {
          this.logger.error('Failed to parse message', error);
        }
      });

      ws.on('error', error => {
        this.logger.error('WebSocket error', error);
      });
    });

    // Start the HTTP server
    await new Promise<void>((resolve, reject) => {
      this.httpServer.listen(this.config.port, () => {
        this.isStarted = true;
        this.logger.info('Foundry connector listening', { port: this.getPort() });
        resolve();
      });

      this.httpServer.on('error', (error: Error) => {
        this.logger.error('Failed to start Foundry connector', error);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.isStarted) {
      return;
    }

    this.logger.info('Stopping Foundry connector...');

    // Reject all pending queries
    this.pendingQueries.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error('Server shutting down'));
    });
    this.pendingQueries.clear();

    for (const [id, handle] of [...this.handles]) {
      this.handles.delete(id);
      try {
        handle.close();
      } catch {
        // already closed
      }
    }
    for (const c of this.registry.all()) this.registry.remove(c.id);

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>(resolve => {
        this.httpServer.close(() => {
          resolve();
        });
      });
      this.httpServer = null;
    }

    if (this.webrtcSignalingServer) {
      await new Promise<void>(resolve => {
        this.webrtcSignalingServer.close(() => {
          resolve();
        });
      });
      this.webrtcSignalingServer = null;
    }

    this.isStarted = false;
    this.logger.info('Foundry connector stopped');
  }

  // ---------------------------------------------------------------- connections

  private registerConnection(
    transport: BridgeTransport,
    handle: ConnectionHandle,
    remoteAddress?: string
  ): { id: string } {
    const connection = this.registry.add(transport, remoteAddress);
    this.handles.set(connection.id, handle);
    const active = this.registry.getActive();
    this.logger.info('Foundry world connected', {
      connectionId: connection.id,
      transport,
      active: active?.id === connection.id,
      totalConnections: this.registry.size,
    });
    this.broadcastStatus();
    return { id: connection.id };
  }

  private unregisterConnection(connectionId: string): void {
    this.handles.delete(connectionId);
    const result = this.registry.remove(connectionId);
    if (!result.removed) return;

    // Fail everything still waiting on this world.
    for (const [queryId, pending] of this.pendingQueries) {
      if (pending.connectionId === connectionId) {
        clearTimeout(pending.timeout);
        this.pendingQueries.delete(queryId);
        pending.reject(new Error('Connection closed'));
      }
    }

    this.logger.info('Foundry world disconnected', {
      connectionId,
      wasActive: result.wasActive,
      promoted: result.promoted?.id ?? null,
      remaining: this.registry.size,
    });
    this.broadcastStatus();
  }

  /** Tells every connected world its own state and which worlds are connected. */
  broadcastStatus(): void {
    const worlds = this.registry.list();
    const active = this.registry.getActive();
    for (const connection of this.registry.all()) {
      const handle = this.handles.get(connection.id);
      if (!handle?.isOpen()) continue;
      try {
        handle.send({
          type: 'bridge-status',
          data: {
            connectionId: connection.id,
            active: active?.id === connection.id,
            activeConnectionId: active?.id ?? null,
            serverVersion: this.serverVersion ?? null,
            worlds,
          },
        });
      } catch (error) {
        this.logger.debug('Could not send bridge status', {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Saves the user's choice so it survives a server restart. */
  private persistPreference(): void {
    this.preferredWorldStore?.save(this.registry.getPreferredKey());
  }

  listConnections(): ConnectionSummary[] {
    return this.registry.list();
  }

  /**
   * Older modules never announce which world they belong to. Ask each of those directly
   * so they can be listed by name. Failures are ignored; the world stays "unidentified".
   */
  async identifyConnections(timeoutMs = 3000): Promise<void> {
    const unknown = this.registry
      .all()
      .filter(c => !c.identity?.worldId && !c.identity?.worldTitle);
    await Promise.all(
      unknown.map(async c => {
        try {
          const info = await this.query(`${MODULE_PREFIX}.getWorldInfo`, {}, timeoutMs, c.id);
          const identity = parseIdentity({
            worldId: info?.id,
            worldTitle: info?.title,
            systemId: info?.system,
            systemVersion: info?.systemVersion,
            foundryVersion: info?.foundryVersion,
          });
          this.registry.setIdentity(c.id, identity);
        } catch (error) {
          this.logger.debug('Could not identify world', {
            connectionId: c.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );
    this.broadcastStatus();
  }

  /** Makes the matching world the one Claude talks to. Throws a readable error if none match. */
  selectConnection(query: string): ConnectionSummary {
    const connection = this.registry.select(query);
    this.logger.info('Active Foundry world changed', {
      connectionId: connection.id,
      world: labelOf(connection),
    });
    this.persistPreference();
    this.broadcastStatus();
    return this.registry.summarise(connection);
  }

  // ------------------------------------------------------------------- messages

  private async handleMessage(connectionId: string, message: any): Promise<void> {
    if (message.type === 'hello') {
      const restored = this.registry.setIdentity(connectionId, parseIdentity(message.data));
      const connection = this.registry.get(connectionId);
      this.logger.info('Foundry world identified', {
        connectionId,
        world: connection ? labelOf(connection) : null,
        moduleVersion: connection?.identity?.moduleVersion,
        tools: connection?.identity?.methods?.length,
        restoredAsActive: restored,
      });
      this.broadcastStatus();
      return;
    }

    if (message.type === 'select-world') {
      if (this.registry.selectById(connectionId)) {
        this.logger.info('A world asked to become the active one', { connectionId });
        this.persistPreference();
        this.broadcastStatus();
      }
      return;
    }

    if (message.type === 'mcp-response' && message.id) {
      const pending = this.pendingQueries.get(message.id);
      if (pending && pending.connectionId === connectionId) {
        clearTimeout(pending.timeout);
        this.pendingQueries.delete(message.id);

        if (message.data.success) {
          this.logger.debug('Query response received', {
            id: message.id,
            hasData: !!message.data.data,
          });
          pending.resolve(message.data.data);
        } else {
          this.logger.error('Query failed', { id: message.id, error: message.data.error });
          pending.reject(new Error(message.data.error || 'Query failed'));
        }
      }
      return;
    }

    if (message.type === 'pong') {
      const pending = this.pendingQueries.get(message.id);
      if (pending && pending.connectionId === connectionId) {
        clearTimeout(pending.timeout);
        this.pendingQueries.delete(message.id);
        pending.resolve(message.data);
      }
      return;
    }

    // ComfyUI traffic only makes sense from the world Claude is working with.
    if (this.registry.getActive()?.id !== connectionId) {
      this.logger.debug('Ignoring message from a standby world', {
        connectionId,
        type: message.type,
      });
      return;
    }

    const comfyHandlers = (globalThis as any).backendComfyUIHandlers;
    if (comfyHandlers?.handleMessage) {
      this.logger.debug('Routing message to backend ComfyUI handlers', { type: message.type });
      try {
        await comfyHandlers.handleMessage(message);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('Failed to forward message to backendComfyUIHandlers', {
          type: message.type,
          error: errorMessage,
        });
      }
      return;
    }

    this.logger.debug('Received unknown message type', { type: message.type });
  }

  // --------------------------------------------------------------------- WebRTC

  /** Creates a peer whose world registers itself once its data channel is open. */
  private createWebRTCPeer(): WebRTCPeer {
    let connectionId: string | null = null;
    let openTimer: NodeJS.Timeout | null = null;

    const ensureRegistered = (): string => {
      if (!connectionId) {
        if (openTimer) clearTimeout(openTimer);
        connectionId = this.registerConnection('webrtc', {
          send: message => peer.sendMessage(message),
          isOpen: () => peer.getIsConnected(),
          close: () => peer.disconnect(),
        }).id;
      }
      return connectionId;
    };

    const peer: WebRTCPeer = new WebRTCPeer({
      config: this.config.webrtc,
      logger: this.logger,
      onMessage: message => this.handleMessage(ensureRegistered(), message),
      onOpen: () => {
        ensureRegistered();
      },
      onClose: () => {
        if (connectionId) this.unregisterConnection(connectionId);
      },
    });

    // An offer that never connects must not hold resources forever.
    openTimer = setTimeout(() => {
      if (!connectionId) {
        this.logger.warn('WebRTC peer never opened its data channel; dropping it');
        peer.disconnect();
      }
    }, WEBRTC_OPEN_TIMEOUT_MS);
    openTimer.unref?.();

    return peer;
  }

  private async handleWebRTCOffer(offer: any, signalingWs: WebSocket): Promise<void> {
    try {
      this.logger.info('Handling WebRTC offer for signaling');

      const peer = this.createWebRTCPeer();

      // Handle offer and get answer
      const answer = await peer.handleOffer(offer);

      // Send answer back via signaling WebSocket
      signalingWs.send(
        JSON.stringify({
          type: 'webrtc-answer',
          answer,
        })
      );

      this.logger.info('WebRTC answer sent; waiting for the data channel to open');

      // Close signaling WebSocket after handshake
      setTimeout(() => {
        signalingWs.close();
      }, 1000);
    } catch (error) {
      this.logger.error('Failed to handle WebRTC offer', error);
      signalingWs.send(
        JSON.stringify({
          type: 'webrtc-error',
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      );
    }
  }

  private async handleWebRTCOfferHTTP(req: any, res: any): Promise<void> {
    // CRITICAL: Call resume() to enable stream data flow
    req.resume();

    try {
      // Read body using promise wrapper around classic events
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];

        req.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        req.on('end', () => {
          resolve(Buffer.concat(chunks).toString());
        });

        req.on('error', reject);
      });

      const { offer } = JSON.parse(body);

      if (!offer) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing offer in request body' }));
        return;
      }

      const peer = this.createWebRTCPeer();

      // Handle offer and get answer
      const answer = await peer.handleOffer(offer);

      this.logger.info('WebRTC answer sent via HTTP signaling; waiting for the data channel');

      // Send answer back via HTTP response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answer }));
    } catch (error) {
      this.logger.error('Failed to handle WebRTC offer via HTTP', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      );
    }
  }

  // -------------------------------------------------------------------- queries

  /**
   * Sends a query to the active world (or to a specific connection, which is how worlds
   * are identified and probed).
   */
  async query(method: string, data?: any, timeoutMs = 10000, connectionId?: string): Promise<any> {
    const connection = connectionId ? this.registry.get(connectionId) : this.registry.getActive();
    const handle = connection ? this.handles.get(connection.id) : undefined;

    if (!connection || !handle?.isOpen()) {
      throw new Error('Not connected to Foundry VTT module');
    }

    if (!this.registry.supports(connection, method, MODULE_PREFIX)) {
      const others = this.registry
        .list()
        .filter(w => w.connectionId !== connection.id)
        .map(w => `${w.connectionId} (${w.label})`);
      const advice = others.length
        ? `, or switch worlds (other connected: ${others.join(', ')}).`
        : '.';
      throw new Error(
        `The Foundry world "${labelOf(connection)}" runs Foundry MCP Bridge module ` +
          `${connection.identity?.moduleVersion ?? '(unknown version)'}, which does not support ` +
          `"${method.replace(`${MODULE_PREFIX}.`, '')}". Update the module in that world${advice}`
      );
    }

    const queryId = `query-${++this.queryIdCounter}`;
    this.logger.debug('Sending query to Foundry', {
      method,
      data,
      queryId,
      connectionId: connection.id,
      connectionType: connection.transport,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingQueries.delete(queryId);
        reject(new Error(`Query timeout: ${method}`));
      }, timeoutMs);

      this.pendingQueries.set(queryId, {
        connectionId: connection.id,
        resolve,
        reject,
        timeout,
      });

      try {
        handle.send({
          type: 'mcp-query',
          id: queryId,
          data: { method, data },
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingQueries.delete(queryId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Sends a message to the active world. */
  sendToFoundry(message: any): void {
    const active = this.registry.getActive();
    const handle = active ? this.handles.get(active.id) : undefined;
    if (!handle?.isOpen()) {
      throw new Error('Not connected to Foundry VTT module');
    }
    handle.send(message);
  }

  isConnected(): boolean {
    if (!this.isStarted) return false;
    const active = this.registry.getActive();
    return !!active && !!this.handles.get(active.id)?.isOpen();
  }

  getConnectionInfo(): any {
    const active = this.registry.getActive();
    return {
      started: this.isStarted,
      connected: this.isConnected(),
      connectionType: active?.transport ?? null,
      activeConnectionId: active?.id ?? null,
      connections: this.registry.list(),
      config: {
        port: this.config.port,
        namespace: this.config.namespace,
      },
    };
  }

  getConnectionType(): 'websocket' | 'webrtc' | null {
    return this.registry.getActive()?.transport ?? null;
  }

  /**
   * Send a message to the connected Foundry module
   */
  sendMessage(message: any): void {
    if (!this.isConnected()) {
      throw new Error('Not connected to Foundry VTT module');
    }

    try {
      this.sendToFoundry(message);
      this.logger.debug('Sent message to Foundry module', {
        type: message.type,
        connectionType: this.getConnectionType(),
      });
    } catch (error) {
      this.logger.error('Failed to send message to Foundry module', error);
      throw error;
    }
  }

  /**
   * Broadcast a message to the active Foundry world (only one world is ever active)
   */
  broadcastMessage(message: any): void {
    this.sendMessage(message);
  }
}
