import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const POLL_INTERVAL_MS = 400;
const STALE_MESSAGE_MS = 5 * 60 * 1000;

let queueDir = "";

export function initFileQueue(appId: string): string {
  const suffix = appId ? appId.slice(-8) : "default";
  queueDir = path.join(os.homedir(), ".lark-bridge-mcp", `queue-${suffix}`);
  if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });
  return queueDir;
}

export function getQueueDir(): string {
  return queueDir;
}

export function pushToFileQueue(text: string, messageId?: string, source?: string): boolean {
  if (!queueDir || !text?.trim()) return false;

  const ts = Date.now();
  const id = messageId || `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${ts}_${safeId}.qmsg`;

  if (messageId) {
    try {
      const existing = fs.readdirSync(queueDir);
      if (existing.some((f) => f.endsWith(`_${safeId}.qmsg`) || f.endsWith(`_${safeId}.claimed`))) {
        return false;
      }
    } catch { /* ignore */ }
  }

  try {
    const data = JSON.stringify({ text, messageId: id, timestamp: ts, source: source || `pid-${process.pid}` });
    const tmpPath = path.join(queueDir, filename + ".tmp");
    const finalPath = path.join(queueDir, filename);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, finalPath);
    return true;
  } catch {
    return false;
  }
}

export function claimNextMessage(): string | null {
  if (!queueDir) return null;

  let files: string[];
  try {
    files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg")).sort();
  } catch {
    return null;
  }

  for (const file of files) {
    const srcPath = path.join(queueDir, file);
    const claimedPath = srcPath.replace(/\.qmsg$/, ".claimed");
    try {
      fs.renameSync(srcPath, claimedPath);
    } catch {
      continue;
    }
    try {
      const raw = fs.readFileSync(claimedPath, "utf-8");
      fs.unlinkSync(claimedPath);
      const parsed = JSON.parse(raw);
      return typeof parsed.text === "string" ? parsed.text : raw;
    } catch {
      try { fs.unlinkSync(claimedPath); } catch { /* ignore */ }
      continue;
    }
  }
  return null;
}

export function pollFileQueue(timeoutMs: number, intervalMs = POLL_INTERVAL_MS): Promise<string | null> {
  return new Promise((resolve) => {
    const immediate = claimNextMessage();
    if (immediate !== null) { resolve(immediate); return; }

    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const msg = claimNextMessage();
      if (msg !== null) { clearInterval(timer); resolve(msg); return; }
      if (Date.now() >= deadline) { clearInterval(timer); resolve(null); }
    }, intervalMs);
    timer.unref();
  });
}

export async function pollFileQueueBatch(timeoutMs: number, intervalMs = POLL_INTERVAL_MS): Promise<string | null> {
  const first = await pollFileQueue(timeoutMs, intervalMs);
  if (first === null) return null;

  const messages = [first];
  let extra = claimNextMessage();
  while (extra !== null) {
    messages.push(extra);
    extra = claimNextMessage();
  }
  return messages.join("\n");
}

export function getQueueLength(): number {
  if (!queueDir) return 0;
  try {
    return fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg")).length;
  } catch {
    return 0;
  }
}

export function getQueueMessages(): { index: number; preview: string }[] {
  if (!queueDir) return [];
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg")).sort();
    return files.map((f, i) => {
      try {
        const raw = fs.readFileSync(path.join(queueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        return { index: i, preview: (parsed.text ?? "").slice(0, 200) };
      } catch {
        return { index: i, preview: "(unreadable)" };
      }
    });
  } catch {
    return [];
  }
}

export function cleanupStaleMessages(): void {
  if (!queueDir) return;
  const now = Date.now();
  try {
    for (const f of fs.readdirSync(queueDir)) {
      if (!f.endsWith(".claimed") && !f.endsWith(".tmp")) continue;
      const filePath = path.join(queueDir, f);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > STALE_MESSAGE_MS) fs.unlinkSync(filePath);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
