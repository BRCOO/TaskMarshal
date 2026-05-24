import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class AcpClient {
  constructor({ command = "reasonix", args = [], cwd = process.cwd(), env = process.env } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.handlers = new Map();
    this.stderr = "";
    this.proc = null;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000);
    });
    this.proc.on("exit", (code, signal) => {
      const err = new Error(`ACP process exited: code=${code} signal=${signal}`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.#handleLine(line));
  }

  async initialize({ clientName = "reasonixctl", clientVersion = "0.1.0" } = {}) {
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: clientName, version: clientVersion }
    });
  }

  async newSession({ cwd } = {}) {
    return this.request("session/new", cwd ? { cwd } : {});
  }

  async prompt({ sessionId, text }) {
    return this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }]
    });
  }

  cancel(sessionId) {
    this.notify("session/cancel", { sessionId });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.#write(msg);
    });
  }

  respond(id, result) {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  notify(method, params = {}) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  close() {
    if (!this.proc) return;
    this.proc.stdin.end();
    if (!this.proc.killed) this.proc.kill();
  }

  #write(msg) {
    if (!this.proc?.stdin.writable) throw new Error("ACP process stdin is not writable.");
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.notifications.push({ method: "$malformed", params: { line } });
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || `ACP error for ${pending.method}`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      this.notifications.push({ method: msg.method, params: msg.params });
      const handler = this.handlers.get(msg.method);
      if (handler) {
        Promise.resolve(handler(msg.params, msg)).then((result) => {
          if (msg.id !== undefined) this.respond(msg.id, result ?? {});
        }).catch((err) => {
          if (msg.id !== undefined) {
            this.#write({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: err.message || String(err) }
            });
          }
        });
      } else if (msg.id !== undefined) {
        this.respond(msg.id, {});
      }
    }
  }
}

export function compactEvent(notification) {
  const { method, params } = notification;
  if (method !== "session/update") return notification;
  const update = params?.update ?? {};
  if (update.sessionUpdate === "agent_message_chunk") {
    return {
      method,
      sessionId: params.sessionId,
      type: update.sessionUpdate,
      text: update.content?.text ?? ""
    };
  }
  return {
    method,
    sessionId: params?.sessionId,
    type: update.sessionUpdate,
    update
  };
}
