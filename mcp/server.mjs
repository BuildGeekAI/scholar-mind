#!/usr/bin/env node
/**
 * ScholarMind as an MCP server.
 *
 * It is a thin client over the HTTP API rather than a second implementation:
 * the same endpoints the browser uses, so an agent and a person cannot drift
 * apart on what a profile contains or how a source is indexed.
 *
 *   SCHOLARMIND_URL      default http://localhost:8080
 *   SCHOLARMIND_API_KEY  required when the server has one configured
 *
 * Register it with Claude Code:
 *   claude mcp add scholarmind -- node /absolute/path/to/mcp/server.mjs
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BASE = (process.env.SCHOLARMIND_URL || 'http://localhost:8080').replace(/\/$/, '');
const API_KEY = process.env.SCHOLARMIND_API_KEY || '';

const call = async (path, { method = 'GET', body, stream = false } = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let message = detail;
    try {
      message = JSON.parse(detail).error ?? detail;
    } catch {
      /* not JSON; the raw body is the best message available */
    }
    throw new Error(`${res.status} ${message || res.statusText}`);
  }

  if (!stream) return res.json();

  // Long operations stream SSE. Agents want the outcome, not the frames, so
  // events are collected and only the final state is returned.
  const text = await res.text();
  const events = [];
  for (const frame of text.split('\n\n')) {
    const name = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? 'message';
    const data = frame.match(/^data:\s*(.+)$/m)?.[1];
    if (!data) continue;
    try {
      events.push({ event: name, data: JSON.parse(data) });
    } catch {
      /* a malformed frame must not discard the ones that parsed */
    }
  }
  return events;
};

/** Trims a paper down to what an agent can act on. */
const brief = p => ({
  id: p.id,
  kind: p.kind ?? 'paper',
  title: p.title,
  year: p.year,
  authors: p.authors,
  summary: p.summary,
  sourceUrl: p.sourceUrl,
  indexed: p.indexStatus === 'indexed' || !!p.fileSearchDocName,
  hasArtifacts: p.status === 'converted',
});

