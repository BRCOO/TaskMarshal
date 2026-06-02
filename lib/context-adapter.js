import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_CHARS = 1200;
const MAX_FILES_SCANNED = 500;
const MAX_FILE_BYTES = 80_000;
const CODEGRAPH_TIMEOUT_MS = 10000;
const CODEGRAPH_MAX_NODES = 12;
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC_CONTEXT_PATTERN = /\b(readme|docs?|documentation|markdown|changelog|license|contributing|security|todo|guide|manual)\b/;
const IGNORE_DIRS = new Set([
  ".git",
  ".codegraph",
  ".taskmarshal",
  ".reasonix",
  ".reasonixctl",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "__pycache__"
]);
const TEXT_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".rs", ".go", ".java", ".kt", ".cs", ".cpp", ".c", ".h",
  ".json", ".md", ".toml", ".yaml", ".yml", ".css", ".html", ".sh", ".ps1"
]);
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "task",
  "fix", "add", "update", "implement", "code", "repo", "file", "files",
  "our", "you", "we", "a", "an", "to", "of", "in", "on", "is", "are"
]);

export function buildContextPacket({
  root = process.cwd(),
  goal = "",
  scope = "",
  maxChars = DEFAULT_MAX_CHARS,
  backend = process.env.TASKMARSHAL_CONTEXT_BACKEND
} = {}) {
  const repoRoot = resolve(root);
  const budget = normalizeMaxChars(maxChars);
  const preferredBackend = normalizeBackend(backend);
  if (preferredBackend === "local-static" || (preferredBackend === "auto" && shouldPreferLocalStatic({ goal, scope }))) {
    return buildLocalStaticContextPacket({
      root: repoRoot,
      goal,
      scope,
      maxChars: budget
    });
  }
  if (preferredBackend !== "local-static") {
    const codegraphPacket = buildCodegraphContextPacket({
      root: repoRoot,
      goal,
      scope,
      maxChars: budget
    });
    if (codegraphPacket) return codegraphPacket;
  }
  return buildLocalStaticContextPacket({
    root: repoRoot,
    goal,
    scope,
    maxChars: budget
  });
}

function buildLocalStaticContextPacket({
  root,
  goal,
  scope,
  maxChars
}) {
  const repoRoot = resolve(root);
  const budget = normalizeMaxChars(maxChars);
  const queryTerms = extractTerms(`${goal} ${scope}`);
  const scopeHints = splitScope(scope);
  const files = collectFiles(repoRoot);
  const ranked = rankFiles({ root: repoRoot, files, queryTerms, scopeHints });
  const topFiles = ranked.slice(0, 8);
  const symbols = shouldPreferLocalStatic({ goal, scope }) ? [] : collectSymbols(repoRoot, topFiles.slice(0, 5));
  const packet = {
    ok: true,
    backend: "local-static",
    generatedAt: new Date().toISOString(),
    root: repoRoot,
    goal: limitInline(goal, 180),
    queryTerms,
    relevantFiles: topFiles.map((item) => ({
      path: item.path,
      score: item.score,
      reasons: item.reasons.slice(0, 3)
    })),
    symbols: symbols.slice(0, 12),
    impact: inferImpact(topFiles),
    risks: inferRisks({ goal, topFiles, scannedCount: files.length }),
    confidence: confidenceFor(topFiles, files.length),
    limits: {
      maxChars: budget,
      scannedFiles: files.length,
      maxFilesScanned: MAX_FILES_SCANNED
    }
  };
  return compactPacket(packet, budget);
}

function buildCodegraphContextPacket({
  root,
  goal,
  scope,
  maxChars
}) {
  if (!existsSync(resolve(root, ".codegraph"))) return null;
  const command = resolveCodegraphCommand();
  if (!command) return null;
  const status = runCodegraphJson(command, ["status", root, "--json"], root);
  const task = [goal, scope ? `Scope: ${scope}` : ""].filter(Boolean).join("\n");
  const context = runCodegraphJson(command, [
    "context",
    task,
    "--path",
    root,
    "--format",
    "json",
    "--max-nodes",
    String(CODEGRAPH_MAX_NODES),
    "--no-code"
  ], root);
  if (!context || !Array.isArray(context.nodes)) return null;
  const queryTerms = extractTerms(`${goal} ${scope}`);
  const relevantFiles = codegraphRelevantFiles(context, scope).slice(0, 8);
  const packet = {
    ok: true,
    backend: "codegraph",
    generatedAt: new Date().toISOString(),
    root,
    goal: limitInline(goal, 180),
    queryTerms,
    summary: limitInline(context.summary || "", 240),
    relevantFiles,
    symbols: context.nodes.slice(0, 12).map((node) => compactCodegraphNode(node)),
    impact: inferImpact(relevantFiles),
    risks: [
      ...codegraphRisks(status),
      ...inferRisks({
        goal,
        topFiles: relevantFiles,
        scannedCount: context.stats?.fileCount ?? relevantFiles.length
      })
    ].slice(0, 5),
    confidence: confidenceForCodegraph(context, relevantFiles),
    limits: {
      maxChars,
      backendMaxNodes: CODEGRAPH_MAX_NODES,
      nodeCount: context.stats?.nodeCount ?? context.nodes.length,
      edgeCount: context.stats?.edgeCount ?? 0,
      fileCount: context.stats?.fileCount ?? relevantFiles.length
    }
  };
  return compactPacket(packet, maxChars);
}

function collectFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES_SCANNED) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_FILES_SCANNED) break;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!TEXT_EXTS.has(ext)) continue;
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      out.push({
        full,
        path: normalizePath(relative(root, full)),
        name: entry.name,
        ext,
        size
      });
    }
  }
  return out;
}

function resolveCodegraphCommand() {
  const shim = resolve(MODULE_ROOT, "node_modules", "@colbymchenry", "codegraph", "npm-shim.js");
  if (existsSync(shim)) {
    return { command: process.execPath, args: [shim] };
  }
  if (process.env.TASKMARSHAL_CODEGRAPH_COMMAND) {
    return { command: process.env.TASKMARSHAL_CODEGRAPH_COMMAND, args: [] };
  }
  return null;
}

function runCodegraphJson(command, args, cwd) {
  const child = spawnSync(command.command, [...command.args, ...args], {
    cwd,
    encoding: "utf8",
    timeout: CODEGRAPH_TIMEOUT_MS,
    windowsHide: true
  });
  if (child.status !== 0 || child.error) return null;
  const text = stripAnsi(child.stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function codegraphRelevantFiles(context, scope) {
  const scoped = new Set(splitScope(scope).map(normalizePath));
  const scores = new Map();
  for (const file of context.relatedFiles || []) {
    addFileScore(scores, file, 8, "related");
  }
  for (const node of context.nodes || []) {
    addFileScore(scores, node.filePath, 10, `symbol:${node.name || node.kind || "node"}`);
  }
  for (const entry of context.entryPoints || []) {
    addFileScore(scores, entry.filePath, 6, "entry");
  }
  for (const hint of scoped) {
    for (const [path, item] of scores.entries()) {
      if (path.includes(hint) || hint.includes(path)) {
        item.score += 20;
        item.reasons.push("scope");
      }
    }
  }
  return [...scores.values()]
    .map((item) => ({ ...item, reasons: [...new Set(item.reasons)].slice(0, 3) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function addFileScore(scores, filePath, score, reason) {
  if (!filePath) return;
  const path = normalizePath(filePath);
  if (!scores.has(path)) scores.set(path, { path, score: 0, reasons: [] });
  const item = scores.get(path);
  item.score += score;
  item.reasons.push(reason);
}

function compactCodegraphNode(node) {
  return {
    name: node.name || node.qualifiedName || "",
    kind: node.kind || "symbol",
    file: normalizePath(node.filePath || ""),
    line: Number.isFinite(Number(node.startLine)) ? Number(node.startLine) : null
  };
}

function rankFiles({ root, files, queryTerms, scopeHints }) {
  return files
    .map((file) => {
      const pathText = file.path.toLowerCase();
      let text = "";
      try {
        text = readFileSync(resolve(root, file.path), "utf8").slice(0, 20000).toLowerCase();
      } catch {
        text = "";
      }
      const reasons = [];
      let score = 0;
      for (const hint of scopeHints) {
        if (pathText.includes(hint.toLowerCase())) {
          score += 20;
          reasons.push("scope");
        }
      }
      for (const term of queryTerms) {
        if (pathText.includes(term)) {
          score += 8;
          reasons.push(`path:${term}`);
        }
        const hits = countOccurrences(text, term);
        if (hits) {
          score += Math.min(10, hits);
          reasons.push(`text:${term}`);
        }
      }
      if (["package.json", "README.md"].includes(basename(file.path))) {
        score += 2;
        reasons.push("repo-entry");
      }
      return { path: file.path, score, reasons: [...new Set(reasons)] };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function collectSymbols(root, files) {
  const symbols = [];
  const seen = new Set();
  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    /\bfunction\s+([A-Za-z0-9_$]+)/g,
    /\bclass\s+([A-Za-z0-9_$]+)/g,
    /\bconst\s+([A-Za-z0-9_$]+)\s*=/g
  ];
  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(resolve(root, file.path), "utf8").slice(0, 30000);
    } catch {
      continue;
    }
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const key = `${match[1]}:${file.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        symbols.push({ name: match[1], file: file.path });
        if (symbols.length >= 20) return symbols;
      }
    }
  }
  return symbols;
}

function inferImpact(files) {
  const paths = files.map((file) => file.path);
  const impact = [];
  if (paths.some((path) => path.includes("mcp") || path.includes("server"))) impact.push("MCP tool surface");
  if (paths.some((path) => path.includes("taskmarshalctl"))) impact.push("CLI behavior");
  if (paths.some((path) => path.startsWith("scripts/"))) impact.push("eval or smoke scripts");
  if (paths.some((path) => path.startsWith("lib/"))) impact.push("shared library behavior");
  if (paths.some((path) => path.includes("README") || path.includes("docs/"))) impact.push("documentation");
  return impact.slice(0, 6);
}

function inferRisks({ goal, topFiles, scannedCount }) {
  const text = `${goal} ${topFiles.map((file) => file.path).join(" ")}`.toLowerCase();
  const risks = [];
  if (/\b(auth|secret|token|key|security|permission)\b/.test(text)) risks.push("security-sensitive path; require focused review");
  if (/\bmcp|tool|schema\b/.test(text)) risks.push("MCP schema changes can increase Codex context");
  if (/\bmetrics|eval|benchmark\b/.test(text)) risks.push("benchmark fixtures must stay deterministic");
  if (!topFiles.length) risks.push("no strong local matches; broaden scope or use full repo search");
  if (scannedCount >= MAX_FILES_SCANNED) risks.push("scan limit reached; context may be incomplete");
  return risks.slice(0, 5);
}

function codegraphRisks(status) {
  const risks = [];
  if (pendingChangeCount(status) > 0) {
    risks.push("codegraph index has pending changes; run codegraph sync for freshest context");
  }
  return risks;
}

function confidenceFor(topFiles, scannedCount) {
  if (!topFiles.length) return "low";
  if (topFiles[0].score >= 20 && scannedCount < MAX_FILES_SCANNED) return "high";
  return "medium";
}

function confidenceForCodegraph(context, relevantFiles) {
  if (!context.nodes?.length || !relevantFiles.length) return "low";
  if ((context.stats?.nodeCount ?? context.nodes.length) >= 3) return "high";
  return "medium";
}

function compactPacket(packet, maxChars) {
  let out = packet;
  const steps = [
    () => ({ ...out, symbols: out.symbols.slice(0, 8) }),
    () => ({ ...out, relevantFiles: out.relevantFiles.slice(0, 6) }),
    () => ({ ...out, risks: out.risks.slice(0, 3), impact: out.impact.slice(0, 4), summary: limitInline(out.summary || "", 120) || undefined }),
    () => ({ ...out, symbols: out.symbols.slice(0, 4), relevantFiles: out.relevantFiles.slice(0, 4) }),
    () => ({ ...out, queryTerms: out.queryTerms.slice(0, 8) }),
    () => ({
      ...out,
      symbols: out.symbols.slice(0, 4).map((item) => ({ name: item.name, file: item.file })),
      relevantFiles: out.relevantFiles.slice(0, 4).map((item) => ({ path: item.path, score: item.score })),
      summary: undefined
    })
  ];
  for (const shrink of [null, ...steps]) {
    if (shrink) out = shrink();
    const text = JSON.stringify(out);
    if (text.length <= maxChars) return out;
  }
  return {
    ok: true,
    backend: out.backend,
    goal: out.goal,
    summary: out.summary ? limitInline(out.summary, 100) : undefined,
    relevantFiles: out.relevantFiles.slice(0, 3).map((item) => ({ path: item.path, score: item.score })),
    confidence: out.confidence,
    risks: out.risks.slice(0, 2),
    limits: out.limits
  };
}

function extractTerms(text) {
  return [...new Set(String(text || "")
    .toLowerCase()
    .match(/[a-z0-9_.$-]{3,}/g) || [])]
    .filter((term) => !STOP_WORDS.has(term))
    .slice(0, 20);
}

function splitScope(value) {
  return String(value || "")
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function countOccurrences(text, term) {
  let count = 0;
  let index = text.indexOf(term);
  while (index !== -1 && count < 20) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

function normalizeMaxChars(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_MAX_CHARS;
  return Math.min(6000, Math.max(500, Math.round(number)));
}

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/");
}

function limitInline(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function normalizeBackend(value) {
  const backend = String(value || "auto").trim().toLowerCase();
  if (["local", "local-static", "static"].includes(backend)) return "local-static";
  if (["codegraph", "cg"].includes(backend)) return "codegraph";
  return "auto";
}

function shouldPreferLocalStatic({ goal, scope }) {
  const text = `${goal || ""} ${scope || ""}`.toLowerCase();
  if (DOC_CONTEXT_PATTERN.test(text)) return true;
  return splitScope(scope).some((item) => {
    const hint = item.toLowerCase().replace(/\\/g, "/");
    return hint.startsWith("docs/")
      || hint.endsWith(".md")
      || hint.endsWith(".mdx")
      || hint.endsWith(".txt")
      || hint.endsWith(".rst");
  });
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function pendingChangeCount(status) {
  const pending = status?.pendingChanges;
  if (!pending || typeof pending !== "object") return 0;
  return numericOrZero(pending.added) + numericOrZero(pending.modified) + numericOrZero(pending.removed);
}

function numericOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
