import { describe, expect, it } from 'vitest';
import { formatBibliography, formatCitation } from '../server/citations';
import { Paper } from '../types';

const AT = new Date('2026-09-06T12:00:00Z');

const paper = (over: Partial<Paper> = {}): Paper => ({
  id: 'p1',
  title: 'Attention Is All You Need',
  year: '2017',
  authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
  summary: '',
  status: 'converted',
  ...over,
});

const withMeta = (over: Partial<Paper> = {}) =>
  paper({
    citationMeta: {
      doi: '10.5555/3295222.3295349',
      containerTitle: 'Advances in Neural Information Processing Systems',
      volume: '30',
      issue: '2',
      page: '5998-6008',
      issued: '2017',
      type: 'journal-article',
    },
    ...over,
  });

describe('BibTeX', () => {
  it('emits a parseable entry with a stable key', () => {
    const out = formatCitation(withMeta(), 'bibtex', AT);
    expect(out).toMatch(/^@article\{vaswani2017attention,$/m);
    expect(out.trim().endsWith('}')).toBe(true);
    expect(out).toContain('author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki}');
    expect(out).toContain('doi = {10.5555/3295222.3295349}');
    expect(out).toContain('pages = {5998-6008}');
  });

  it('produces the same key every time', () => {
    expect(formatCitation(withMeta(), 'bibtex', AT)).toBe(formatCitation(withMeta(), 'bibtex', AT));
  });

  it('omits fields it does not have rather than inventing them', () => {
    const out = formatCitation(paper(), 'bibtex', AT);
    expect(out).not.toContain('volume');
    expect(out).not.toContain('pages');
    expect(out).not.toContain('doi');
    expect(out).toContain('title = {Attention Is All You Need}');
  });

  it('escapes characters that would break the BibTeX parser', () => {
    const out = formatCitation(paper({ title: 'Cost & Value: 50% {faster} $x_1$' }), 'bibtex', AT);
    const titleValue = out.match(/title = \{(.*)\}/)![1];
    // Braces from the title would open a group the parser never closes.
    expect(titleValue).not.toContain('{');
    expect(titleValue).not.toContain('}');
    expect(titleValue).toContain('\\&');
    expect(titleValue).toContain('\\%');
    expect(titleValue).toContain('\\_');
    expect(titleValue).toContain('\\$');
  });

  it('uses the entry type Crossref implies', () => {
    expect(formatCitation(withMeta({ citationMeta: { type: 'proceedings-article' } }), 'bibtex', AT))
      .toMatch(/^@inproceedings\{/);
    expect(formatCitation(paper({ kind: 'youtube' }), 'bibtex', AT)).toMatch(/^@misc\{/);
  });
});

describe('APA', () => {
  it('inverts every author and joins the last with an ampersand', () => {
    expect(formatCitation(withMeta(), 'apa', AT)).toContain(
      'Vaswani, A., Shazeer, N., & Parmar, N. (2017).'
    );
  });

  it('includes the journal, volume, issue and pages when known', () => {
    expect(formatCitation(withMeta(), 'apa', AT)).toContain(
      'Advances in Neural Information Processing Systems 30(2), 5998-6008.'
    );
  });

  it('prefers a DOI link over the source URL', () => {
    const out = formatCitation(withMeta({ sourceUrl: 'https://arxiv.org/pdf/1706.03762' }), 'apa', AT);
    expect(out).toContain('https://doi.org/10.5555/3295222.3295349');
    expect(out).not.toContain('arxiv.org');
  });

  it('marks a video as one', () => {
    const out = formatCitation(
      paper({ kind: 'youtube', authors: ['Grant Sanderson'], sourceUrl: 'https://youtu.be/x' }),
      'apa',
      AT
    );
    expect(out).toContain('[Video]');
    expect(out).toContain('https://youtu.be/x');
  });

  it('falls back to n.d. rather than guessing a year', () => {
    expect(formatCitation(paper({ year: '' }), 'apa', AT)).toContain('(n.d.)');
  });
});

describe('MLA', () => {
  it('truncates three or more authors to et al.', () => {
    expect(formatCitation(withMeta(), 'mla', AT)).toContain('Vaswani, Ashish, et al.');
  });

  it('names both authors when there are exactly two', () => {
    const out = formatCitation(paper({ authors: ['Ada Lovelace', 'Charles Babbage'] }), 'mla', AT);
    expect(out).toContain('Lovelace, Ada, and Charles Babbage.');
  });

  it('adds an accessed date for web sources only', () => {
    expect(formatCitation(paper({ kind: 'web', sourceUrl: 'https://x.dev' }), 'mla', AT)).toContain(
      'Accessed 6 September 2026'
    );
    expect(formatCitation(withMeta(), 'mla', AT)).not.toContain('Accessed');
  });
});

describe('Chicago and Harvard', () => {
  it('inverts only the first author in Chicago', () => {
    expect(formatCitation(withMeta(), 'chicago', AT)).toContain(
      'Vaswani, Ashish, Noam Shazeer, Niki Parmar.'
    );
  });

  it('uses Harvard volume and page abbreviations', () => {
    const out = formatCitation(withMeta(), 'harvard', AT);
    expect(out).toContain("'Attention Is All You Need',");
    expect(out).toContain('vol. 30');
    expect(out).toContain('pp. 5998-6008');
    expect(out).toContain('Available at:');
  });
});

describe('RIS', () => {
  it('opens with a type tag and closes with ER', () => {
    const out = formatCitation(withMeta(), 'ris', AT);
    expect(out.split('\n')[0]).toBe('TY  - JOUR');
    expect(out.trim().endsWith('ER  -')).toBe(true);
  });

  it('emits one AU line per author', () => {
    const out = formatCitation(withMeta(), 'ris', AT);
    expect(out.match(/^AU {2}- /gm)?.length).toBe(3);
  });

  it('tags media and web sources distinctly', () => {
    expect(formatCitation(paper({ kind: 'youtube' }), 'ris', AT)).toContain('TY  - VIDEO');
    expect(formatCitation(paper({ kind: 'web' }), 'ris', AT)).toContain('TY  - ELEC');
  });
});

describe('names', () => {
  it('accepts an already-inverted author', () => {
    expect(formatCitation(paper({ authors: ['Vaswani, Ashish'] }), 'apa', AT)).toContain('Vaswani, A.');
  });

  it('handles a single-word name without inventing initials', () => {
    expect(formatCitation(paper({ authors: ['Plato'] }), 'apa', AT)).toContain('Plato (2017)');
  });

  it('survives a source with no authors at all', () => {
    const out = formatCitation(paper({ authors: [] }), 'apa', AT);
    expect(out).toContain('Attention Is All You Need');
    expect(out).not.toContain('undefined');
  });
});

describe('bibliography', () => {
  it('separates BibTeX records without sorting them', () => {
    const out = formatBibliography([paper({ title: 'Zebra' }), paper({ title: 'Apple' })], 'bibtex', AT);
    expect(out.indexOf('Zebra')).toBeLessThan(out.indexOf('Apple'));
    expect(out.split('\n\n')).toHaveLength(2);
  });

  it('alphabetises the prose styles', () => {
    const out = formatBibliography(
      [paper({ authors: ['Zoe Zhang'] }), paper({ authors: ['Ada Lovelace'] })],
      'apa',
      AT
    );
    expect(out.indexOf('Lovelace')).toBeLessThan(out.indexOf('Zhang'));
  });

  it('returns an empty string for an empty library', () => {
    expect(formatBibliography([], 'bibtex', AT)).toBe('');
  });
});

describe('regressions found against the live Crossref API', () => {
  it('does not double the period after "et al."', () => {
    const out = formatCitation(withMeta(), 'mla', AT);
    expect(out).not.toContain('..');
    expect(out).toContain('et al. "');
  });
});
