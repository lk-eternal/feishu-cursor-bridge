const { build } = require("esbuild");
const path = require("path");

const fs = require("fs");
const pkg = require(path.resolve(__dirname, "../package.json"));
const pkgJson = JSON.stringify(pkg);

const inlinePackageJson = {
  name: "inline-package-json",
  setup(b) {
    b.onLoad({ filter: /\.(js|ts)$/ }, async (args) => {
      let contents = fs.readFileSync(args.path, "utf8");
      if (contents.includes('("../package.json")')) {
        contents = contents.replace(
          /\w+\("\.\.\/package\.json"\)/g,
          pkgJson,
        );
        return { contents, loader: "js" };
      }
    });
  },
};

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  banner: { js: "import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);" },
  plugins: [inlinePackageJson],
};

async function main() {
  await build({
    ...common,
    entryPoints: [path.resolve(__dirname, "../dist/daemon-entry.js")],
    outfile: path.resolve(__dirname, "../dist-bundle/daemon-entry.mjs"),
  });

  console.log("✓ daemon-entry.mjs bundled to dist-bundle/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
