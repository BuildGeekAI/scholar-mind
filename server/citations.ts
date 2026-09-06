import { Paper } from '../types';

/**
 * Citations are formatted from metadata we actually hold, and enriched only
 * from Crossref — never from the model.
 *
 * A hallucinated volume number or page range is worse than a missing one: it
 * looks authoritative, gets pasted into a bibliography, and is wrong. So every
 * field here either came from the source, from Crossref's record of it, or is
 * omitted.
 */

export type CitationStyle = 'bibtex' | 'apa' | 'mla' | 'chicago' | 'harvard' | 'ris';

export const STYLES: CitationStyle[] = ['bibtex', 'apa', 'mla', 'chicago', 'harvard', 'ris'];

/** Authoritative bibliographic detail, as returned by Crossref. */
export interface CitationMeta {
  doi?: string;
  containerTitle?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  page?: string;
  issued?: string;
  type?: string;
}

const UA = 'ScholarMind/1.0 (citation metadata)';

const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Only accepts a record whose title matches the paper we asked about. Crossref
 * always returns its best guess, and a near-miss would silently attribute one
 * paper's volume and pages to another.
 */
export const lookupCitationMeta = async (title: string): Promise<CitationMeta | null> => {
  try {
    const url =
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(title)}` +
      `&rows=5&select=DOI,title,container-title,publisher,volume,issue,page,issued,type`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();

    // Several rows, because the exact title is often not Crossref's top hit —
    // but still only an exact normalised match. Searching "Attention Is All You
    // Need" returns "Is Attention All You Need?", a different paper entirely,
    // and accepting it would attribute its DOI and pages to ours.
    const wanted = normalise(title);
    const item = (json?.message?.items ?? []).find((candidate: any) => {
      const found = Array.isArray(candidate?.title) ? candidate.title[0] : candidate?.title;
      return candidate?.DOI && found && normalise(found) === wanted;
    });
    if (!item) return null;

    const container = Array.isArray(item['container-title'])
      ? item['container-title'][0]
      : item['container-title'];

    return {
      doi: item.DOI,
      containerTitle: container || undefined,
      publisher: item.publisher || undefined,
      volume: item.volume || undefined,
      issue: item.issue || undefined,
      page: item.page || undefined,
      issued: item.issued?.['date-parts']?.[0]?.[0]
        ? String(item.issued['date-parts'][0][0])
        : undefined,
      type: item.type || undefined,
    };
  } catch {
    return null;
  }
};

// --- Name handling ----------------------------------------------------------

interface Name {
  family: string;
  given: string;
}

/** Accepts "Ashish Vaswani" and "Vaswani, Ashish"; both are common in our data. */
const parseName = (raw: string): Name => {
  const value = (raw || '').trim();
  if (!value) return { family: '', given: '' };
  if (value.includes(',')) {
    const [family, given = ''] = value.split(',').map(part => part.trim());
    return { family, given };
  }
  const parts = value.split(/\s+/);
  if (parts.length === 1) return { family: parts[0], given: '' };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
};

const initials = (given: string): string =>
  given
    .split(/[\s.]+/)
    .filter(Boolean)
    .map(part => `${part[0].toUpperCase()}.`)
    .join(' ');

const namesOf = (paper: Paper): Name[] => (paper.authors ?? []).filter(Boolean).map(parseName);

/** "Vaswani, A., Shazeer, N., & Parmar, N." — APA and Harvard. */
const authorsInverted = (names: Name[], ampersand: boolean): string => {
  if (!names.length) return '';
  const formatted = names.map(n => (n.given ? `${n.family}, ${initials(n.given)}` : n.family));
  if (formatted.length === 1) return formatted[0];
  const last = formatted[formatted.length - 1];
  return `${formatted.slice(0, -1).join(', ')}${ampersand ? ', & ' : ', and '}${last}`;
};

/** "Vaswani, Ashish, et al." — MLA truncates at three or more. */
const authorsMla = (names: Name[]): string => {
  if (!names.length) return '';
  const first = names[0].given ? `${names[0].family}, ${names[0].given}` : names[0].family;
  if (names.length === 1) return first;
  if (names.length === 2) {
    const second = names[1].given ? `${names[1].given} ${names[1].family}` : names[1].family;
    return `${first}, and ${second}`;
  }
  return `${first}, et al.`;
};

const bibtexKey = (paper: Paper, names: Name[]): string => {
  const family = (names[0]?.family || 'anon').toLowerCase().replace(/[^a-z0-9]/g, '');
  const year = paper.year || 'nd';
  const word =
    (paper.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .find(w => w.length > 3) || 'untitled';
  return `${family}${year}${word}`;
};

/** BibTeX is a macro language: braces and backslashes must not survive raw. */
const bibtexEscape = (value: string): string =>
  (value || '').replace(/[\\{}]/g, '').replace(/[&%$#_]/g, m => `\\${m}`);

/** The entry type Crossref's record implies, defaulting by source kind. */
const entryType = (paper: Paper, meta?: CitationMeta): string => {
  if (meta?.type === 'journal-article') return 'article';
  if (meta?.type === 'proceedings-article') return 'inproceedings';
  if (meta?.type === 'book' || meta?.type === 'monograph') return 'book';
  switch (paper.kind) {
    case 'youtube':
    case 'video':
    case 'audio':
    case 'web':
    case 'wikipedia':
      return 'misc';
    default:
      return 'article';
  }
};

const accessed = (now: Date) =>
  now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * `now` is injected rather than read here, so "accessed" dates are testable and
 * a whole export shares one timestamp.
 */
export const formatCitation = (
  paper: Paper,
  style: CitationStyle,
  now: Date = new Date()
): string => {
  const meta = paper.citationMeta;
  const names = namesOf(paper);
  const year = meta?.issued || paper.year || 'n.d.';
  const title = (paper.title || 'Untitled').trim();
  const url = paper.sourceUrl;
  const doiUrl = meta?.doi ? `https://doi.org/${meta.doi}` : undefined;
  const link = doiUrl || url;
  const isMedia = ['youtube', 'video', 'audio'].includes(paper.kind ?? 'paper');
  const isWeb = ['web', 'wikipedia'].includes(paper.kind ?? 'paper');

  switch (style) {
    case 'bibtex': {
      const fields: [string, string | undefined][] = [
        ['title', title],
        ['author', names.map(n => (n.given ? `${n.family}, ${n.given}` : n.family)).join(' and ') || undefined],
        ['year', meta?.issued || paper.year || undefined],
        ['journal', meta?.containerTitle],
        ['publisher', meta?.publisher],
        ['volume', meta?.volume],
        ['number', meta?.issue],
        ['pages', meta?.page],
        ['doi', meta?.doi],
        ['url', link],
        ['note', isMedia || isWeb ? `${paper.kind} source` : undefined],
      ];
      const body = fields
        .filter(([, value]) => value)
        .map(([name, value]) => `  ${name} = {${bibtexEscape(String(value))}}`)
        .join(',\n');
      return `@${entryType(paper, meta)}{${bibtexKey(paper, names)},\n${body}\n}`;
    }

    case 'apa': {
      const who = authorsInverted(names, true);
      const container = meta?.containerTitle;
      const bits = [who ? `${who} (${year}).` : `${title}. (${year}).`];
      if (who) bits.push(`${title}.`);
      if (container) {
        const vol = meta?.volume ? ` ${meta.volume}${meta.issue ? `(${meta.issue})` : ''}` : '';
        bits.push(`${container}${vol}${meta?.page ? `, ${meta.page}` : ''}.`);
      } else if (isMedia) {
        bits.push('[Video].');
      }
      if (link) bits.push(link);
      return bits.join(' ');
    }

    case 'mla': {
      const who = authorsMla(names);
      const container = meta?.containerTitle;
      // "et al." already ends in a period; a second one is a typo, not a style.
      const bits = [who ? (who.endsWith('.') ? who : `${who}.`) : ''];
      bits.push(`"${title}."`);
      if (container) bits.push(`*${container}*,`);
      bits.push(`${year}.`);
      if (link) bits.push(`${link}.`);
      if (isWeb) bits.push(`Accessed ${accessed(now)}.`);
      return bits.filter(Boolean).join(' ');
    }

    case 'chicago': {
      const who = names
        .map((n, i) =>
          i === 0
            ? n.given
              ? `${n.family}, ${n.given}`
              : n.family
            : n.given
              ? `${n.given} ${n.family}`
              : n.family
        )
        .join(', ');
      const bits = [who ? `${who}.` : ''];
      bits.push(`"${title}."`);
      if (meta?.containerTitle) {
        bits.push(
          `${meta.containerTitle}${meta.volume ? ` ${meta.volume}` : ''}${meta.issue ? `, no. ${meta.issue}` : ''} (${year})${meta.page ? `: ${meta.page}` : ''}.`
        );
      } else {
        bits.push(`${year}.`);
      }
      if (link) bits.push(link + '.');
      return bits.filter(Boolean).join(' ');
    }

    case 'harvard': {
      const who = authorsInverted(names, true);
      const bits = [who ? `${who} ${year},` : `${year},`];
      bits.push(`'${title}',`);
      if (meta?.containerTitle) {
        bits.push(
          `${meta.containerTitle}${meta.volume ? `, vol. ${meta.volume}` : ''}${meta.issue ? `, no. ${meta.issue}` : ''}${meta.page ? `, pp. ${meta.page}` : ''}.`
        );
      }
      if (link) bits.push(`Available at: ${link}`);
      if (isWeb || isMedia) bits.push(`(Accessed: ${accessed(now)}).`);
      return bits.filter(Boolean).join(' ');
    }

    case 'ris': {
      const tag = isMedia ? 'VIDEO' : isWeb ? 'ELEC' : meta?.containerTitle ? 'JOUR' : 'GEN';
      const lines = [`TY  - ${tag}`];
      for (const n of names) lines.push(`AU  - ${n.given ? `${n.family}, ${n.given}` : n.family}`);
      lines.push(`TI  - ${title}`);
      if (meta?.issued || paper.year) lines.push(`PY  - ${meta?.issued || paper.year}`);
      if (meta?.containerTitle) lines.push(`JO  - ${meta.containerTitle}`);
      if (meta?.volume) lines.push(`VL  - ${meta.volume}`);
      if (meta?.issue) lines.push(`IS  - ${meta.issue}`);
      if (meta?.page) lines.push(`SP  - ${meta.page}`);
      if (meta?.publisher) lines.push(`PB  - ${meta.publisher}`);
      if (meta?.doi) lines.push(`DO  - ${meta.doi}`);
      if (link) lines.push(`UR  - ${link}`);
      lines.push('ER  - ');
      return lines.join('\n');
    }
  }
};

/** The whole library in one style, in a form the target tool will accept. */
export const formatBibliography = (
  papers: Paper[],
  style: CitationStyle,
  now: Date = new Date()
): string => {
  const entries = papers.map(p => formatCitation(p, style, now));
  // BibTeX and RIS are record formats; the prose styles are an alphabetised list.
  if (style === 'bibtex' || style === 'ris') return entries.join('\n\n');
  return [...entries].sort((a, b) => a.localeCompare(b)).join('\n\n');
};
