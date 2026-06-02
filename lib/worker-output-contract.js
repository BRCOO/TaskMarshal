export const WORKER_OUTPUT_FIELDS = ["changedFiles", "commands", "verification", "risks", "next"];
export const DEFAULT_WORKER_OUTPUT_MAX_CHARS = 1200;
export const MIN_WORKER_OUTPUT_MAX_CHARS = 400;
export const MAX_WORKER_OUTPUT_MAX_CHARS = 4000;

export function resolveWorkerOutputContract(input = {}, env = process.env) {
  if (input?.enabled === false) return { enabled: false };
  const envToggle = env.TASKMARSHAL_WORKER_OUTPUT_CONTRACT ?? env.TASKMARSHAL_OUTPUT_CONTRACT;
  if (isFalseEnv(envToggle)) return { enabled: false };
  const envMaxChars = env.TASKMARSHAL_WORKER_OUTPUT_MAX_CHARS ?? env.TASKMARSHAL_OUTPUT_MAX_CHARS;
  return {
    enabled: true,
    maxChars: parseWorkerOutputMaxChars(input?.maxChars ?? envMaxChars),
    fields: [...WORKER_OUTPUT_FIELDS]
  };
}

export function parseWorkerOutputMaxChars(value) {
  const n = value === undefined || value === null || value === ""
    ? DEFAULT_WORKER_OUTPUT_MAX_CHARS
    : Number(value);
  if (!Number.isInteger(n) || n < MIN_WORKER_OUTPUT_MAX_CHARS || n > MAX_WORKER_OUTPUT_MAX_CHARS) {
    throw new Error(`worker output max chars must be an integer between ${MIN_WORKER_OUTPUT_MAX_CHARS} and ${MAX_WORKER_OUTPUT_MAX_CHARS}`);
  }
  return n;
}

export function prepareWorkerPrompt(text, outputContract = resolveWorkerOutputContract()) {
  if (!outputContract?.enabled || hasWorkerOutputContract(text)) {
    return { userText: text, workerText: text, outputContract: { ...outputContract, injected: false } };
  }
  return {
    userText: text,
    workerText: [
      "Output contract:",
      `Final response <= ${outputContract.maxChars} chars.`,
      `Use only these top-level labels: ${outputContract.fields.join(", ")}.`,
      "No full logs, full diffs, long explanations, or extra sections.",
      "",
      "Task:",
      text
    ].join("\n"),
    outputContract: { ...outputContract, injected: true }
  };
}

export function hasWorkerOutputContract(text) {
  const value = String(text || "").toLowerCase();
  return value.includes("output contract:") || WORKER_OUTPUT_FIELDS.every((field) => value.includes(field.toLowerCase()));
}

export function enforceWorkerOutputContract(text, outputContract) {
  const rawText = String(text || "").trim();
  const rawChars = rawText.length;
  if (!outputContract?.enabled) return { text: rawText, rawChars, truncated: false, maxChars: null };
  const maxChars = outputContract.maxChars;
  if (rawChars <= maxChars) return { text: rawText, rawChars, truncated: false, maxChars };
  const marker = "\n[TaskMarshal truncated worker output; request logs only if needed]";
  const bodyMax = Math.max(0, maxChars - marker.length);
  let body = rawText.slice(0, bodyMax);
  const newline = body.lastIndexOf("\n");
  if (newline >= Math.floor(bodyMax * 0.65)) body = body.slice(0, newline).trimEnd();
  return {
    text: `${body.trimEnd()}${marker}`,
    rawChars,
    truncated: true,
    maxChars
  };
}

export function outputContractRecord(outputContract, enforced) {
  if (!outputContract?.enabled) return { enabled: false };
  return {
    enabled: true,
    maxChars: outputContract.maxChars,
    fields: outputContract.fields,
    injected: Boolean(outputContract.injected),
    rawChars: enforced.rawChars,
    finalChars: enforced.text.length,
    truncated: Boolean(enforced.truncated)
  };
}

export function contractPromptRecord(outputContract) {
  if (!outputContract?.enabled) return { enabled: false };
  return {
    enabled: true,
    maxChars: outputContract.maxChars,
    fields: outputContract.fields,
    injected: Boolean(outputContract.injected)
  };
}

export function isFalseEnv(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}
