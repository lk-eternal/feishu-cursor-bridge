import * as fs from "node:fs";
import * as path from "node:path";

const POLL_INTERVAL_MS = 400;
const STALE_MESSAGE_MS = 5 * 60 * 1000;

let queueDir = "";

export function initFileQueue(): string {
  const appDataDir = process.env.LARK_APP_DATA_DIR;
  if (!appDataDir) throw new Error("LARK_APP_DATA_DIR 环境变量未设置");
  queueDir = path.join(appDataDir, "file-queue");
  if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });
  return queueDir;
}

export function getQueueDir(): string {
  return queueDir;
}

export function pushToFileQueue(text: string, messageId?: string, source?: string, chatId?: string, chatType?: string, senderOpenId?: string): boolean {
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
    const data = JSON.stringify({
      text, messageId: id, timestamp: ts,
      source: source || `pid-${process.pid}`,
      chatId: chatId || "", chatType: chatType || "",
      senderOpenId: senderOpenId || "",
    });
    const tmpPath = path.join(queueDir, filename + ".tmp");
    const finalPath = path.join(queueDir, filename);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, finalPath);
    return true;
  } catch {
    return false;
  }
}

export interface QueueMessage {
  text: string;
  messageId: string;
  chatId: string;
  chatType: string;
  senderOpenId: string;
}

export function claimNextMessage(filterChatId?: string): QueueMessage | null {
  if (!queueDir) return null;

  let files: string[];
  try {
    files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg")).sort();
  } catch {
    return null;
  }

  for (const file of files) {
    const srcPath = path.join(queueDir, file);

    if (filterChatId) {
      try {
        const raw = fs.readFileSync(srcPath, "utf-8");
        const parsed = JSON.parse(raw);
        if ((parsed.chatId || "") !== filterChatId) continue;
      } catch { continue; }
    }

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
      return {
        text: typeof parsed.text === "string" ? parsed.text : raw,
        messageId: parsed.messageId || "",
        chatId: parsed.chatId || "",
        chatType: parsed.chatType || "",
        senderOpenId: parsed.senderOpenId || "",
      };
    } catch {
      try { fs.unlinkSync(claimedPath); } catch { /* ignore */ }
      continue;
    }
  }
  return null;
}

export function claimNextMessageText(filterChatId?: string): string | null {
  const msg = claimNextMessage(filterChatId);
  return msg ? msg.text : null;
}

export function pollFileQueue(timeoutMs: number, intervalMs = POLL_INTERVAL_MS, filterChatId?: string): Promise<QueueMessage | null> {
  return new Promise((resolve) => {
    const immediate = claimNextMessage(filterChatId);
    if (immediate !== null) { resolve(immediate); return; }

    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const msg = claimNextMessage(filterChatId);
      if (msg !== null) { clearInterval(timer); resolve(msg); return; }
      if (Date.now() >= deadline) { clearInterval(timer); resolve(null); }
    }, intervalMs);
    timer.unref();
  });
}

export async function pollFileQueueBatch(timeoutMs: number, intervalMs = POLL_INTERVAL_MS, filterChatId?: string): Promise<QueueMessage | null> {
  const first = await pollFileQueue(timeoutMs, intervalMs, filterChatId);
  if (first === null) return null;

  const parts = [first.text];
  let extra = claimNextMessage(filterChatId);
  while (extra !== null) {
    parts.push(extra.text);
    extra = claimNextMessage(filterChatId);
  }
  return { text: parts.join("\n"), messageId: first.messageId, chatId: first.chatId, chatType: first.chatType, senderOpenId: first.senderOpenId };
}

export function pollFileQueueBatchText(timeoutMs: number, intervalMs = POLL_INTERVAL_MS, filterChatId?: string): Promise<string | null> {
  return pollFileQueueBatch(timeoutMs, intervalMs, filterChatId).then((m) => m?.text ?? null);
}

export function getQueueLength(): number {
  if (!queueDir) return 0;
  try {
    return fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg")).length;
  } catch {
    return 0;
  }
}

export function getQueueMessages(): { index: number; preview: string; chatId?: string; chatType?: string }[] {
  if (!queueDir) return [];
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg")).sort();
    return files.map((f, i) => {
      try {
        const raw = fs.readFileSync(path.join(queueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        return { index: i, preview: (parsed.text ?? "").slice(0, 200), chatId: parsed.chatId || undefined, chatType: parsed.chatType || undefined };
      } catch {
        return { index: i, preview: "(unreadable)" };
      }
    });
  } catch {
    return [];
  }
}

export function getDistinctChatIds(): { chatId: string; chatType: string }[] {
  if (!queueDir) return [];
  const map = new Map<string, string>();
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg"));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(queueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.chatId && !map.has(parsed.chatId)) {
          map.set(parsed.chatId, parsed.chatType || "p2p");
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return [...map.entries()].map(([chatId, chatType]) => ({ chatId, chatType }));
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
