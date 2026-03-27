#!/usr/bin/env node
import { daemonMain } from "./daemon.js";

daemonMain().catch((e) => {
  process.stderr.write(`[LarkDaemon] 启动失败: ${e}\n`);
  process.exit(1);
});
