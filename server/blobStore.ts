// Private attachment storage. Netlify Blobs in production (free tier included with the site); a local folder in
// development and tests. Files are only ever served through authenticated API routes, never by public URL.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface BlobStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

class FsStore implements BlobStore {
  constructor(private root: string) {}
  async put(key: string, data: Uint8Array) { const p = join(this.root, key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, data); }
  async get(key: string) { try { return new Uint8Array(await readFile(join(this.root, key))); } catch { return null; } }
}

let store: BlobStore | null = null;
export async function blobStore(): Promise<BlobStore> {
  if (store) return store;
  if (process.env.LOCAL_BLOB_DIR) { store = new FsStore(process.env.LOCAL_BLOB_DIR); return store; }
  const { getStore } = await import("@netlify/blobs");
  const s = getStore({ name: "private-attachments", consistency: "strong" });
  store = {
    put: async (k, d) => { await s.set(k, d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer); },
    get: async (k) => { const v = await s.get(k, { type: "arrayBuffer" }); return v ? new Uint8Array(v) : null; },
  };
  return store;
}
export function _setBlobStoreForTests(s: BlobStore | null) { store = s; }
