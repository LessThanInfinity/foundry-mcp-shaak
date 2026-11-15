import { describe, expect, it } from 'vitest';
import { ConnectionRegistry } from './connection-registry.js';

function makeRegistry() {
  let t = 1000;
  return new ConnectionRegistry(() => (t += 10));
}

describe('ConnectionRegistry', () => {
  it('makes the first connection active and keeps it active when others join', () => {
    const r = makeRegistry();
    const a = r.add('websocket');
    const b = r.add('webrtc');
    expect(r.getActive()?.id).toBe(a.id);
    expect(r.list().map(c => [c.connectionId, c.active])).toEqual([
      [a.id, true],
      [b.id, false],
    ]);
  });

  it('promotes the oldest remaining connection when the active one drops', () => {
    const r = makeRegistry();
    const a = r.add('websocket');
    const b = r.add('webrtc');
    const c = r.add('webrtc');
    const result = r.remove(a.id);
    expect(result).toMatchObject({ removed: true, wasActive: true });
    expect(result.promoted?.id).toBe(b.id);
    expect(r.getActive()?.id).toBe(b.id);
    expect(r.get(c.id)).toBeDefined();
  });

  it('does not change the active connection when a standby one drops', () => {
    const r = makeRegistry();
    const a = r.add('websocket');
    const b = r.add('webrtc');
    const result = r.remove(b.id);
    expect(result).toMatchObject({ removed: true, wasActive: false, promoted: null });
    expect(r.getActive()?.id).toBe(a.id);
  });

  it('has no active connection once the last one drops', () => {
    const r = makeRegistry();
    const a = r.add('websocket');
    r.remove(a.id);
    expect(r.getActive()).toBeNull();
    expect(r.remove(a.id)).toMatchObject({ removed: false });
  });

  it('merges identity and reports a world as identified only once it names itself', () => {
    const r = makeRegistry();
    const a = r.add('websocket');
    expect(r.list()[0]).toMatchObject({ identified: false, worldTitle: null });
    r.setIdentity(a.id, { foundryVersion: '13.351' });
    expect(r.list()[0]!.identified).toBe(false);
    r.setIdentity(a.id, { worldId: 'w1', worldTitle: 'Ruby Phoenix', methods: ['a', 'b'] });
    expect(r.list()[0]).toMatchObject({
      identified: true,
      worldTitle: 'Ruby Phoenix',
      foundryVersion: '13.351',
      toolCount: 2,
    });
  });

  describe('selecting a world', () => {
    function twoWorlds() {
      const r = makeRegistry();
      const local = r.add('websocket');
      const remote = r.add('webrtc');
      r.setIdentity(local.id, { worldId: 'ruby', worldTitle: 'Ruby Phoenix (LOCAL)' });
      r.setIdentity(remote.id, { worldId: 'ruby', worldTitle: 'Ruby Phoenix' });
      return { r, local, remote };
    }

    it('switches by connection id', () => {
      const { r, remote } = twoWorlds();
      r.select(remote.id);
      expect(r.getActive()?.id).toBe(remote.id);
    });

    it('switches by exact world title, case-insensitively', () => {
      const { r, local, remote } = twoWorlds();
      r.select('ruby phoenix');
      expect(r.getActive()?.id).toBe(remote.id);
      r.select('RUBY PHOENIX (local)');
      expect(r.getActive()?.id).toBe(local.id);
    });

    it('switches by a unique title fragment', () => {
      const { r, local } = twoWorlds();
      r.select('local');
      expect(r.getActive()?.id).toBe(local.id);
    });

    it('refuses an ambiguous world id and says how to disambiguate', () => {
      const { r } = twoWorlds();
      expect(() => r.select('ruby')).toThrow(/more than one connected world.*connection id/);
    });

    it('lists what is connected when nothing matches', () => {
      const { r } = twoWorlds();
      expect(() => r.select('nope')).toThrow(/No connected world matches "nope".*Ruby Phoenix/);
    });

    it('rejects an empty query and leaves the active world alone', () => {
      const { r, local } = twoWorlds();
      expect(() => r.select('  ')).toThrow(/required/);
      expect(r.getActive()?.id).toBe(local.id);
    });

    it('selectById returns null for an unknown connection', () => {
      const { r } = twoWorlds();
      expect(r.selectById('c99')).toBeNull();
    });
  });

  describe('supports', () => {
    it('is true when the world never announced its methods (older module)', () => {
      const r = makeRegistry();
      const a = r.add('webrtc');
      expect(r.supports(a, 'foundry-mcp-bridge.applyCutInTemplate', 'foundry-mcp-bridge')).toBe(
        true
      );
    });

    it('checks the announced methods, with or without the module prefix', () => {
      const r = makeRegistry();
      const a = r.add('webrtc');
      r.setIdentity(a.id, { methods: ['manageFlags'] });
      expect(r.supports(a, 'foundry-mcp-bridge.manageFlags', 'foundry-mcp-bridge')).toBe(true);
      expect(r.supports(a, 'manageFlags', 'foundry-mcp-bridge')).toBe(true);
      expect(r.supports(a, 'foundry-mcp-bridge.applyCutInTemplate', 'foundry-mcp-bridge')).toBe(
        false
      );
    });
  });
});
