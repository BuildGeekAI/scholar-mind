import { Storage } from '@google-cloud/storage';
import { promises as fs } from 'fs';
import path from 'path';

export type BlobKind = 'pdf' | 'illustration' | 'audio' | 'media';

export interface StoredBlob {
  data: Buffer;
  contentType: string;
}

export interface BlobStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredBlob | null>;
  delete(key: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
}

export const blobKey = (profileId: string, paperId: string, kind: BlobKind): string =>
  `profiles/${profileId}/${paperId}/${kind}`;

export const profilePrefix = (profileId: string): string => `profiles/${profileId}/`;

const KEY_PATTERN = /^[A-Za-z0-9._\-/]+$/;

/** Keys are used as filesystem paths in the local store, so traversal must be impossible. */
const assertSafeKey = (key: string) => {
  if (!key || !KEY_PATTERN.test(key) || key.includes('..') || key.startsWith('/')) {
    throw new Error(`Unsafe blob key: ${key}`);
  }
};

class GcsBlobStore implements BlobStore {
  private readonly storage = new Storage();

  constructor(private readonly bucketName: string) {}

  private file(key: string) {
    assertSafeKey(key);
    return this.storage.bucket(this.bucketName).file(key);
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.file(key).save(data, { contentType, resumable: false });
  }

  async get(key: string): Promise<StoredBlob | null> {
    const file = this.file(key);
    try {
      const [data] = await file.download();
      const [metadata] = await file.getMetadata();
      return { data, contentType: metadata.contentType || 'application/octet-stream' };
    } catch (e: any) {
      if (e?.code === 404) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.file(key).delete({ ignoreNotFound: true });
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    assertSafeKey(prefix.replace(/\/$/, ''));
    await this.storage.bucket(this.bucketName).deleteFiles({ prefix, force: true });
  }
}

class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`Unsafe blob key: ${key}`);
    }
    return full;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    await fs.writeFile(`${full}.meta`, contentType, 'utf8');
  }

  async get(key: string): Promise<StoredBlob | null> {
    const full = this.resolve(key);
    try {
      const data = await fs.readFile(full);
      const contentType = await fs
        .readFile(`${full}.meta`, 'utf8')
        .catch(() => 'application/octet-stream');
      return { data, contentType: contentType.trim() };
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    const full = this.resolve(key);
    await fs.rm(full, { force: true });
    await fs.rm(`${full}.meta`, { force: true });
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    const full = this.resolve(prefix.replace(/\/$/, ''));
    await fs.rm(full, { recursive: true, force: true });
  }
}

/**
 * GCS when a bucket is configured, otherwise the local filesystem.
 * Both implementations satisfy the same contract, so the rest of the server
 * is identical between local development and Cloud Run.
 */
export const createBlobStore = (): BlobStore => {
  const bucket = process.env.GCS_BUCKET;
  if (bucket) return new GcsBlobStore(bucket);
  return new FsBlobStore(process.env.LOCAL_BLOB_DIR || path.resolve(process.cwd(), '.data/blobs'));
};

export { GcsBlobStore, FsBlobStore };
