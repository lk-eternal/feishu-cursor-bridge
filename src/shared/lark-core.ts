import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as Lark from "@larksuiteoapi/node-sdk";

// ── 代理环境变量清理 ─────────────────────────────────────

const PROXY_KEYS = [
  "HTTP_PROXY", "http_proxy",
  "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy",
  "NODE_USE_ENV_PROXY",
];

export function stripProxyEnv(): string[] {
  const removed: string[] = [];
  for (const key of PROXY_KEYS) {
    if (process.env[key]) {
      removed.push(key);
      delete process.env[key];
    }
  }
  return removed;
}

// ── 时间戳 ───────────────────────────────────────────────

export function localTimestamp(): string {
  const d = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

// ── Lark Client 工厂 ────────────────────────────────────

export function createLarkClient(appId: string, appSecret: string): Lark.Client {
  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.error,
  });
}

// ── 发送目标解析 ─────────────────────────────────────────

export interface SendTarget {
  receiveIdType: string;
  receiveId: string;
}

export interface LarkSenderOptions {
  client: Lark.Client;
  receiveId: string;
  receiveIdType: string;
  messagePrefix: string;
  log: (level: string, ...args: unknown[]) => void;
}

export class LarkSender {
  private client: Lark.Client;
  private messagePrefix: string;
  private log: (level: string, ...args: unknown[]) => void;

  resolvedTarget: SendTarget | null = null;
  autoOpenId = "";

  constructor(opts: LarkSenderOptions) {
    this.client = opts.client;
    this.messagePrefix = opts.messagePrefix;
    this.log = opts.log;
    this.initTarget(opts.receiveId, opts.receiveIdType);
  }

  private initTarget(receiveId: string, receiveIdType: string): void {
    if (!receiveId) return;
    const idType = receiveIdType || "auto";
    if (["open_id", "user_id", "union_id", "chat_id"].includes(idType)) {
      this.resolvedTarget = { receiveIdType: idType, receiveId };
    }
  }

  async resolveTarget(receiveId: string, receiveIdType: string): Promise<void> {
    if (!receiveId) {
      this.log("INFO", "未配置 LARK_RECEIVE_ID，将从首条消息自动获取");
      return;
    }
    const idType = receiveIdType || "auto";
    if (this.resolvedTarget) return;

    if (idType === "email" || (idType === "auto" && receiveId.includes("@"))) {
      const openId = await this.resolveEmailToOpenId(receiveId);
      if (openId) { this.resolvedTarget = { receiveIdType: "open_id", receiveId: openId }; return; }
    }
    if (idType === "mobile" || (idType === "auto" && /^\+?\d{7,}$/.test(receiveId))) {
      const openId = await this.resolveMobileToOpenId(receiveId);
      if (openId) { this.resolvedTarget = { receiveIdType: "open_id", receiveId: openId }; return; }
    }
    this.resolvedTarget = { receiveIdType: "open_id", receiveId };
  }

  getTarget(): SendTarget | null {
    if (this.resolvedTarget) return this.resolvedTarget;
    if (this.autoOpenId) return { receiveIdType: "open_id", receiveId: this.autoOpenId };
    return null;
  }

  async resolveEmailToOpenId(email: string): Promise<string | null> {
    try {
      const res = await this.client.contact.user.batchGetId({
        params: { user_id_type: "open_id" }, data: { emails: [email] },
      });
      const users = res.data?.user_list;
      if (users && users.length > 0 && users[0].user_id) {
        this.log("INFO", `邮箱 ${email} → open_id: ${users[0].user_id}`);
        return users[0].user_id;
      }
      return null;
    } catch (e) { this.log("ERROR", "邮箱解析失败:", e); return null; }
  }

  async resolveMobileToOpenId(mobile: string): Promise<string | null> {
    try {
      const res = await this.client.contact.user.batchGetId({
        params: { user_id_type: "open_id" }, data: { mobiles: [mobile] },
      });
      const users = res.data?.user_list;
      if (users && users.length > 0 && users[0].user_id) {
        this.log("INFO", `手机号 ${mobile} → open_id: ${users[0].user_id}`);
        return users[0].user_id;
      }
      return null;
    } catch (e) { this.log("ERROR", "手机号解析失败:", e); return null; }
  }

