import { Ctx } from './authz';
import { ProfileRecord } from './repository';
import { Hit, search } from './search';
import { MODELS, ai, extractText } from './gemini';

/**
 * Advisors: answering from a person's published work, in their register.
 *
 * This path does **not** use File Search, and that is deliberate rather than
 * incidental. A panel is a query across N libraries, and File Search accepts at
 * most five stores in one call — at six it returns `400`, so the existing chat
 * path stops working rather than degrading. Retrieving from Postgres and passing
 * the passages as text lifts the cap entirely.
 *
 * Two further things follow, and they are why this is the better path and not
 * merely the available one:
 *
 *  - **Citations become exact.** We know precisely which passages were handed to
 *    the model, so a citation is a fact about our own retrieval rather than
 *    something the model reported. That is what the codebase already demands of
 *    citations everywhere else.
 *  - **It composes.** With no tool attached, the constraint that File Search
 *    combines with neither Google Search nor URL Context simply does not apply.
 */

/**
 * Read at call time rather than at import, matching `aclEnabled()`. A constant
 * captured at module load cannot be varied by a test and cannot be changed
 * without a restart.
 */

/** Passages per advisor. Enough to answer from, few enough to stay readable. */
const passages = (): number => Number(process.env.ADVISOR_PASSAGES || 8);

/** Concurrent advisors, matching the ingest pipeline's restraint on rate limits. */
export const panelConcurrency = (): number => Number(process.env.ADVISOR_CONCURRENCY || 3);

/**
 * Panel size ceiling: each advisor is a retrieval plus a model call, so this is
 * a cost control rather than a technical limit. Unlike File Search's five-store
 * cap it can simply be raised — which is the point of this retrieval path.
 */
export const maxPanel = (): number => Number(process.env.ADVISOR_MAX_PANEL || 5);

export interface AdvisorCitation {
  paperId: string;
  paperTitle: string;
  profileId: string;
  /** The passage that was actually passed to the model, trimmed for display. */
  snippet: string;
}

export interface AdvisorAnswer {
  profileId: string;
  advisorName: string;
  answer: string;
  citations: AdvisorCitation[];
  /** True when nothing relevant was retrieved, so the advisor was not asked. */
  abstained: boolean;
}

export const advisorName = (profile: ProfileRecord): string =>
  profile.advisorName || profile.scholarName || profile.title;

/**
 * The persona, and the guardrails that keep it a persona rather than an
 * impersonation.
 *
 * The brief shapes register and stance. It must never supply facts: the model
 * will happily extend a confident brief into subjects the person never wrote
 * about, fluently and wrongly, and that failure is invisible to a reader who
 * does not already know the work. So the passages are stated to be the sole
 * authority, and not covering a question is named as an acceptable answer —
 * which it otherwise never is, for a model asked to be helpful.
 */
export const systemPrompt = (profile: ProfileRecord): string => {
  const name = advisorName(profile);
  const title = profile.advisorTitle ? ` (${profile.advisorTitle})` : '';
  const brief = profile.advisorBrief?.trim();

  return [
    `You are answering on behalf of ${name}${title}, drawing only on their published work.`,
    '',
    'Rules, in order of precedence:',
    `1. The passages below are your only source of fact. Do not draw on anything else you know about ${name}, and do not infer views they did not write down.`,
    `2. If the passages do not address the question, say so plainly and stop. "${name}'s work here does not cover that" is a correct and useful answer; inventing a plausible position is not.`,
    `3. Where the passages do address it, answer in ${name}'s register and from their standpoint, and refer to the specific work you are drawing on.`,
    '4. You are not the person. Never claim to be them, and never speak as though from beyond their published record.',
    brief ? `\nHow this advisor engages: ${brief}` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

const passageBlock = (hits: Hit[]): string =>
  hits
    .map((hit, i) => `[${i + 1}] From "${hit.paperTitle}":\n${hit.text}`)
    .join('\n\n');

export const buildInput = (
  profile: ProfileRecord,
  question: string,
  hits: Hit[]
): string =>
  `${systemPrompt(profile)}

Passages from ${advisorName(profile)}'s work:

${passageBlock(hits)}

Question: ${question}`;

const toCitations = (hits: Hit[]): AdvisorCitation[] =>
  hits.map(hit => ({
    paperId: hit.paperId,
    paperTitle: hit.paperTitle,
    profileId: hit.profileId,
    snippet: hit.text.replace(/\s+/g, ' ').trim().slice(0, 280),
  }));

/**
 * One advisor's answer.
 *
 * Never throws. One advisor being unreachable, rate-limited or simply empty
 * must not take down a panel — the same rule the ingest pipeline follows, where
 * generation returns a placeholder rather than aborting a run.
 */
export const askAdvisor = async (
  ctx: Ctx,
  profile: ProfileRecord,
  question: string
): Promise<AdvisorAnswer> => {
  const name = advisorName(profile);
  const base: AdvisorAnswer = {
    profileId: profile.id,
    advisorName: name,
    answer: '',
    citations: [],
    abstained: false,
  };

  let hits: Hit[] = [];
  try {
    hits = await search(ctx, question, { scope: 'profile', profileId: profile.id, limit: passages() });
  } catch (e) {
    console.error(`Retrieval failed for advisor ${name}:`, e);
    return { ...base, answer: `${name} could not be consulted: retrieval failed.`, abstained: true };
  }

  // Abstaining without a model call, rather than sending an empty passage list
  // and inviting an answer from nowhere. This is the guardrail that actually
  // holds — a prompt instruction is advice, an absent call is a guarantee.
  if (!hits.length) {
    return {
      ...base,
      answer: `Nothing in ${name}'s indexed work addresses this.`,
      abstained: true,
    };
  }

  try {
    // No tools. The passages are already in the prompt, and attaching a
    // grounding tool would both re-open the five-store limit and let the answer
    // draw on sources we did not choose and cannot cite exactly.
    const response = await (ai().interactions as any).create({
      model: MODELS.text,
      input: buildInput(profile, question, hits),
    });
    const answer = extractText(response).trim();
    if (!answer) throw new Error('empty response');
    return { ...base, answer, citations: toCitations(hits) };
  } catch (e) {
    console.error(`Advisor ${name} failed to answer:`, e);
    return {
      ...base,
      answer: `${name} could not be reached for this question.`,
      citations: toCitations(hits),
      abstained: true,
    };
  }
};

/** Runs `tasks` with at most `limit` in flight, preserving input order. */
export const pooled = async <T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> => {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
};

/**
 * A neutral summary across the panel. Opt-in: it costs a round trip and only
 * earns it when advisors disagree.
 */
export const synthesise = async (
  question: string,
  answers: AdvisorAnswer[]
): Promise<string | undefined> => {
  const answered = answers.filter(a => !a.abstained && a.answer);
  if (answered.length < 2) return undefined;

  const input = `Several advisors answered the same question, each from a different body of published work.
Summarise where they agree and where they genuinely differ. Attribute every point to the advisor who made it.
Do not introduce anything none of them said, and do not resolve a disagreement by picking a side.

Question: ${question}

${answered.map(a => `--- ${a.advisorName} ---\n${a.answer}`).join('\n\n')}`;

  try {
    const response = await (ai().interactions as any).create({ model: MODELS.text, input });
    return extractText(response).trim() || undefined;
  } catch (e) {
    // The individual answers are the substance; the summary is a convenience.
    console.error('Panel synthesis failed:', e);
    return undefined;
  }
};
