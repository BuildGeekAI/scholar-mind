import { describe, expect, it } from 'vitest';
import { canonicalKey, corpusBlobKey } from '../server/corpus';

/**
 * This key decides whether two profiles are talking about the same paper. Too
 * loose and one paper's PDF is served for another; too strict and de-dup never
 * fires because two search results formatted the title differently.
 */
describe('canonicalKey', () => {
  const key = (title: string) => canonicalKey({ title });

  it('is stable for the same title', () => {
    expect(key('Attention Is All You Need')).toBe(key('Attention Is All You Need'));
  });

  it('ignores case, punctuation and whitespace differences', () => {
    const canonical = key('Attention Is All You Need');
    expect(key('attention is all you need')).toBe(canonical);
    expect(key('Attention Is All You Need.')).toBe(canonical);
    expect(key('  Attention   is  all   you need  ')).toBe(canonical);
    expect(key('Attention, Is All You Need!')).toBe(canonical);
  });

  it('ignores accents so the same paper collides across sources', () => {
    expect(key('Étude sur la Récursion')).toBe(key('Etude sur la Recursion'));
  });

  it('separates genuinely different papers', () => {
    expect(key('Attention Is All You Need')).not.toBe(key('Attention Is Not All You Need'));
    expect(key('Deep Residual Learning')).not.toBe(key('Deep Residual Learning II'));
  });

  it('does not collide on a shared 60-character prefix', () => {
    // The slug truncates at 60 chars; the hash covers the whole title, so two
    // long titles that agree up to the cut must still differ.
    const prefix = 'a very long paper title that goes on well past the sixty character mark';
    expect(key(`${prefix} part one`)).not.toBe(key(`${prefix} part two`));
  });

  it('produces a key usable as a Firestore document id and a blob path', () => {
    const k = key('Attention Is All You Need: A Study/Review (2017)');
    expect(k).toMatch(/^[a-z0-9-]+$/);
    expect(k).not.toContain('/');
    expect(k.length).toBeLessThanOrEqual(71); // 60-char slug + '-' + 10 hex
  });

  it('degrades to a placeholder rather than an empty key', () => {
    expect(key('')).toBe('unknown');
    expect(key('!!!')).toBe('unknown');
  });
});

describe('corpusBlobKey', () => {
  it('keeps shared bytes outside every profile namespace', () => {
    const k = corpusBlobKey(canonicalKey({ title: 'Some Paper' }));
    expect(k.startsWith('corpus/')).toBe(true);
    // The blob endpoint only serves keys under profiles/, so corpus bytes are
    // reachable by the server alone and never by a browser.
    expect(k.startsWith('profiles/')).toBe(false);
  });
});
