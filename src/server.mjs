import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

// Load the core context provider
import { RepoDocContextProvider } from "../../skyforce-core/lib/context/repo-doc-context-provider.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, "../../");
const SUMMARIES_DIR = path.join(WORKSPACE_ROOT, "morphOS", "memory", "operational_summaries");
const DEFAULT_REPOS = [
  "morphOS",
  "skyforce-core",
  "skyforce-symphony",
  "skyforce-harness",
  "skyforce-api-gateway",
  "skyforce-command-centre-live",
  "skyforce-command-centre"
];

const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

function configuredRepos() {
  const raw = process.env.SKYFORCE_CONTEXT_HUB_REPOS;
  if (!raw || raw.trim() === "") {
    return DEFAULT_REPOS;
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const REPOS = configuredRepos();

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

// Supported Repos
app.get("/api/context/repos", (req, res) => {
  res.json({
    count: REPOS.length,
    repos: REPOS
  });
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

// Compress Context — synthesize run history into operational summary
app.post("/api/context/compress", async (req, res) => {
  const { run_id, issue_identifier, workspace_id, run_artifacts } = req.body;

  if (!run_id || !issue_identifier) {
    return res.status(400).json({ error: "run_id and issue_identifier are required" });
  }

  await fs.mkdir(SUMMARIES_DIR, { recursive: true });

  const summary = {
    summary_id: `summary:${issue_identifier}:${run_id}`,
    run_id,
    issue_identifier,
    workspace_id,
    created_at: new Date().toISOString(),
    phase: "operational",
    artifact_count: run_artifacts ? Object.keys(run_artifacts).length : 0,
    artifacts: run_artifacts || {},
    key_decisions: extractKeyDecisions(run_artifacts),
    warnings: extractWarnings(run_artifacts),
    patterns: extractPatterns(run_artifacts),
  };

  const summaryPath = path.join(SUMMARIES_DIR, `${issue_identifier}-${run_id}.json`);
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");

  res.status(201).json({ message: "Operational summary created", summary_id: summary.summary_id });
});

// Get Operational Summary
app.get("/api/context/summary/:summary_id", async (req, res) => {
  const { summary_id } = req.params;
  const parts = summary_id.replace("summary:", "").split(":");
  const issueIdentifier = parts[0];
  const runId = parts[1];

  const summaryPath = path.join(SUMMARIES_DIR, `${issueIdentifier}-${runId}.json`);

  try {
    const content = await fs.readFile(summaryPath, "utf8");
    res.json({ summary: JSON.parse(content) });
  } catch {
    res.status(404).json({ error: "Summary not found" });
  }
});

// List Operational Summaries
app.get("/api/context/summaries", async (req, res) => {
  const { issue_identifier } = req.query;

  try {
    const files = await fs.readdir(SUMMARIES_DIR);
    let summaries = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      if (issue_identifier && !file.startsWith(issue_identifier)) continue;

      const content = await fs.readFile(path.join(SUMMARIES_DIR, file), "utf8");
      summaries.push(JSON.parse(content));
    }

    summaries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ count: summaries.length, summaries });
  } catch {
    res.json({ count: 0, summaries: [] });
  }
});

function extractKeyDecisions(artifacts) {
  if (!artifacts) return [];
  const decisions = [];
  for (const [key, value] of Object.entries(artifacts)) {
    if (key.includes("decision") || key.includes("plan")) {
      decisions.push({ source: key, content: typeof value === "string" ? value : JSON.stringify(value).slice(0, 200) });
    }
  }
  return decisions;
}

function extractWarnings(artifacts) {
  if (!artifacts) return [];
  const warnings = [];
  for (const [key, value] of Object.entries(artifacts)) {
    if (key.includes("error") || key.includes("warning") || key.includes("failure")) {
      warnings.push({ source: key, content: typeof value === "string" ? value : JSON.stringify(value).slice(0, 200) });
    }
  }
  return warnings;
}

function extractPatterns(artifacts) {
  if (!artifacts) return [];
  const patterns = [];
  if (artifacts?.test_results?.overall_result === "pass") {
    patterns.push("tests_passed_on_first_run");
  }
  if (artifacts?.validation_receipt?.status === "completed") {
    patterns.push("validation_completed_successfully");
  }
  return patterns;
}

const PORT = 3005;
app.listen(PORT, () => {
  console.log(`Context Hub operational at http://localhost:${PORT}`);
});
