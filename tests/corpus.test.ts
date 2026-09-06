import { describe, expect, it } from 'vitest';
import { canonicalKey, corpusBlobKey, scholarKey, scholarKeysFor } from '../server/corpus';

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

/**
 * Decides whether a second profile is a duplicate library. A false positive
 * blocks a legitimate second library; a false negative is the bug this exists
 * to fix — two stores, two sets of embeddings, and a split chat history.
 */
describe('scholarKey', () => {
  it('extracts the exact identity from a Google Scholar URL', () => {
    expect(scholarKey('https://scholar.google.com/citations?user=JicYPdAAAAAJ&hl=en')).toBe(
      'gs:JicYPdAAAAAJ'
    );
  });

  it('matches the same scholar across differing URL forms', () => {
    const a = scholarKey('https://scholar.google.com/citations?user=JicYPdAAAAAJ&hl=en');
    const b = scholarKey('http://scholar.google.co.uk/citations?hl=fr&user=JicYPdAAAAAJ&view_op=list');
    expect(a).toBe(b);
  });

  it('separates different scholars', () => {
    expect(scholarKey('https://scholar.google.com/citations?user=AAAA')).not.toBe(
      scholarKey('https://scholar.google.com/citations?user=BBBB')
    );
  });

  it('normalizes a typed name', () => {
    expect(scholarKey('Geoffrey Hinton')).toBe('name:geoffrey-hinton');
    expect(scholarKey('  geoffrey   HINTON ')).toBe('name:geoffrey-hinton');
    expect(scholarKey('Geoffrey Hinton.')).toBe('name:geoffrey-hinton');
  });

  it('does not treat two different people as one', () => {
    expect(scholarKey('Geoffrey Hinton')).not.toBe(scholarKey('Geoffrey Chaucer'));
  });

  it('keeps a name and a URL in separate namespaces', () => {
    // They are reconciled by recording both keys after resolution, not by
    // colliding here — a URL string is not evidence of a name.
    expect(scholarKey('Geoffrey Hinton')).not.toBe(scholarKey('https://example.com/geoffrey-hinton'));
  });

  it('returns null for input that identifies nobody', () => {
    expect(scholarKey('')).toBeNull();
    expect(scholarKey('   ')).toBeNull();
    expect(scholarKey('!!!')).toBeNull();
  });
});

describe('scholarKeysFor', () => {
  it('records both the URL searched and the name it resolved to', () => {
    expect(
      scholarKeysFor('https://scholar.google.com/citations?user=JicYPdAAAAAJ', 'Geoffrey Hinton')
    ).toEqual(['gs:JicYPdAAAAAJ', 'name:geoffrey-hinton']);
  });

  it('lets a URL-built library and a name-built one recognise each other', () => {
    const fromUrl = scholarKeysFor(
      'https://scholar.google.com/citations?user=JicYPdAAAAAJ',
      'Geoffrey Hinton'
    );
    const fromName = scholarKeysFor('geoffrey hinton', 'Geoffrey Hinton');
    expect(fromUrl.some(k => fromName.includes(k))).toBe(true);
  });

  it('does not duplicate a key when query and resolved name agree', () => {
    expect(scholarKeysFor('Geoffrey Hinton', 'Geoffrey Hinton')).toEqual(['name:geoffrey-hinton']);
  });

  it('survives a search that resolved no name', () => {
    expect(scholarKeysFor('Geoffrey Hinton', '')).toEqual(['name:geoffrey-hinton']);
    expect(scholarKeysFor('', '')).toEqual([]);
  });
});

describe('scholarKeysFor — name variants', () => {
  it('matches an abbreviated name against a resolved full name with a middle name', () => {
    // The live failure: "G. E. Hinton" resolved to "Geoffrey Everest Hinton",
    // which did not match an existing library for "Geoffrey Hinton".
    const existing = scholarKeysFor('Geoffrey Hinton', 'Geoffrey Hinton');
    const attempt = scholarKeysFor('G. E. Hinton', 'Geoffrey Everest Hinton');
    expect(attempt.some(k => existing.includes(k))).toBe(true);
  });

  it('still separates people who merely share a first name', () => {
    const a = scholarKeysFor('Geoffrey Hinton', 'Geoffrey Everest Hinton');
    const b = scholarKeysFor('Geoffrey Chaucer', 'Geoffrey Chaucer');
    expect(a.some(k => b.includes(k))).toBe(false);
  });

  it('adds no short form for a two-part name', () => {
    expect(scholarKeysFor('Geoffrey Hinton', 'Geoffrey Hinton')).toEqual(['name:geoffrey-hinton']);
  });
});
