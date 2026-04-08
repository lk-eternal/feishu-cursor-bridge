/**
 * electron-builder --dir 不会像完整 NSIS 那样写入 app-update.yml，electron-updater 会 ENOENT。
 * 与 electron-builder.yml 中 publish 保持一致。
 */
const fs = require("fs")
const path = require("path")

const PUBLISH_LINES = [
  "provider: github",
  "owner: lk-eternal",
  "repo: feishu-cursor-bridge",
  "vPrefixedTagName: true",
]

const CONTENT = `${PUBLISH_LINES.join("\r\n")}\r\n`

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context

  if (electronPlatformName === "win32") {
    const targetPath = path.join(appOutDir, "resources", "app-update.yml")
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, CONTENT, "utf8")
    return
  }

  if (electronPlatformName === "darwin") {
    let entries = []
    try {
      entries = fs.readdirSync(appOutDir)
    } catch {
      return
    }
    const appBundle = entries.find((e) => e.endsWith(".app"))
    if (!appBundle) {
      return
    }
    const targetPath = path.join(appOutDir, appBundle, "Contents", "Resources", "app-update.yml")
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, CONTENT, "utf8")
  }
}
