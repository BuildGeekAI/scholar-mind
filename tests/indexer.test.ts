import { describe, expect, it } from 'vitest';
import { chunkText, documentBody } from '../server/indexer';

/**
 * Chunking decides what a citation can point at. Two failure modes matter: a
 * chunk that never terminates (the loop that does not advance), and a claim that
 * straddles a boundary and is therefore retrievable from neither side.
 */

const words = (n: number, word = 'alpha') => Array.from({ length: n }, () => word).join(' ');

describe('chunkText', () => {
  it('returns nothing for empty or whitespace-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
    expect(chunkText(null as any)).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    expect(chunkText('One short paragraph.', 100)).toEqual(['One short paragraph.']);
  });

  it('splits text longer than the budget', () => {
    const chunks = chunkText(words(500), 200, 20);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('covers the whole input — no text is silently dropped', () => {
    const text = words(400, 'beta');
    const rejoined = chunkText(text, 200, 0).join(' ');
    // With no overlap the pieces should reconstruct the original word sequence.
    expect(rejoined.split(/\s+/).length).toBe(text.split(/\s+/).length);
  });

  it('overlaps consecutive chunks, so a claim spanning a boundary survives', () => {
    const chunks = chunkText(words(300, 'gamma'), 200, 50);
    expect(chunks.length).toBeGreaterThan(1);
    const tail = chunks[0].slice(-30);
    expect(chunks[1]).toContain(tail.trim().split(/\s+/).slice(-2).join(' '));
  });

  it('prefers a paragraph boundary when one falls in the second half of a chunk', () => {
    const first = words(30, 'aaa');
    const second = words(30, 'bbb');
    const [head] = chunkText(`${first}\n\n${second}`, first.length + 20, 0);
    // The cut should land on the paragraph break, not mid-sentence.
    expect(head).toBe(first);
  });

  it('falls back to a sentence boundary when there is no paragraph break', () => {
    const one = `${words(25, 'aaa')}. `;
    const two = `${words(25, 'bbb')}.`;
    const [head] = chunkText(one + two, one.length + 10, 0);
    expect(head.endsWith('.')).toBe(true);
    expect(head).not.toContain('bbb');
  });

  it('terminates on text with no boundaries at all', () => {
    // A single unbroken token far over budget: the cursor must still advance,
    // or this hangs rather than failing.
    const chunks = chunkText('x'.repeat(5000), 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('').length).toBeGreaterThan(0);
  });

  it('does not degenerate when the overlap is as large as the chunk', () => {
    // An overlap >= size makes each step advance by one character, emitting the
    // text roughly once per character. It terminates, so nothing hangs — it just
    // multiplies the index and the embedding cost enormously. Overlap is clamped
    // to half a chunk, so progress is always at least size/2.
    const text = words(200, 'delta');
    const chunks = chunkText(text, 100, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(Math.ceil(text.length / 50) + 1);
  });

  it('clamps a nonsensical overlap rather than trusting it', () => {
    const text = words(200, 'zeta');
    const sane = chunkText(text, 100, 50);
    const absurd = chunkText(text, 100, 10_000);
    expect(absurd.length).toBeLessThanOrEqual(sane.length * 2);
  });

  it('does not repeat content when the overlap is zero', () => {
    // Numbered tokens, so a chunk boundary that duplicated text would show up.
    const text = Array.from({ length: 200 }, (_, i) => `tok${i}`).join(' ');
    const chunks = chunkText(text, 100, 0);
    expect(chunks.length).toBeGreaterThan(1);
    expect(new Set(chunks).size).toBe(chunks.length);
    // Every token appears exactly once across the whole set.
    const tokens = chunks.join(' ').split(/\s+/);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('produces no empty chunks', () => {
    for (const chunk of chunkText(words(600, 'eps'), 150, 30)) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });

  it('collapses runs of blank lines rather than emitting whitespace chunks', () => {
    const chunks = chunkText(`first\n\n\n\n\nsecond`, 1000);
    expect(chunks).toEqual(['first\n\nsecond']);
  });
});

describe('documentBody', () => {
  const paper: any = {
    id: 'p1',
    title: 'Attention Is All You Need',
    authors: ['Vaswani', 'Shazeer'],
    year: '2017',
    summary: 'Transformers replace recurrence with attention.',
    status: 'converted',
  };

  it('includes the metadata a keyword search would be asked for', () => {
    const body = documentBody(paper);
    expect(body).toContain('Attention Is All You Need');
    expect(body).toContain('Vaswani, Shazeer');
    expect(body).toContain('2017');
    expect(body).toContain('Transformers replace recurrence');
  });

  it('folds in the generated write-up and slides when they exist', () => {
    const body = documentBody({
      ...paper,
      blogContent: 'A long explanation of self-attention.',
      slides: [{ title: 'Key idea', points: ['Queries', 'Keys', 'Values'] }],
    });
    expect(body).toContain('A long explanation of self-attention.');
    expect(body).toContain('Key idea: Queries Keys Values');
  });

  it('tolerates a paper with almost nothing on it', () => {
    expect(() => documentBody({ id: 'x', title: 'Bare', status: 'discovered' } as any)).not.toThrow();
    expect(documentBody({ id: 'x', title: 'Bare', status: 'discovered' } as any)).toContain('Bare');
  });

  it('uses the extracted text for a source that is not a paper', () => {
    const body = documentBody({
      id: 'v1',
      kind: 'youtube',
      title: 'A talk',
      status: 'converted',
      extractedText: 'The speaker explains beam search.',
    } as any);
    expect(body).toContain('beam search');
  });
});
