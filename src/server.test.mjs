import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";

// Import the app factory (we need to refactor server.mjs slightly to export app)
// For now, test via HTTP against a running instance or use import
import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, "../../");

// Inline the RepoDocContextProvider for testing
const { RepoDocContextProvider } = await import(
  path.join(WORKSPACE_ROOT, "skyforce-core", "lib", "context", "repo-doc-context-provider.mjs")
);

function createTestApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const REPOS = ["morphOS", "skyforce-core", "skyforce-symphony", "skyforce-harness", "skyforce-api-gateway", "skyforce-command-centre"];
  const providers = new Map();

  function getProvider(repoName) {
    if (providers.has(repoName)) return providers.get(repoName);
    if (!REPOS.includes(repoName)) return null;
    const provider = new RepoDocContextProvider({ repoRoot: path.join(WORKSPACE_ROOT, repoName), repoName });
    providers.set(repoName, provider);
    return provider;
  }

  app.get("/health", (req, res) => {
    res.json({ status: "ok", service: "skyforce-context-hub", version: "1.0.0" });
  });

  app.get("/api/context/search", async (req, res) => {
    const { q, repo, limit = 10 } = req.query;
    if (!q) return res.status(400).json({ error: "Query 'q' is required" });
    const targetRepos = repo ? [repo] : REPOS;
    const results = [];
    for (const name of targetRepos) {
      const provider = getProvider(name);
      if (!provider) continue;
      try {
        const repoResults = await provider.search({ query: q, limit: parseInt(limit, 10) });
        results.push(...repoResults);
      } catch (err) {
        console.error(`Search failed for ${name}:`, err.message);
      }
    }
    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    res.json({ count: results.length, results: results.slice(0, parseInt(limit, 10)) });
  });

  app.get("/api/context/:context_id", async (req, res) => {
    const { context_id } = req.params;
    const { repo } = req.query;
    let targetRepo = repo;
    if (!targetRepo && context_id.startsWith("ref:")) {
      const parts = context_id.split(":");
      targetRepo = parts[1];
    }
    const provider = getProvider(targetRepo);
    if (!provider) return res.status(404).json({ error: `Provider not found for ${targetRepo}` });
    try {
      const item = await provider.get_context({ context_id });
      if (!item) return res.status(404).json({ error: "Context item not found" });
      res.json({ item });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/context/:context_id/annotations", async (req, res) => {
    const { context_id } = req.params;
    const { repo, limit = 20, access_label, trust_label } = req.query;
    let targetRepo = repo;
    if (!targetRepo && context_id.startsWith("ref:")) {
      const parts = context_id.split(":");
      targetRepo = parts[1];
    }
    const provider = getProvider(targetRepo);
    if (!provider) return res.status(404).json({ error: `Provider not found for ${targetRepo}` });
    try {
      const filters = {};
      if (access_label) filters.access_labels = [access_label];
      if (trust_label) filters.trust_labels = [trust_label];
      const annotations = await provider.list_annotations({ context_id, limit: parseInt(limit, 10), ...filters });
      res.json({ context_id, count: annotations.length, annotations });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/context/:context_id/annotations", async (req, res) => {
    const { context_id } = req.params;
    const { repo } = req.query;
    const { note, author_kind = "human", author_id = "operator", trust_label = "annotated", access_label = "workspace" } = req.body;
    let targetRepo = repo;
    if (!targetRepo && context_id.startsWith("ref:")) {
      const parts = context_id.split(":");
      targetRepo = parts[1];
    }
    const provider = getProvider(targetRepo);
    if (!provider) return res.status(404).json({ error: `Provider not found for ${targetRepo}` });
    try {
      const annotation = await provider.create_annotation({ context_id, content: note, author_kind, author_id, trust_label, access_label });
      res.status(201).json({ message: "Annotation created", annotation });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

describe("Context Hub Annotations Endpoint", () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = createTestApp();
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server.close();
  });

  it("GET /health returns ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, "ok");
    assert.strictEqual(body.service, "skyforce-context-hub");
  });

  it("GET /api/context/:context_id/annotations returns empty list for unknown context", async () => {
    const res = await fetch(`${baseUrl}/api/context/ref:skyforce-core:unknown/annotations`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.context_id, "ref:skyforce-core:unknown");
    assert.strictEqual(body.count, 0);
    assert.deepStrictEqual(body.annotations, []);
  });

  it("POST then GET annotations round-trip", async () => {
    const contextId = "ref:morphOS:test-annotations";
    const note = "Test annotation for verification";

    // Create annotation
    const postRes = await fetch(`${baseUrl}/api/context/${contextId}/annotations?repo=morphOS`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note, author_kind: "human", author_id: "test-operator", trust_label: "annotated", access_label: "workspace" }),
    });
    assert.strictEqual(postRes.status, 201);
    const postBody = await postRes.json();
    assert.ok(postBody.annotation);
    assert.strictEqual(postBody.annotation.content, note);
    assert.strictEqual(postBody.annotation.author_kind, "human");

    // Retrieve annotations
    const getRes = await fetch(`${baseUrl}/api/context/${contextId}/annotations?repo=morphOS`);
    assert.strictEqual(getRes.status, 200);
    const getBody = await getRes.json();
    assert.ok(getBody.count >= 1);
    const found = getBody.annotations.find((a) => a.annotation_id === postBody.annotation.annotation_id);
    assert.ok(found, "Created annotation should appear in list");
    assert.strictEqual(found.content, note);
  });

  it("GET annotations with access_label filter", async () => {
    const contextId = "ref:morphOS:test-filtered-annotations";

    // Create two annotations with different access labels
    await fetch(`${baseUrl}/api/context/${contextId}/annotations?repo=morphOS`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "public note", access_label: "workspace" }),
    });
    await fetch(`${baseUrl}/api/context/${contextId}/annotations?repo=morphOS`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "restricted note", access_label: "operator_only" }),
    });

    // Filter by workspace
    const res = await fetch(`${baseUrl}/api/context/${contextId}/annotations?repo=morphOS&access_label=workspace`);
    const body = await res.json();
    assert.strictEqual(body.count, 1);
    assert.strictEqual(body.annotations[0].content, "public note");
  });

  it("GET annotations returns 404 for unknown repo", async () => {
    const res = await fetch(`${baseUrl}/api/context/ref:unknown-repo:123/annotations?repo=unknown-repo`);
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.ok(body.error.includes("Provider not found"));
  });
});
