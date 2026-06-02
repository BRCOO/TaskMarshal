import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";

const DEFAULT_MAX_CHARS = 1200;
const MAX_FILES_SCANNED = 500;
const MAX_FILE_BYTES = 80_000;
const IGNORE_DIRS = new Set([
  ".git",
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
  maxChars = DEFAULT_MAX_CHARS
} = {}) {
  const repoRoot = resolve(root);
  const budget = normalizeMaxChars(maxChars);
  const queryTerms = extractTerms(`${goal} ${scope}`);
  const scopeHints = splitScope(scope);
  const files = collectFiles(repoRoot);
  const ranked = rankFiles({ root: repoRoot, files, queryTerms, scopeHints });
  const topFiles = ranked.slice(0, 8);
  const symbols = collectSymbols(repoRoot, topFiles.slice(0, 5));
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

function confidenceFor(topFiles, scannedCount) {
  if (!topFiles.length) return "low";
  if (topFiles[0].score >= 20 && scannedCount < MAX_FILES_SCANNED) return "high";
  return "medium";
}

function compactPacket(packet, maxChars) {
  let out = packet;
  const steps = [
    () => ({ ...out, symbols: out.symbols.slice(0, 8) }),
    () => ({ ...out, relevantFiles: out.relevantFiles.slice(0, 6) }),
    () => ({ ...out, risks: out.risks.slice(0, 3), impact: out.impact.slice(0, 4) }),
    () => ({ ...out, symbols: out.symbols.slice(0, 4), relevantFiles: out.relevantFiles.slice(0, 4) }),
    () => ({ ...out, queryTerms: out.queryTerms.slice(0, 8) })
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
  return path.replace(/\\/g, "/");
}

function limitInline(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}
