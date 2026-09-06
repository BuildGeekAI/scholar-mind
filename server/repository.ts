import { FieldValue, Firestore } from '@google-cloud/firestore';
import { Message, Paper } from '../types';

export interface ProfileRecord {
  id: string;
  ownerId: string;
  title: string;
  emoji: string;
  theme: string;
  createdAt: number;
  updatedAt: number;
  scholarName?: string;
  affiliation?: string;
  topics?: string[];
  /** Set once the profile's File Search store exists (Phase 2). */
  fileSearchStoreName?: string;
  /**
   * Every identity this profile's scholar is known by — the URL it was built
   * from and the name that resolved to. Used to spot a second profile for a
   * scholar the user already has a library for.
   */
  scholarKeys?: string[];
}

// Constructed lazily so that merely importing the router (as vite.config does)
// never reaches for credentials. Firestore rejects undefined values, and Paper
// is mostly optional fields, hence ignoreUndefinedProperties.
let _db: Firestore | undefined;
const db = (): Firestore => {
  if (!_db) {
    _db = new Firestore({
      ignoreUndefinedProperties: true,
      projectId:
        process.env.GOOGLE_CLOUD_PROJECT ||
        (process.env.FIRESTORE_EMULATOR_HOST ? 'scholarmind-local' : undefined),
    });
  }
  return _db;
};

const profiles = () => db().collection('profiles');
const papersOf = (profileId: string) => profiles().doc(profileId).collection('papers');
const messagesOf = (profileId: string) => profiles().doc(profileId).collection('messages');

/** Deletes a subcollection in batches; Firestore has no recursive delete server-side. */
const deleteCollection = async (
  ref: FirebaseFirestore.CollectionReference,
  batchSize = 300
): Promise<void> => {
  while (true) {
    const snapshot = await ref.limit(batchSize).get();
    if (snapshot.empty) return;
    const batch = db().batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    if (snapshot.size < batchSize) return;
  }
};

export const listProfiles = async (ownerId: string): Promise<ProfileRecord[]> => {
  const snapshot = await profiles().where('ownerId', '==', ownerId).get();
  return snapshot.docs
    .map(d => d.data() as ProfileRecord)
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

export const getProfile = async (ownerId: string, id: string): Promise<ProfileRecord | null> => {
  const doc = await profiles().doc(id).get();
  if (!doc.exists) return null;
  const record = doc.data() as ProfileRecord;
  return record.ownerId === ownerId ? record : null;
};

export const createProfile = async (
  ownerId: string,
  partial: Partial<ProfileRecord> & { id: string }
): Promise<ProfileRecord> => {
  const now = Date.now();
  const record: ProfileRecord = {
    id: partial.id,
    ownerId,
    title: partial.title ?? 'Untitled profile',
    emoji: partial.emoji ?? '📒',
    theme: partial.theme ?? 'Ocean',
    createdAt: partial.createdAt ?? now,
    updatedAt: now,
    scholarName: partial.scholarName,
    affiliation: partial.affiliation,
    topics: partial.topics,
  };
  await profiles().doc(record.id).set(record);
  return record;
};

export const updateProfile = async (
  ownerId: string,
  id: string,
  patch: Partial<ProfileRecord>
): Promise<ProfileRecord | null> => {
  const existing = await getProfile(ownerId, id);
  if (!existing) return null;
  const { id: _ignoredId, ownerId: _ignoredOwner, ...safe } = patch;
  const updated = { ...existing, ...safe, updatedAt: Date.now() };
  await profiles().doc(id).set(updated);
  return updated;
};

export const deleteProfile = async (ownerId: string, id: string): Promise<boolean> => {
  const existing = await getProfile(ownerId, id);
  if (!existing) return false;
  await deleteCollection(papersOf(id));
  await deleteCollection(messagesOf(id));
  await profiles().doc(id).delete();
  return true;
};

/**
 * The shared paper corpus: one record per canonical paper, across every profile
 * and owner. It caches the *expensive and unreliable* half of indexing — source
 * resolution and the PDF download — so the second profile to index a paper
 * never repeats them. It holds nothing profile-specific.
 */
export interface CorpusRecord {
  key: string;
  title: string;
  /** Blob key of the cached PDF, if one was ever retrieved. */
  pdfBlobKey?: string;
  sourceUrl?: string;
  pdfStatus?: Paper['pdfStatus'];
  firstSeenAt: number;
  updatedAt: number;
  /** How many times reuse has saved a resolve-and-fetch. Diagnostics only. */
  reuseCount?: number;
}

const corpus = () => db().collection('corpus');

export const getCorpusRecord = async (key: string): Promise<CorpusRecord | null> => {
  const doc = await corpus().doc(key).get();
  return doc.exists ? (doc.data() as CorpusRecord) : null;
};

export const putCorpusRecord = async (record: CorpusRecord): Promise<void> => {
  await corpus().doc(record.key).set(record, { merge: true });
};

/** Atomic so concurrent workers indexing the same paper cannot lose counts. */
export const noteCorpusReuse = async (key: string): Promise<void> => {
  await corpus()
    .doc(key)
    .set({ reuseCount: FieldValue.increment(1), updatedAt: Date.now() }, { merge: true });
};

export const listCorpus = async (): Promise<CorpusRecord[]> => {
  const snapshot = await corpus().get();
  return snapshot.docs.map(d => d.data() as CorpusRecord);
};

export const listPapers = async (profileId: string): Promise<Paper[]> => {
  const snapshot = await papersOf(profileId).get();
  return snapshot.docs.map(d => d.data() as Paper);
};

/** One paper per document — the whole point of the subcollection split. */
/**
 * ignoreUndefinedProperties makes a merge write skip undefined keys, so clearing
 * a field would silently keep its old value. The pipeline's transient fields
 * must actually disappear when a paper settles.
 */
const CLEARABLE: (keyof Paper)[] = ['stage'];

const withDeletions = (paper: Paper): Record<string, unknown> => {
  const payload: Record<string, unknown> = { ...paper };
  for (const key of CLEARABLE) {
    if (payload[key] === undefined) payload[key] = FieldValue.delete();
  }
  return payload;
};

export const upsertPaper = async (profileId: string, paper: Paper): Promise<void> => {
  await papersOf(profileId).doc(paper.id).set(withDeletions(paper), { merge: true });
};

export const upsertPapers = async (profileId: string, papers: Paper[]): Promise<void> => {
  if (!papers.length) return;
  const batch = db().batch();
  papers.forEach(p => batch.set(papersOf(profileId).doc(p.id), withDeletions(p), { merge: true }));
  await batch.commit();
};

export const deletePaper = async (profileId: string, paperId: string): Promise<void> => {
  await papersOf(profileId).doc(paperId).delete();
};

export const listMessages = async (profileId: string): Promise<Message[]> => {
  const snapshot = await messagesOf(profileId).orderBy('timestamp').get();
  return snapshot.docs.map(d => d.data() as Message);
};

export const appendMessage = async (profileId: string, message: Message): Promise<void> => {
  await messagesOf(profileId).doc(message.id).set(message);
};

export const clearMessages = async (profileId: string): Promise<void> => {
  await deleteCollection(messagesOf(profileId));
};
