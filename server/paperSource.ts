import { Paper } from '../types';
import { ask, extractJson, googleSearchTool } from './gemini';

export interface PaperSource {
  pdfUrl?: string;
  landingUrl?: string;
  doi?: string;
  source: 'arxiv' | 'crossref' | 'unpaywall' | 'search' | 'none';
}

const UA = 'ScholarMind/1.0 (research assistant; +https://github.com/scholarmind)';
const timeout = (ms: number) => AbortSignal.timeout(ms);

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** arXiv's API is CORS-friendly and authoritative for preprints. */
const fromArxiv = async (title: string): Promise<PaperSource | null> => {
  try {
    const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(
      `ti:"${title}"`
    )}&max_results=1`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: timeout(15000) });
    if (!res.ok) return null;
    const xml = await res.text();

    const foundTitle = xml.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
    if (!foundTitle) return null;
    // Guard against arXiv returning a loosely related preprint.
    if (normalise(foundTitle) !== normalise(title)) return null;

    const pdfUrl = xml.match(/<link[^>]+title="pdf"[^>]+href="([^"]+)"/)?.[1];
    const landingUrl = xml.match(/<entry>[\s\S]*?<id>([\s\S]*?)<\/id>/)?.[1]?.trim();
    if (!pdfUrl) return null;
    return { pdfUrl: pdfUrl.replace(/^http:/, 'https:'), landingUrl, source: 'arxiv' };
  } catch {
    return null;
  }
};

const doiFromCrossref = async (title: string): Promise<string | null> => {
  try {
    const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(
      title
    )}&rows=1&select=DOI,title`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: timeout(15000) });
    if (!res.ok) return null;
    const json: any = await res.json();
    const item = json?.message?.items?.[0];
    if (!item?.DOI) return null;
    const found = Array.isArray(item.title) ? item.title[0] : item.title;
    if (!found || normalise(found) !== normalise(title)) return null;
    return item.DOI;
  } catch {
    return null;
  }
};

/**
 * Unpaywall's terms require a contact address, so the step is disabled unless
 * UNPAYWALL_EMAIL is configured rather than defaulting to somebody's address.
 */
const fromUnpaywall = async (doi: string): Promise<PaperSource | null> => {
  const email = process.env.UNPAYWALL_EMAIL;
  if (!email) return null;
  try {
    const res = await fetch(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`,
      { headers: { 'User-Agent': UA }, signal: timeout(15000) }
    );
    if (!res.ok) return null;
    const json: any = await res.json();
    const loc = json?.best_oa_location;
    if (!loc) return null;
    return {
      pdfUrl: loc.url_for_pdf || undefined,
      landingUrl: loc.url || undefined,
      doi,
      source: 'unpaywall',
    };
  } catch {
    return null;
  }
};

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    pdfUrl: { type: 'string' },
    landingUrl: { type: 'string' },
    openAccess: { type: 'boolean' },
  },
  required: ['openAccess'],
};

const fromSearch = async (paper: Paper): Promise<PaperSource | null> => {
  try {
    const interaction = await ask({
      input: `Find a freely and legally accessible full-text PDF for the paper
              "${paper.title}" by ${paper.authors.join(', ')} (${paper.year}).
              Prefer arXiv, PubMed Central, OpenReview, or ACL Anthology.
              Only report a PDF URL if it is open access. Return openAccess=false if none exists.`,
      schema: SEARCH_SCHEMA,
      tools: [googleSearchTool()],
    });
    const data = extractJson<any>(interaction, {});
    if (!data?.openAccess || !data.pdfUrl) return null;
    return { pdfUrl: data.pdfUrl, landingUrl: data.landingUrl, source: 'search' };
  } catch {
    return null;
  }
};

/** Deterministic sources first; the model is the fallback, not the default. */
export const resolvePaperSource = async (paper: Paper): Promise<PaperSource> => {
  const arxiv = await fromArxiv(paper.title);
  if (arxiv) return arxiv;

  const doi = await doiFromCrossref(paper.title);
  if (doi) {
    const unpaywall = await fromUnpaywall(doi);
    if (unpaywall?.pdfUrl) return unpaywall;
  }

  const searched = await fromSearch(paper);
  if (searched) return searched;

  return { doi: doi ?? undefined, source: 'none' };
};

const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** Fetches a resolved open-access PDF. Only URLs produced by resolution reach here. */
export const fetchPdf = async (url: string): Promise<Buffer | null> => {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/pdf' },
      redirect: 'follow',
      signal: timeout(60000),
    });
    if (!res.ok) return null;

    const type = res.headers.get('content-type') || '';
    if (!type.includes('pdf') && !type.includes('octet-stream')) return null;

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_PDF_BYTES) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_PDF_BYTES) return null;
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return null;
    return buffer;
  } catch {
    return null;
  }
};
