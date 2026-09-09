import { describe, expect, it } from 'vitest';
import { hashKey, mintKeyString, prefixOf } from '../server/apiKeys';

/**
 * The parts of key handling that are pure, and that a mistake in would be
 * quiet: a prefix parser that accepts something it should not, or a hash that
 * turns out to be reversible because it was never really a hash.
 *
 * Verification itself needs the database and is exercised in
 * tests/integration/acl.test.ts.
 */

describe('mintKeyString', () => {
  it('produces the documented shape', () => {
    const { key, prefix } = mintKeyString();
    expect(key).toMatch(/^sm_[0-9a-f]{12}_[0-9a-f]{48}$/);
    expect(key).toContain(prefix);
  });

  it('returns a prefix the parser agrees with', () => {
    const { key, prefix } = mintKeyString();
    expect(prefixOf(key)).toBe(prefix);
  });

  it('does not repeat itself', () => {
    const keys = new Set(Array.from({ length: 200 }, () => mintKeyString().key));
    expect(keys.size).toBe(200);
  });

  it('gives each key a distinct prefix, which the unique index depends on', () => {
    const prefixes = new Set(Array.from({ length: 200 }, () => mintKeyString().prefix));
    expect(prefixes.size).toBe(200);
  });
});

describe('prefixOf', () => {
  it('extracts the lookup half of a well-formed key', () => {
    expect(prefixOf(`sm_0123456789ab_${'f'.repeat(48)}`)).toBe('0123456789ab');
  });

  it('tolerates surrounding whitespace, which config files add', () => {
    expect(prefixOf(`  sm_0123456789ab_${'f'.repeat(48)}\n`)).toBe('0123456789ab');
  });

  it('rejects anything that is not the exact shape', () => {
    const bad = [
      '',
      'nonsense',
      'sm_short_abc',
      `sm_0123456789ab_${'f'.repeat(10)}`, // secret too short
      `sm_0123456789AB_${'f'.repeat(48)}`, // prefix not lowercase hex
      `sm_0123456789ab-${'f'.repeat(48)}`, // wrong separator
      `xx_0123456789ab_${'f'.repeat(48)}`, // wrong namespace
      `sm_0123456789ab_${'g'.repeat(48)}`, // secret not hex
    ];
    for (const value of bad) expect(prefixOf(value)).toBeNull();
  });

  it('rejects a bearer prefix left on by a careless caller', () => {
    expect(prefixOf(`Bearer sm_0123456789ab_${'f'.repeat(48)}`)).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    expect(() => prefixOf(null as any)).not.toThrow();
    expect(() => prefixOf(undefined as any)).not.toThrow();
    expect(prefixOf(null as any)).toBeNull();
  });
});

describe('hashKey', () => {
  it('is a 64-character hex digest', () => {
    expect(hashKey('sm_abc_def')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same input', () => {
    expect(hashKey('same')).toBe(hashKey('same'));
  });

  it('does not contain the key it hashed — this is the whole point', () => {
    const { key } = mintKeyString();
    const digest = hashKey(key);
    expect(digest).not.toContain(key);
    expect(digest).not.toContain(key.slice(4, 20));
  });

  it('changes completely for a single-character difference', () => {
    const a = hashKey('sm_0123456789ab_aaaa');
    const b = hashKey('sm_0123456789ab_aaab');
    expect(a).not.toBe(b);
    // Not a rigorous avalanche test, just a guard against a truncating or
    // prefix-preserving "hash" being substituted later.
    const shared = [...a].filter((ch, i) => ch === b[i]).length;
    expect(shared).toBeLessThan(a.length / 2);
  });
});