  async replyMessage(messageId: string, text: string): Promise<void> {
    try {
      const res = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text: `${this.messagePrefix}${text}` }), msg_type: "text" },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) this.log("INFO", `飞书回复已发送(${text.length}字)`);
      else this.log("ERROR", `飞书回复失败: code=${(res as any).code}, msg=${(res as any).msg}`);
    } catch (e: any) { this.log("ERROR", `飞书回复异常: ${e?.message ?? e}`); }
  }

  async sendMessage(text: string, replyMessageId?: string): Promise<void> {
    if (replyMessageId) { await this.replyMessage(replyMessageId, text); return; }
    const target = this.getTarget();
    if (!target) { this.log("WARN", "无发送目标"); return; }
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: target.receiveIdType as any },
        data: { receive_id: target.receiveId, content: JSON.stringify({ text: `${this.messagePrefix}${text}` }), msg_type: "text" },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) this.log("INFO", `飞书消息已发送(${text.length}字)`);
      else this.log("ERROR", `飞书发送失败: code=${(res as any).code}, msg=${(res as any).msg}`);
    } catch (e: any) { this.log("ERROR", `飞书发送异常: ${e?.message ?? e}`); }
  }

  async sendMessageToChat(chatId: string, text: string): Promise<void> {
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" as any },
        data: { receive_id: chatId, content: JSON.stringify({ text: `${this.messagePrefix}${text}` }), msg_type: "text" },
      });
      if ((res as any).code === 0 || (res as any).code === undefined) this.log("INFO", `飞书消息已发送到会话 ${chatId}(${text.length}字)`);
      else this.log("ERROR", `飞书发送失败: code=${(res as any).code}, msg=${(res as any).msg}`);
    } catch (e: any) { this.log("ERROR", `飞书发送异常: ${e?.message ?? e}`); }
  }

  async sendImage(imagePath: string, replyMessageId?: string, chatId?: string): Promise<void> {
    const absPath = path.resolve(imagePath);
    if (!fs.existsSync(absPath)) { this.log("ERROR", `图片不存在: ${absPath}`); return; }
    try {
      const uploadRes: any = await this.client.im.image.create({ data: { image_type: "message", image: fs.createReadStream(absPath) } });
      const imageKey = uploadRes?.data?.image_key ?? uploadRes?.image_key;
      if (!imageKey) { this.log("ERROR", `图片上传失败`); return; }
      const content = JSON.stringify({ image_key: imageKey });
      if (replyMessageId) {
        await this.client.im.message.reply({ path: { message_id: replyMessageId }, data: { content, msg_type: "image" } });
      } else if (chatId) {
        await this.client.im.message.create({ params: { receive_id_type: "chat_id" as any }, data: { receive_id: chatId, content, msg_type: "image" } });
      } else {
        const target = this.getTarget();
        if (!target) { this.log("WARN", "无发送目标"); return; }
        await this.client.im.message.create({ params: { receive_id_type: target.receiveIdType as any }, data: { receive_id: target.receiveId, content, msg_type: "image" } });
      }
      this.log("INFO", "图片已发送");
    } catch (e: any) { this.log("ERROR", `发送图片异常: ${e?.message ?? e}`); }
  }

  async sendFile(filePath: string, replyMessageId?: string, chatId?: string): Promise<void> {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) { this.log("ERROR", `文件不存在: ${absPath}`); return; }
    try {
      const fileName = path.basename(absPath);
      const uploadRes: any = await this.client.im.file.create({ data: { file_type: "stream", file_name: fileName, file: fs.createReadStream(absPath) } });
      const fileKey = uploadRes?.data?.file_key ?? uploadRes?.file_key;
      if (!fileKey) { this.log("ERROR", `文件上传失败`); return; }
      const content = JSON.stringify({ file_key: fileKey, file_name: fileName });
      if (replyMessageId) {
        await this.client.im.message.reply({ path: { message_id: replyMessageId }, data: { content, msg_type: "file" } });
      } else if (chatId) {
        await this.client.im.message.create({ params: { receive_id_type: "chat_id" as any }, data: { receive_id: chatId, content, msg_type: "file" } });
      } else {
        const target = this.getTarget();
        if (!target) { this.log("WARN", "无发送目标"); return; }
        await this.client.im.message.create({ params: { receive_id_type: target.receiveIdType as any }, data: { receive_id: target.receiveId, content, msg_type: "file" } });
      }
      this.log("INFO", `文件已发送: ${fileName}`);
    } catch (e: any) { this.log("ERROR", `发送文件异常: ${e?.message ?? e}`); }
  }

  // ── 图片下载 ───────────────────────────────────────────

  private static readonly IMAGE_DIR = path.join(os.tmpdir(), "lark-bridge-images");

  async downloadImage(messageId: string, imageKey: string): Promise<string | null> {
    try {
      if (!fs.existsSync(LarkSender.IMAGE_DIR)) fs.mkdirSync(LarkSender.IMAGE_DIR, { recursive: true });
      const resp: any = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey }, params: { type: "image" },
      });
      const filePath = path.join(LarkSender.IMAGE_DIR, `${imageKey}.png`);
      if (resp && typeof resp.pipe === "function") {
        const ws = fs.createWriteStream(filePath);
        await new Promise<void>((resolve, reject) => { resp.pipe(ws); ws.on("finish", resolve); ws.on("error", reject); });
        return filePath;
      }
      if (resp?.writeFile) { await resp.writeFile(filePath); return filePath; }
      return null;
    } catch (e: any) { this.log("ERROR", `下载图片异常: ${e?.message ?? e}`); return null; }
  }

  // ── 消息解析 & 处理 ───────────────────────────────────

  static parseMessageContent(messageId: string, messageType: string, content: string): ParsedMessage {
    const result: ParsedMessage = { text: "", imageKeys: [] };
    try {
      const parsed = JSON.parse(content);
      switch (messageType) {
        case "text": result.text = parsed.text ?? content; break;
        case "image":
          if (parsed.image_key) { result.imageKeys.push({ messageId, imageKey: parsed.image_key }); result.text = "[图片]"; }
          break;
        case "post": {
          const parts: string[] = [];
          if (parsed.title) parts.push(parsed.title);
          for (const line of (parsed.content ?? []) as any[][]) {
            for (const el of line) {
              if (el.tag === "text" && el.text) parts.push(el.text);
              else if (el.tag === "img" && el.image_key) { result.imageKeys.push({ messageId, imageKey: el.image_key }); parts.push("[图片]"); }
              else if (el.tag === "a" && el.text) parts.push(el.text);
            }
          }
          result.text = parts.join(""); break;
        }
        default: result.text = parsed.text ?? content;
      }
    } catch { result.text = content; }
    return result;
  }

  async processIncomingMessage(messageId: string, messageType: string, content: string): Promise<string> {
    const parsed = LarkSender.parseMessageContent(messageId, messageType, content);
    const parts: string[] = [];
    if (parsed.text) parts.push(parsed.text);
    for (const img of parsed.imageKeys) {
      const localPath = await this.downloadImage(img.messageId, img.imageKey);
      parts.push(localPath ? `[图片已保存: ${localPath}]` : `[图片下载失败: ${img.imageKey}]`);
    }
    return parts.join("\n");
  }

  // ── WebSocket 连接 ────────────────────────────────────

  startConnection(
    appId: string,
    appSecret: string,
    encryptKey: string,
    onMessage: (event: LarkMessageEvent) => void,
  ): void {
    const eventDispatcher = new Lark.EventDispatcher(encryptKey ? { encryptKey } : {}).register({
      "im.message.receive_v1": (data) => {
        try {
          const msg = (data as any)?.message;
          const senderObj = (data as any)?.sender;
          const messageId: string = msg?.message_id ?? "";
          const chatId: string = msg?.chat_id ?? "";
          const chatType: string = msg?.chat_type ?? "p2p";
          const rawContent: string = msg?.content ?? "";
          const messageType: string = msg?.message_type ?? "text";
          let text = rawContent;
          try { text = JSON.parse(rawContent)?.text ?? rawContent; } catch { /* use raw */ }
          const senderOpenId = senderObj?.sender_id?.open_id;
          const mentions: LarkMention[] = (msg?.mentions ?? []).map((m: any) => ({ key: m.key ?? "", id: m.id?.open_id ?? "", name: m.name ?? "" }));
          onMessage({ text, messageId, chatId, chatType, messageType, rawContent, senderOpenId, mentions });
        } catch (e: any) {
          this.log("ERROR", `事件处理异常: ${e?.message ?? e}`);
        }
      },
    });
    const wsClient = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error });
    wsClient.start({ eventDispatcher })
      .then(() => this.log("INFO", "飞书 WebSocket 连接建立成功"))
      .catch((e: any) => this.log("ERROR", `飞书 WebSocket 连接失败: ${e?.message ?? e}`));
  }
}

// ── 类型导出 ──────────────────────────────────────────────

export interface ParsedMessage {
  text: string;
  imageKeys: { messageId: string; imageKey: string }[];
}

export interface LarkMention {
  key: string;
  id: string;
  name: string;
}

export interface LarkMessageEvent {
  text: string;
  messageId: string;
  chatId: string;
  chatType: string;
  messageType: string;
  rawContent: string;
  senderOpenId?: string;
  mentions: LarkMention[];
}
