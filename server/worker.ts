import './env';
import { hostname } from 'node:os';
import { Ctx } from './authz';
import { createBlobStore } from './blobStore';
import { closePool } from './db';
import { createStore } from './fileSearch';
import * as jobs from './jobs';
import { Job } from './jobs';
import * as repo from './repository';
import { PipelineMode, processPaper } from './ingest';
import { scholarKeysFor } from './corpus';
import { dueCrawlers, markCrawlerRun } from './crawler';
import { searchScholarAndPapers } from './gemini';

/**
 * The queue worker.
 *
 * Runs as its own process — `npm run worker` locally, a second Cloud Run service
 * off the same image in GCP. Crawling a scholar with sixty papers takes minutes;
 * doing that inside a request meant the work died with the connection and
 * competed with serving for the same instance.
 */

const WORKER_ID = `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 2);
const POLL_MS = Number(process.env.WORKER_POLL_MS || 1000);
const IDLE_POLL_MS = Number(process.env.WORKER_IDLE_POLL_MS || 5000);
const HEARTBEAT_MS = 15_000;
const STALE_SECONDS = Number(process.env.WORKER_STALE_SECONDS || 120);

const blobs = createBlobStore();

const ctxOf = (job: Job): Ctx => ({
  userId: job.ownerId,
  orgId: job.orgId,
  teamId: job.teamId,
  // The worker acts on the owner's behalf and never resolves an address; the
  // only consumer of `email` is the sharing UI, which is request-side.
  email: '',
});

/** Every profile that indexes needs a store; creating it lazily heals a profile
 *  whose best-effort creation at signup failed. */
const storeFor = async (
  ctx: Ctx,
  profile: repo.ProfileRecord
): Promise<string | undefined> => {
  if (profile.fileSearchStoreName) return profile.fileSearchStoreName;
  const storeName = await createStore(profile.title);
  if (storeName) await repo.updateProfile(ctx, profile.id, { fileSearchStoreName: storeName });
  return storeName;
};

// --- Handlers -----------------------------------------------------------------

/**
 * Resolves a scholar and fans out one indexing job per paper.
 *
 * The cheap duplicate check — the one computable from the query alone — already
 * ran request-side and answered 409. The second one cannot: it needs the
 * resolved name, which is what catches "G. Hinton" matching an existing
 * "Geoffrey Hinton", and that name only exists after the model call. So it runs
 * here, still before anything is written, and reports itself by cancelling the
 * run rather than failing it. The UI reads `run.detail.duplicate` and offers to
 * proceed anyway.
 */
const crawlProfile = async (job: Job): Promise<void> => {
  const ctx = ctxOf(job);
  const { profileId, query, mode, allowDuplicate } = job.payload as {
    profileId: string;
    query: string;
    mode?: PipelineMode;
    allowDuplicate?: boolean;
  };

  const profile = await repo.getProfile(ctx, profileId, 'edit');
  if (!profile) throw new Error(`Profile ${profileId} is gone or no longer writable.`);

  await jobs.note(job.id, 'searching', { query });
  const result = await searchScholarAndPapers(query);

  const keys = scholarKeysFor(query, result.name);
  if (!allowDuplicate) {
    const match = (await repo.findByScholarKeys(ctx, keys)).find(p => p.id !== profile.id);
    if (match) {
      const duplicate = {
        id: match.id,
        title: match.title,
        scholarName: match.scholarName,
        paperCount: (await repo.listPapers(match.id)).length,
      };
      await jobs.note(job.id, 'duplicate', duplicate);
      // Cancelled, not failed: nothing broke, and nothing was written.
      await jobs.cancelRun(job.runId!, { duplicate });
      return;
    }
  }

  await repo.upsertPapers(profile.id, result.papers);

  // Name the profile after the scholar rather than leaving the raw query, which
  // is often a Google Scholar URL. A URL must never become the name.
  const scholarName = result.name || 'Unnamed scholar';
  const untitled = !profile.title || profile.title === 'Untitled profile';
  await repo.updateProfile(ctx, profile.id, {
    scholarName,
    affiliation: result.affiliation,
    topics: result.topics,
    scholarKeys: keys,
    ...(untitled ? { title: scholarName } : {}),
  });

  await jobs.patchRun(job.runId!, { papersFound: result.papers.length, scholarName });
  await jobs.note(job.id, 'found', { papers: result.papers.length });

  // Fan out. Each paper is its own job so one failure cannot abort the rest and
  // every paper reports its own progress.
  for (const paper of result.papers) {
    await jobs.enqueue(ctx, {
      type: mode === 'artifacts' ? 'paper.enrich' : 'paper.index',
      runId: job.runId,
      parentJobId: job.id,
      payload: { profileId: profile.id, paperId: paper.id, mode: mode ?? 'index' },
      dedupeKey: `${mode ?? 'index'}:${profile.id}:${paper.id}`,
    });
  }
};

/** One paper through the existing pipeline. `mode` selects which halves run. */
const processOne = (mode: PipelineMode) => async (job: Job): Promise<void> => {
  const ctx = ctxOf(job);
  const { profileId, paperId } = job.payload as { profileId: string; paperId: string };

  const profile = await repo.getProfile(ctx, profileId, 'edit');
  if (!profile) throw new Error(`Profile ${profileId} is gone or no longer writable.`);

  const paper = await repo.getPaper(profileId, paperId);
  if (!paper) throw new Error(`Paper ${paperId} is no longer in ${profileId}.`);

  // Best-effort. Without a store the paper still reaches the search index; it
  // only loses chat grounding, which is not worth failing and retrying the job
  // for — and a retry would not fix a rejected API key anyway.
  const storeName =
    mode === 'artifacts' ? profile.fileSearchStoreName : await storeFor(ctx, profile);

  // `processPaper` already writes each stage to the database as it goes, so the
  // progress callback only has to add the job-side timeline.
  await processPaper(profileId, paper, blobs, storeName, mode, async current => {
    await jobs.note(job.id, 'stage', {
      paperId: current.id,
      title: current.title,
      stage: current.stage ?? null,
      status: current.status,
      indexStatus: current.indexStatus ?? null,
      pdfStatus: current.pdfStatus ?? null,
    });
  });
};

/** Re-arms every crawler whose interval has elapsed, then re-arms itself. */
const crawlerTick = async (job: Job): Promise<void> => {
  const ctx = ctxOf(job);
  const due = await dueCrawlers();
  for (const crawler of due) {
    const crawlerCtx: Ctx = {
      userId: crawler.ownerId,
      orgId: crawler.orgId,
      teamId: crawler.teamId,
      email: '',
    };
    const run = await jobs.createRun(
      crawlerCtx,
      crawler.profileId,
      'crawl',
      { target: crawler.target, scheduled: true },
      crawler.id
    );
    await jobs.enqueue(crawlerCtx, {
      type: 'crawl.profile',
      runId: run.id,
      payload: { profileId: crawler.profileId, query: crawler.target, mode: 'index' },
      dedupeKey: `crawl:${crawler.profileId}`,
    });
    await markCrawlerRun(crawler.id);
  }
  await jobs.note(job.id, 'scheduled', { crawlers: due.length });

  // Self-requeueing rather than an external scheduler: one mechanism, and it
  // works locally with nothing else running.
  await jobs.enqueue(ctx, {
    type: 'crawler.tick',
    dedupeKey: 'crawler.tick',
    delaySeconds: Number(process.env.CRAWLER_TICK_SECONDS || 60),
    priority: -1,
  });
};

const HANDLERS: Record<jobs.JobType, (job: Job) => Promise<void>> = {
  'crawl.profile': crawlProfile,
  'paper.index': processOne('index'),
  'paper.enrich': processOne('artifacts'),
  'paper.process': processOne('both'),
  'crawler.tick': crawlerTick,
};

// --- Loop ---------------------------------------------------------------------

const runJob = async (job: Job): Promise<void> => {
  const beat = setInterval(() => void jobs.heartbeat(job.id), HEARTBEAT_MS);
  try {
    if (job.runId) await jobs.markRunStarted(job.runId);
    await jobs.note(job.id, 'running', { attempt: job.attempts });

    const handler = HANDLERS[job.type];
    if (!handler) throw new Error(`No handler for job type ${job.type}`);
    await handler(job);

    await jobs.succeed(job.id);
  } catch (error) {
    const outcome = await jobs.fail(job, error);
    console.error(
      `Job ${job.type} ${job.id} ${outcome === 'dead' ? 'dead-lettered' : 'failed, will retry'}:`,
      error instanceof Error ? error.message : error
    );
  } finally {
    clearInterval(beat);
    // Settled from the jobs themselves, so a run advances even when a job was
    // requeued by the reaper rather than finishing here.
    if (job.runId) await jobs.settleRun(job.runId).catch(() => {});
  }
};

let stopping = false;
const inFlight = new Set<Promise<void>>();

const loop = async (): Promise<void> => {
  let lastReap = 0;
  while (!stopping) {
    if (Date.now() - lastReap > STALE_SECONDS * 500) {
      lastReap = Date.now();
      const reaped = await jobs.reapStale(STALE_SECONDS).catch(() => 0);
      if (reaped) console.log(`Requeued ${reaped} job(s) whose worker went away.`);
    }

    const free = CONCURRENCY - inFlight.size;
    const claimed = free > 0 ? await jobs.claim(WORKER_ID, free).catch(() => []) : [];

    for (const job of claimed) {
      const promise = runJob(job).finally(() => inFlight.delete(promise));
      inFlight.add(promise);
    }

    await new Promise(r => setTimeout(r, claimed.length ? POLL_MS : IDLE_POLL_MS));
  }
};

const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received; finishing ${inFlight.size} in-flight job(s).`);
  await Promise.allSettled([...inFlight]);
  await closePool();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

console.log(`Worker ${WORKER_ID} starting (concurrency ${CONCURRENCY}).`);
loop().catch(async e => {
  console.error('Worker loop died:', e);
  await closePool();
  process.exit(1);
});
