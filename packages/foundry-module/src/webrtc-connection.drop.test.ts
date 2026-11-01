import { describe, expect, it, vi } from 'vitest';
import { WebRTCConnection } from './webrtc-connection.js';

function makeConnection() {
  const conn = new WebRTCConnection({
    serverHost: 'localhost',
    serverPort: 31415,
    namespace: '/foundry-mcp',
    stunServers: [],
    connectionTimeout: 10,
    debugLogging: false,
  } as any);
  const onDrop = vi.fn();
  conn.setDisconnectHandler(onDrop);
  return { conn: conn as any, onDrop };
}

describe('WebRTCConnection drop reporting', () => {
  it('reports a drop of an established connection once', () => {
    const { conn, onDrop } = makeConnection();
    conn.wasConnected = true;

    conn.reportDrop('data channel closed');
    conn.reportDrop('ICE failed');

    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('ignores drops before the connection was ever established', () => {
    const { conn, onDrop } = makeConnection();

    conn.reportDrop('ICE failed');

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('ignores the close caused by our own disconnect()', () => {
    const { conn, onDrop } = makeConnection();
    conn.wasConnected = true;

    conn.disconnect();
    conn.reportDrop('data channel closed');

    expect(onDrop).not.toHaveBeenCalled();
  });
});
