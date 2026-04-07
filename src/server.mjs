import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load the core context provider
import { RepoDocContextProvider } from "../../skyforce-core/lib/context/repo-doc-context-provider.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, "../../");

const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

// Registry of supported repositories
const REPOS = [
  "morphOS",
  "skyforce-core",
  "skyforce-symphony",
  "skyforce-harness",
  "skyforce-api-gateway",
  "skyforce-command-centre"
];

// Context Providers Cache
const providers = new Map();

function getProvider(repoName) {
  if (providers.has(repoName)) {
    return providers.get(repoName);
  }

  if (!REPOS.includes(repoName)) {
    return null;
  }

  const provider = new RepoDocContextProvider({
    repoRoot: path.join(WORKSPACE_ROOT, repoName),
    repoName
  });

  providers.set(repoName, provider);
  return provider;
}

// Health Check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "skyforce-context-hub", version: "1.0.0" });
});

// Search Context
app.get("/api/context/search", async (req, res) => {
  const { q, repo, limit = 10 } = req.query;

  if (!q) {
    return res.status(400).json({ error: "Query 'q' is required" });
  }

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

  // Global sort by score if available, otherwise just return aggregate
  results.sort((a, b) => (b.score || 0) - (a.score || 0));

  res.json({
    count: results.length,
    results: results.slice(0, parseInt(limit, 10))
  });
});

// Get Context by ID
app.get("/api/context/:context_id", async (req, res) => {
  const { context_id } = req.params;
  const { repo } = req.query;

  // If repo is provided, search directly. Otherwise, try to infer from ID.
  let targetRepo = repo;
  if (!targetRepo && context_id.startsWith("ref:")) {
    const parts = context_id.split(":");
    targetRepo = parts[1];
  }

  const provider = getProvider(targetRepo);
  if (!provider) {
    return res.status(404).json({ error: `Provider not found for ${targetRepo}` });
  }

  try {
    const item = await provider.get_context({ context_id });
    if (!item) {
      return res.status(404).json({ error: "Context item not found" });
    }
    res.json({ item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List Annotations for a Context Item
app.get("/api/context/:context_id/annotations", async (req, res) => {
  const { context_id } = req.params;
  const { repo, limit = 20, access_label, trust_label } = req.query;

  let targetRepo = repo;
  if (!targetRepo && context_id.startsWith("ref:")) {
    const parts = context_id.split(":");
    targetRepo = parts[1];
  }

  const provider = getProvider(targetRepo);
  if (!provider) {
    return res.status(404).json({ error: `Provider not found for ${targetRepo}` });
  }

  try {
    const filters = {};
    if (access_label) filters.access_labels = [access_label];
    if (trust_label) filters.trust_labels = [trust_label];

    const annotations = await provider.list_annotations({
      context_id,
      limit: parseInt(limit, 10),
      ...filters
    });

    res.json({
      context_id,
      count: annotations.length,
      annotations
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create Annotation
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
  if (!provider) {
    return res.status(404).json({ error: `Provider not found for ${targetRepo}` });
  }

  try {
    const annotation = await provider.create_annotation({
      context_id,
      content: note,
      author_kind,
      author_id,
      trust_label,
      access_label
    });
    res.status(201).json({ message: "Annotation created", annotation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3005;
app.listen(PORT, () => {
  console.log(`Context Hub operational at http://localhost:${PORT}`);
});
