import { describe, expect, it } from 'vitest';
import { ConnectionRegistry, hostOf, labelOf, worldKey } from './connection-registry.js';

const LOCAL = 'http://localhost:30000';
const REMOTE = 'https://play.example.com';

function makeRegistry(preferredKey: string | null = null) {
  let t = 1000;
  return new ConnectionRegistry(() => (t += 10), preferredKey);
}

/** Two worlds with the same id and title, told apart only by where they are open. */
function twoCopies(preferredKey: string | null = null) {
  const r = makeRegistry(preferredKey);
  const remote = r.add('webrtc');
  const local = r.add('websocket');
  r.setIdentity(remote.id, { worldId: 'ruby', worldTitle: 'Ruby', origin: REMOTE });
  r.setIdentity(local.id, { worldId: 'ruby', worldTitle: 'Ruby', origin: LOCAL });
  return { r, remote, local };
}

describe('world identity across reconnects', () => {
  it('keys a world by id and where it is open, so copies are distinct', () => {
    const { r, remote, local } = twoCopies();
    expect(worldKey(r.get(remote.id)!)).toBe(`${REMOTE}|ruby`);
    expect(worldKey(r.get(local.id)!)).toBe(`${LOCAL}|ruby`);
  });

  it('cannot key a world that did not say where it is open', () => {
    const r = makeRegistry();
    const a = r.add('webrtc');
    r.setIdentity(a.id, { worldId: 'ruby', worldTitle: 'Ruby' });
    expect(worldKey(r.get(a.id)!)).toBeNull();
  });

  it('names a world with where it is open', () => {
    const { r, local } = twoCopies();
    expect(labelOf(r.get(local.id)!)).toBe('Ruby (localhost:30000)');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('remembering the chosen world', () => {
  it('remembers an explicit choice', () => {
    const { r, local } = twoCopies();
    r.select(local.id);
    expect(r.getPreferredKey()).toBe(`${LOCAL}|ruby`);
    expect(r.list().find(w => w.connectionId === local.id)).toMatchObject({
      active: true,
      preferred: true,
    });
  });

  it('puts the chosen world back in charge when it reconnects after a drop', () => {
    const { r, remote, local } = twoCopies();
    r.select(local.id);

    // The local page reloads: its connection drops and the other world is promoted.
    const dropped = r.remove(local.id);
    expect(dropped.promoted?.id).toBe(remote.id);
    expect(r.getActive()?.id).toBe(remote.id);

    // It reconnects and introduces itself: it is active again.
    const back = r.add('websocket');
    expect(r.getActive()?.id).toBe(remote.id); // not yet: it has not said who it is
    expect(r.setIdentity(back.id, { worldId: 'ruby', worldTitle: 'Ruby', origin: LOCAL })).toBe(
      true
    );
    expect(r.getActive()?.id).toBe(back.id);
  });

  it('survives a server restart when given the saved choice', () => {
    // A fresh registry, as after a restart: the remote world reconnects first.
    const r = makeRegistry(`${LOCAL}|ruby`);
    const remote = r.add('webrtc');
    r.setIdentity(remote.id, { worldId: 'ruby', origin: REMOTE });
    expect(r.getActive()?.id).toBe(remote.id);

    const local = r.add('websocket');
    expect(r.setIdentity(local.id, { worldId: 'ruby', origin: LOCAL })).toBe(true);
    expect(r.getActive()?.id).toBe(local.id);
  });

  it('promotes the oldest remaining world when the chosen one is gone', () => {
    const r = makeRegistry();
    const a = r.add('webrtc');
    const b = r.add('webrtc');
    const c = r.add('websocket');
    r.setIdentity(a.id, { worldId: 'a', origin: 'http://a' });
    r.setIdentity(b.id, { worldId: 'b', origin: 'http://b' });
    r.setIdentity(c.id, { worldId: 'c', origin: 'http://c' });

    r.select(c.id);
    expect(r.remove(c.id).promoted?.id).toBe(a.id);
    // The choice is still remembered while that world is away.
    expect(r.getPreferredKey()).toBe('http://c|c');
    expect(r.getActive()?.id).toBe(a.id);
  });

  it('does not let an unrelated world take over when it says hello', () => {
    const { r, remote, local } = twoCopies();
    r.select(local.id);
    expect(r.setIdentity(remote.id, { worldId: 'ruby', origin: REMOTE })).toBe(false);
    expect(r.getActive()?.id).toBe(local.id);
  });

  it('keeps the first world active when nothing was ever chosen', () => {
    const { r, remote } = twoCopies();
    expect(r.getActive()?.id).toBe(remote.id);
    expect(r.getPreferredKey()).toBeNull();
  });

  it('forgets the preference when a world that cannot be remembered is chosen', () => {
    const r = makeRegistry();
    const local = r.add('websocket');
    const legacy = r.add('webrtc'); // older module: no hello, no origin
    r.setIdentity(local.id, { worldId: 'ruby', origin: LOCAL });
    r.select(local.id);
    expect(r.getPreferredKey()).toBe(`${LOCAL}|ruby`);
    r.select(legacy.id);
    expect(r.getPreferredKey()).toBeNull();
  });

  it('lets a world that asks to become active be remembered too', () => {
    const { r, local } = twoCopies();
    r.selectById(local.id);
    expect(r.getPreferredKey()).toBe(`${LOCAL}|ruby`);
  });
});

describe('finding a world by where it is open', () => {
  it('selects by a unique fragment of the page address', () => {
    const { r, local } = twoCopies();
    expect(r.select('localhost').id).toBe(local.id);
    expect(r.select('play.example').id).not.toBe(local.id);
  });

  it('refuses an ambiguous fragment', () => {
    const { r } = twoCopies();
    expect(() => r.select('ruby')).toThrow(/more than one connected world/);
    expect(() => r.select('http')).toThrow(/more than one connected world/);
  });
});
