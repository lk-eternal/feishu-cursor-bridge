#!/usr/bin/env node
const _noop = () => {};
console.log = _noop;
console.info = _noop;
console.warn = _noop;
console.debug = _noop;

import("./server.js").catch((e) => {
  console.error("[LarkBridge] 启动失败:", e);
  process.exit(1);
});
