import { describe, expect, it } from 'vitest';
import { fuse } from '../server/search';

/**
 * Reciprocal-rank fusion merges the keyword and semantic arms.
 *
 * It compares an item only to others in its own list, which is the point: the
 * two arms produce incomparable numbers — `ts_rank_cd` is unbounded and
 * corpus-dependent, cosine distance is bounded — so any scheme that normalises
 * and adds them is comparing units that do not exist.
 */

interface Row {
  id: string;
}

const rows = (...ids: string[]): Row[] => ids.map(id => ({ id }));
const key = (row: Row) => row.id;
const ids = (result: ReturnType<typeof fuse<Row>>) => result.map(r => r.item.id);

describe('fuse', () => {
  it('returns nothing for empty inputs', () => {
    expect(fuse<Row>([], key)).toEqual([]);
    expect(fuse([{ items: [], label: 'keyword' }], key)).toEqual([]);
  });

  it('preserves order when only one arm returned anything', () => {
    const result = fuse([{ items: rows('a', 'b', 'c'), label: 'keyword' }], key);
    expect(ids(result)).toEqual(['a', 'b', 'c']);
  });

  it('ranks a result found by both arms above one found by either alone', () => {
    const result = fuse(
      [
        { items: rows('solo-k', 'both'), label: 'keyword' },
        { items: rows('solo-s', 'both'), label: 'semantic' },
      ],
      key
    );
    // 'both' is second in each list, yet agreement lifts it over either leader.
    expect(ids(result)[0]).toBe('both');
  });

  it('records which arms matched, so the UI can say why something surfaced', () => {
    const result = fuse(
      [
        { items: rows('both', 'k-only'), label: 'keyword' },
        { items: rows('both', 's-only'), label: 'semantic' },
      ],
      key
    );
    const byId = Object.fromEntries(result.map(r => [r.item.id, r.matched]));
    expect(byId['both'].sort()).toEqual(['keyword', 'semantic']);
    expect(byId['k-only']).toEqual(['keyword']);
    expect(byId['s-only']).toEqual(['semantic']);
  });

  it('does not double-count an item that appears twice within one arm', () => {
    const result = fuse([{ items: rows('a', 'a', 'b'), label: 'keyword' }], key);
    expect(result.filter(r => r.item.id === 'a')).toHaveLength(1);
    expect(result.find(r => r.item.id === 'a')!.matched).toEqual(['keyword']);
  });

  it('deduplicates across arms rather than returning the same chunk twice', () => {
    const result = fuse(
      [
        { items: rows('a', 'b'), label: 'keyword' },
        { items: rows('b', 'a'), label: 'semantic' },
      ],
      key
    );
    expect(result).toHaveLength(2);
  });

  it('sorts strictly by descending score', () => {
    const result = fuse(
      [
        { items: rows('a', 'b', 'c'), label: 'keyword' },
        { items: rows('c', 'b', 'a'), label: 'semantic' },
      ],
      key
    );
    const scores = result.map(r => r.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  it('damps the top of either list, so one confident arm cannot bury the other', () => {
    // With a small k, rank 1 would dominate everything. The default k=60 keeps
    // the contribution of adjacent ranks close, which is what lets agreement win.
    const damped = fuse(
      [
        { items: rows('runaway'), label: 'keyword' },
        { items: rows('x', 'agreed'), label: 'semantic' },
      ],
      key,
      60
    );
    const undamped = fuse(
      [
        { items: rows('runaway'), label: 'keyword' },
        { items: rows('x', 'agreed'), label: 'semantic' },
      ],
      key,
      0
    );
    // A single top-ranked keyword hit leads either way here, but the gap over
    // the semantic runner-up should be far narrower with damping.
    const gap = (r: ReturnType<typeof fuse<Row>>) => r[0].score - r[r.length - 1].score;
    expect(gap(damped)).toBeLessThan(gap(undamped));
  });

  it('gives every item a positive score', () => {
    const result = fuse([{ items: rows('a', 'b'), label: 'keyword' }], key);
    for (const entry of result) expect(entry.score).toBeGreaterThan(0);
  });

  it('is symmetric in the arms — swapping them does not change the ranking', () => {
    const keyword = { items: rows('a', 'b', 'c'), label: 'keyword' as const };
    const semantic = { items: rows('c', 'a'), label: 'semantic' as const };
    expect(ids(fuse([keyword, semantic], key))).toEqual(ids(fuse([semantic, keyword], key)));
  });
});
