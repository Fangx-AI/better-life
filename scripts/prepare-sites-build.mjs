#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const index = path.join(dist, "client", "index.html");
const worker = path.join(root, "worker", "index.js");
const hosting = path.join(root, ".openai", "hosting.json");
const qa = path.join(root, "server", "qa.mjs");
const qaNotice = path.join(root, "shared", "qa-notice.mjs");
const qaHistory = path.join(root, "shared", "qa-history.mjs");
const retrieval = path.join(root, "server", "retrieval.mjs");

for (const file of [index, worker, hosting, qa, qaNotice, qaHistory, retrieval]) {
  if (!existsSync(file)) throw new Error("Missing Sites build input: " + file);
}

mkdirSync(path.join(dist, "server"), { recursive: true });
mkdirSync(path.join(dist, "shared"), { recursive: true });
mkdirSync(path.join(dist, ".openai"), { recursive: true });
copyFileSync(worker, path.join(dist, "server", "index.js"));
copyFileSync(qa, path.join(dist, "server", "qa.mjs"));
copyFileSync(qaNotice, path.join(dist, "shared", "qa-notice.mjs"));
copyFileSync(qaHistory, path.join(dist, "shared", "qa-history.mjs"));
copyFileSync(retrieval, path.join(dist, "server", "retrieval.mjs"));
copyFileSync(hosting, path.join(dist, ".openai", "hosting.json"));

console.log("Prepared Sites build: dist/server/index.js, dist/shared/qa-notice.mjs and dist/.openai/hosting.json");
