import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FsBlobStore, blobKey, profilePrefix } from '../server/blobStore';

const roots: string[] = [];
const store = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scholarmind-blobs-'));
  roots.push(root);
  return new FsBlobStore(root);
};

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * Blob keys arrive from the URL path, and the local store turns them into
 * filesystem paths. Traversal here would read anything the process can.
 */
describe('key safety', () => {
  const hostile = [
    '../../../etc/passwd',
    'profiles/../../secrets',
    '/etc/passwd',
    'profiles/a/..%2Fb',
    'profiles/a/b;rm -rf',
    '',
  ];

  it.each(hostile)('rejects %j', async key => {
    await expect(store().get(key)).rejects.toThrow(/Unsafe blob key/);
  });

  it('rejects hostile keys on write, not just read', async () => {
    await expect(store().put('../escape', Buffer.from('x'), 'text/plain')).rejects.toThrow(
      /Unsafe blob key/
    );
  });
});

describe('key construction', () => {
  it('namespaces every blob under its profile', () => {
    expect(blobKey('p1', 'paper-9', 'audio')).toBe('profiles/p1/paper-9/audio');
  });

  it('produces a prefix that matches its own keys', () => {
    expect(blobKey('p1', 'paper-9', 'pdf').startsWith(profilePrefix('p1'))).toBe(true);
  });

  it('does not let one profile prefix-match another', () => {
    // 'profiles/p1/' must not be a prefix of 'profiles/p10/...'.
    expect(blobKey('p10', 'x', 'pdf').startsWith(profilePrefix('p1'))).toBe(false);
  });
});

describe('round trip', () => {
  it('preserves bytes and content type', async () => {
    const s = store();
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await s.put(blobKey('p1', 'x', 'illustration'), data, 'image/jpeg');
    const got = await s.get(blobKey('p1', 'x', 'illustration'));
    expect(got?.data).toEqual(data);
    expect(got?.contentType).toBe('image/jpeg');
  });

  it('returns null for a missing key rather than throwing', async () => {
    expect(await store().get(blobKey('p1', 'nope', 'pdf'))).toBeNull();
  });

  it('deletes a blob and its content-type sidecar', async () => {
    const s = store();
    const key = blobKey('p1', 'x', 'pdf');
    await s.put(key, Buffer.from('pdf'), 'application/pdf');
    await s.delete(key);
    expect(await s.get(key)).toBeNull();
  });

  it('deleteByPrefix removes a whole profile and leaves others alone', async () => {
    const s = store();
    await s.put(blobKey('p1', 'a', 'pdf'), Buffer.from('a'), 'application/pdf');
    await s.put(blobKey('p1', 'b', 'audio'), Buffer.from('b'), 'audio/l16');
    await s.put(blobKey('p2', 'c', 'pdf'), Buffer.from('c'), 'application/pdf');

    await s.deleteByPrefix(profilePrefix('p1'));

    expect(await s.get(blobKey('p1', 'a', 'pdf'))).toBeNull();
    expect(await s.get(blobKey('p1', 'b', 'audio'))).toBeNull();
    expect((await s.get(blobKey('p2', 'c', 'pdf')))?.data.toString()).toBe('c');
  });
});