const TOOLS = [
  {
    name: 'list_libraries',
    description:
      'List every library (profile), with how many sources each holds and how many are indexed. Start here to find what already exists.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const profiles = await call('/profiles');
      return Promise.all(
        profiles.map(async p => {
          const papers = await call(`/profiles/${p.id}/papers`);
          return {
            id: p.id,
            title: p.title,
            scholar: p.scholarName,
            affiliation: p.affiliation,
            sources: papers.length,
            indexed: papers.filter(x => x.fileSearchDocName).length,
          };
        })
      );
    },
  },
  {
    name: 'find_library',
    description:
      'Search existing libraries by scholar name, Google Scholar URL, title or topic. Answered from stored identities — no model call, no cost. Use before creating anything.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A scholar, topic, or Scholar profile URL' } },
      required: ['query'],
    },
    handler: ({ query }) => call(`/discover?q=${encodeURIComponent(query)}`),
  },
  {
    name: 'create_library',
    description:
      'Create an empty library. Prefer build_scholar_library when you know whose work it is for.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, emoji: { type: 'string' } },
      required: ['title'],
    },
    handler: ({ title, emoji }) => call('/profiles', { method: 'POST', body: { title, emoji: emoji || '📚' } }),
  },
  {
    name: 'build_scholar_library',
    description:
      "Create a library and populate it with a scholar's most-cited papers. Refuses with a duplicate when a library for that scholar already exists, unless allow_duplicate is set.",
    inputSchema: {
      type: 'object',
      properties: {
        scholar: { type: 'string', description: 'Name or Google Scholar profile URL' },
        allow_duplicate: { type: 'boolean' },
      },
      required: ['scholar'],
    },
    handler: async ({ scholar, allow_duplicate }) => {
      const profile = await call('/profiles', {
        method: 'POST',
        body: { title: 'Untitled profile', emoji: '🎓' },
      });
      try {
        const result = await call(`/profiles/${profile.id}/search`, {
          method: 'POST',
          body: { query: scholar, allowDuplicate: !!allow_duplicate },
        });
        return { profileId: profile.id, scholar: result.profile.scholarName, papers: result.papers.map(brief) };
      } catch (error) {
        // Do not strand an empty library when the search was refused.
        await call(`/profiles/${profile.id}`, { method: 'DELETE' }).catch(() => {});
        throw error;
      }
    },
  },
  {
    name: 'add_source',
    description:
      'Add any link to a library: a web page, a Wikipedia article, a YouTube video, or a PDF. It is read immediately and its content stored.',
    inputSchema: {
      type: 'object',
      properties: { library_id: { type: 'string' }, url: { type: 'string' } },
      required: ['library_id', 'url'],
    },
    handler: async ({ library_id, url }) =>
      brief(await call(`/profiles/${library_id}/sources`, { method: 'POST', body: { url } })),
  },
  {
    name: 'add_paper',
    description: 'Add a research paper to a library by title. Resolves the real metadata.',
    inputSchema: {
      type: 'object',
      properties: { library_id: { type: 'string' }, title: { type: 'string' } },
      required: ['library_id', 'title'],
    },
    handler: async ({ library_id, title }) =>
      brief(await call(`/profiles/${library_id}/papers/find`, { method: 'POST', body: { query: title } })),
  },
  {
    name: 'list_sources',
    description: 'List everything in a library, with its kind and whether it is indexed.',
    inputSchema: {
      type: 'object',
      properties: { library_id: { type: 'string' } },
      required: ['library_id'],
    },
    handler: async ({ library_id }) => (await call(`/profiles/${library_id}/papers`)).map(brief),
  },
  {
    name: 'index_sources',
    description:
      'Make sources searchable by embedding them. Seconds per source. Required before ask() can cite them. Omit source_ids to index everything unindexed.',
    inputSchema: {
      type: 'object',
      properties: {
        library_id: { type: 'string' },
        source_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['library_id'],
    },
    handler: async ({ library_id, source_ids }) => {
      const papers = await call(`/profiles/${library_id}/papers`);
      const ids = source_ids?.length
        ? source_ids
        : papers.filter(p => !p.fileSearchDocName).map(p => p.id);
      if (!ids.length) return { indexed: 0, note: 'Everything in this library is already indexed.' };
      const events = await call(`/profiles/${library_id}/process`, {
        method: 'POST',
        body: { paperIds: ids, mode: 'index' },
        stream: true,
      });
      const failed = events.filter(e => e.event === 'error');
      const after = await call(`/profiles/${library_id}/papers`);
      return {
        requested: ids.length,
        indexed: after.filter(p => ids.includes(p.id) && p.fileSearchDocName).length,
        errors: failed.map(e => e.data?.message).filter(Boolean),
      };
    },
  },
  {
    name: 'generate_study_material',
    description:
      'Write a blog post, slides, a quiz, flashcards, narration and cover art for sources. About a minute each — index_sources first if you only need search.',
    inputSchema: {
      type: 'object',
      properties: {
        library_id: { type: 'string' },
        source_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['library_id', 'source_ids'],
    },
    handler: async ({ library_id, source_ids }) => {
      await call(`/profiles/${library_id}/process`, {
        method: 'POST',
        body: { paperIds: source_ids, mode: 'artifacts' },
        stream: true,
      });
      const after = await call(`/profiles/${library_id}/papers`);
      return after.filter(p => source_ids.includes(p.id)).map(p => ({
        id: p.id,
        title: p.title,
        status: p.status,
        blogTitle: p.blogTitle,
        slides: p.slides?.length ?? 0,
        quiz: p.quiz?.length ?? 0,
        flashCards: p.flashCards?.length ?? 0,
      }));
    },
  },
  {
    name: 'ask',
    description:
      'Ask a question. With library_id it answers from that library only. Without one it answers across every library — but at most five at a time, and it reports which were searched.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        library_id: { type: 'string', description: 'Omit to ask across all libraries' },
        web_search: { type: 'boolean', description: 'Use live web search instead of the library' },
      },
      required: ['question'],
    },
    handler: async ({ question, library_id, web_search }) => {
      const events = await call('/chat', {
        method: 'POST',
        body: { profileId: library_id ?? null, message: question, useWebSearch: !!web_search },
        stream: true,
      });
      const answer = events
        .filter(e => e.event === 'delta')
        .map(e => e.data?.text ?? '')
        .join('');
      const done = events.find(e => e.event === 'done')?.data ?? {};
      const citations = events.find(e => e.event === 'citations')?.data?.citations ?? [];
      return {
        answer,
        grounded: done.grounded,
        searchedLibraries: done.searchedLibraries,
        skippedLibraries: done.skippedLibraries,
        citations: citations.map(c => c.fileName),
      };
    },
  },
  {
    name: 'get_citation',
    description:
      'Citations for one source in every supported style: bibtex, apa, mla, chicago, harvard, ris. Enriched from Crossref where a record matches; nothing is invented when none does.',
    inputSchema: {
      type: 'object',
      properties: { library_id: { type: 'string' }, source_id: { type: 'string' } },
      required: ['library_id', 'source_id'],
    },
    handler: ({ library_id, source_id }) =>
      call(`/profiles/${library_id}/papers/${source_id}/citation`),
  },
  {
    name: 'export_bibliography',
    description: 'The whole library as a bibliography in one style.',
    inputSchema: {
      type: 'object',
      properties: {
        library_id: { type: 'string' },
        style: { type: 'string', enum: ['bibtex', 'apa', 'mla', 'chicago', 'harvard', 'ris'] },
      },
      required: ['library_id', 'style'],
    },
    handler: ({ library_id, style }) => call(`/profiles/${library_id}/citations?style=${style}`),
  },
  {
    name: 'read_study_material',
    description:
      'The generated blog post, slides, quiz and flashcards for one source. Run generate_study_material first if it has none.',
    inputSchema: {
      type: 'object',
      properties: { library_id: { type: 'string' }, source_id: { type: 'string' } },
      required: ['library_id', 'source_id'],
    },
    handler: async ({ library_id, source_id }) => {
      const papers = await call(`/profiles/${library_id}/papers`);
      const paper = papers.find(p => p.id === source_id);
      if (!paper) throw new Error(`No source ${source_id} in that library.`);
      return {
        title: paper.title,
        status: paper.status,
        blogTitle: paper.blogTitle,
        blogContent: paper.blogContent,
        slides: paper.slides ?? [],
        quiz: paper.quiz ?? [],
        flashCards: paper.flashCards ?? [],
      };
    },
  },
];

const server = new Server(
  { name: 'scholarmind', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const tool = TOOLS.find(t => t.name === request.params.name);
  if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
  try {
    const result = await tool.handler(request.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    // Reported as tool output rather than thrown, so the agent can read the
    // reason and adjust instead of seeing an opaque protocol failure.
    return {
      content: [{ type: 'text', text: `Error: ${error?.message ?? error}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
