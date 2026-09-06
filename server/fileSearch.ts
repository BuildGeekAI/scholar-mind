import { MODELS, ai, retryWithBackoff } from './gemini';

/**
 * One File Search store per profile: retrieval stays scoped to the library in
 * use, stores stay well under the latency guidance, and deleting a profile is
 * a single store deletion.
 */
const storePrefix = process.env.FILE_SEARCH_STORE_PREFIX || '';

export const createStore = async (profileTitle: string): Promise<string | undefined> => {
  try {
    const store = await retryWithBackoff(() =>
      ai().fileSearchStores.create({
        config: {
          displayName: `${storePrefix}scholarmind-${profileTitle}`.slice(0, 60),
          embeddingModel: `models/${MODELS.embedding}`,
        },
      })
    );
    return store.name;
  } catch (e) {
    console.error('Could not create file search store:', e);
    return undefined;
  }
};

export const deleteStore = async (storeName: string): Promise<void> => {
  try {
    await ai().fileSearchStores.delete({ name: storeName, config: { force: true } });
  } catch (e) {
    console.error('Could not delete file search store:', e);
  }
};

/**
 * uploadToFileSearchStore accepts a Blob directly (spike finding R12), so bytes
 * stream from the blob store without a temp file or a Files API hop.
 */
export const indexDocument = async (
  storeName: string,
  data: Buffer,
  mime: string,
  displayName: string,
  metadata: Record<string, string>
): Promise<string | undefined> => {
  try {
    const blob = new Blob([new Uint8Array(data)], { type: mime });
    const operation: any = await retryWithBackoff(() =>
      (ai().fileSearchStores as any).uploadToFileSearchStore({
        file: blob,
        fileSearchStoreName: storeName,
        config: {
          displayName: displayName.slice(0, 60),
          customMetadata: Object.entries(metadata).map(([key, stringValue]) => ({ key, stringValue })),
        },
      })
    );
    return operation?.response?.documentName ?? operation?.name;
  } catch (e) {
    console.error('Could not index document:', e);
    return undefined;
  }
};
