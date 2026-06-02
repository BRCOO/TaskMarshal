#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const cases = [
  {
    name: "small local",
    args: ["route", "--goal", "tiny docs edit", "--scope", "README.md", "--risk", "low", "--files", "1"],
    expect: (data) => data.route === "local"
  },
  {
    name: "multi file flash",
    args: ["route", "--goal", "refactor provider adapter", "--scope", "a.js,b.js,c.js", "--risk", "medium", "--files", "3"],
    expect: (data) => data.route === "flash"
  },
  {
    name: "security pro",
    args: ["route", "--goal", "security auth migration review", "--scope", "auth.js", "--risk", "high", "--files", "1"],
    expect: (data) => data.route === "pro"
  }
];

const results = [];
for (const test of cases) {
  const result = run(test.args);
  const passed = result.ok && test.expect(result.data);
  results.push({ name: test.name, passed, data: result.data, error: result.error });
}

const task = run(["task-create", "--goal", "eval token firewall", "--scope", "taskmarshalctl.js", "--risk", "low", "--route", "flash", "--steps", "plan;verify"]);
let gatePassed = false;
if (task.ok && task.data.taskId) {
  run(["checkpoint", "--id", task.data.taskId, "--step", "s1", "--note", "eval"]);
  run(["checkpoint", "--id", task.data.taskId, "--step", "s2", "--note", "eval"]);
  run(["verify", "--id", task.data.taskId, "--status", "pass", "--command", "eval"]);
  const done = run(["finalize", "--id", task.data.taskId]);
  gatePassed = done.ok && done.data.done === true && typeof done.data.taskKey === "string";
  results.push({ name: "task gate finalizes", passed: gatePassed, data: done.data, error: done.error });
} else {
  results.push({ name: "task gate finalizes", passed: false, data: task.data, error: task.error });
}

const ok = results.every((item) => item.passed);
console.log(JSON.stringify({ ok, results }, null, 2));
if (!ok) process.exitCode = 1;

function run(args) {
  const child = spawnSync(process.execPath, ["taskmarshalctl.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  let data = null;
  try {
    data = child.stdout ? JSON.parse(child.stdout) : null;
  } catch (err) {
    return { ok: false, data: null, error: err.message };
  }
  return {
    ok: child.status === 0 && data?.ok !== false,
    data,
    error: child.stderr || data?.error || null
  };
}
