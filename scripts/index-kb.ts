import fs from "node:fs/promises";
import path from "node:path";
import { embedPassages } from "../src/core/embedder";
import { KB_DIR, KB_INDEX_DIR, chunkArticle, embeddingText, parseArticle } from "../src/core/kb";

/** Embeds every help-center section once; the result ships with the deployment. */
const files = (await fs.readdir(KB_DIR)).filter((f) => f.endsWith(".md")).sort();
const chunks = [];
for (const f of files) chunks.push(...chunkArticle(parseArticle(await fs.readFile(path.join(KB_DIR, f), "utf8"))));

const vectors = await embedPassages(chunks.map(embeddingText));
const flat = new Float32Array(vectors.length * vectors[0].length);
vectors.forEach((v, i) => flat.set(v, i * v.length));

await fs.mkdir(KB_INDEX_DIR, { recursive: true });
await fs.writeFile(path.join(KB_INDEX_DIR, "chunks.json"), JSON.stringify(chunks));
await fs.writeFile(path.join(KB_INDEX_DIR, "vectors.bin"), Buffer.from(flat.buffer));
console.log(`Indexed ${files.length} articles -> ${chunks.length} chunks`);
