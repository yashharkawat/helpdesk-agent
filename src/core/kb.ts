import fs from "node:fs/promises";
import path from "node:path";
import { Bm25Index } from "./bm25";
import { EMBEDDING_DIM, embedQuery } from "./embedder";

export interface KbChunk { id: string; articleId: string; title: string; category: string; heading: string; text: string }
export interface KbArticle { id: string; title: string; category: string; body: string }
export interface KbHit { chunk: KbChunk; score: number }

const RRF_K = 60;
const CANDIDATES = 20;
export const KB_DIR = path.join(process.cwd(), "data", "kb");
export const KB_INDEX_DIR = path.join(process.cwd(), "data", "kb-index");

export function parseArticle(raw: string): KbArticle {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("Article is missing frontmatter");
  const meta = Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
  if (!meta.id || !meta.title) throw new Error("Article frontmatter needs id and title");
  return { id: meta.id, title: meta.title, category: meta.category ?? "General", body: m[2].trim() };
}

/** One chunk per `##` section: a help article answers one question per heading. */
export function chunkArticle(a: KbArticle): KbChunk[] {
  const sections = a.body.split(/\n(?=## )/);
  return sections
    .map((s, i) => {
      const heading = s.startsWith("## ") ? s.slice(3, s.indexOf("\n") === -1 ? undefined : s.indexOf("\n")).trim() : a.title;
      return { id: `${a.id}#${i + 1}`, articleId: a.id, title: a.title, category: a.category, heading, text: s.trim() };
    })
    .filter((c) => c.text.length > 0);
}

export const embeddingText = (c: KbChunk): string => `${c.title} - ${c.heading}\n${c.text}`;

interface LoadedKb { chunks: KbChunk[]; vectors: Float32Array; bm25: Bm25Index; articles: Map<string, KbArticle> }
let loaded: Promise<LoadedKb> | null = null;

export function loadKb(): Promise<LoadedKb> {
  loaded ??= (async () => {
    const chunks = JSON.parse(await fs.readFile(path.join(KB_INDEX_DIR, "chunks.json"), "utf8")) as KbChunk[];
    const buf = await fs.readFile(path.join(KB_INDEX_DIR, "vectors.bin"));
    const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (vectors.length !== chunks.length * EMBEDDING_DIM) throw new Error("kb-index is stale: run `npm run index-kb`");
    const articles = new Map<string, KbArticle>();
    for (const f of (await fs.readdir(KB_DIR)).filter((n) => n.endsWith(".md"))) {
      const a = parseArticle(await fs.readFile(path.join(KB_DIR, f), "utf8"));
      articles.set(a.id, a);
    }
    return { chunks, vectors, articles, bm25: new Bm25Index(chunks.map((c) => ({ text: c.text, boosted: `${c.title} ${c.heading}` }))) };
  })().catch((err) => {
    loaded = null;
    throw err;
  });
  return loaded;
}

/** Hybrid retrieval: cosine over local embeddings + BM25, fused by reciprocal rank. */
export async function searchKb(query: string, k: number): Promise<KbHit[]> {
  const kb = await loadKb();
  const q = await embedQuery(query);
  const dense: Array<[number, number]> = kb.chunks.map((_, i) => {
    let dot = 0;
    for (let j = 0; j < EMBEDDING_DIM; j++) dot += kb.vectors[i * EMBEDDING_DIM + j] * q[j];
    return [i, dot] as [number, number];
  });
  dense.sort((a, b) => b[1] - a[1]);
  const fused = new Map<number, number>();
  for (const list of [dense.slice(0, CANDIDATES), kb.bm25.search(query, CANDIDATES)]) {
    list.forEach(([doc], rank) => fused.set(doc, (fused.get(doc) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([i, score]) => ({ chunk: kb.chunks[i], score }));
}

export const getArticle = async (id: string): Promise<KbArticle | undefined> => (await loadKb()).articles.get(id);
export const listArticles = async (): Promise<KbArticle[]> => [...(await loadKb()).articles.values()];
