import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import * as esbuild from "esbuild";
import JavaScriptObfuscator from "javascript-obfuscator";
import sharp from "sharp";
import { splitVideo, MARKER } from "./split-video.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "wwwroot");
const outputRoot = path.join(projectRoot, "dist");

const digest = value => createHash("sha256").update(value).digest("hex").slice(0, 16);
const webPath = value => value.split(path.sep).join("/");

async function filesBelow(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(path.join(directory, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

function replaceAllLiteral(source, oldValue, newValue) {
  return source.split(oldValue).join(newValue);
}

// Automatically ensure video chunks are embedded into images in wwwroot/p
const burgerVideo = path.join(sourceRoot, "BURGER.mp4");
const imagesDir = path.join(sourceRoot, "p");
if (existsSync(burgerVideo) && existsSync(imagesDir)) {
  console.log("==> Phase 1: Embedding video chunks into carrier images...");
  splitVideo({ input: burgerVideo, imagesDir });
}

console.log("==> Phase 2: Optimizing assets and creating dist directory...");
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const allFiles = await filesBelow(sourceRoot);
// Exclude HTML/config and raw MP4 video (video is distributed inside p/ images)
const assetFiles = allFiles.filter(file =>
  !["index.html", "web.config"].includes(webPath(file)) &&
  !file.toLowerCase().endsWith(".mp4")
);

const embeddedAssets = {};

for (const relative of assetFiles) {
  const sourcePath = path.join(sourceRoot, relative);
  const extension = path.extname(relative).toLowerCase();
  let contents = await readFile(sourcePath);

  // Preserve any embedded MP4 chunk payload when optimizing images with sharp
  const markerPos = contents.indexOf(MARKER);
  let trailer = null;
  if (markerPos !== -1) {
    trailer = contents.subarray(markerPos);
    contents = contents.subarray(0, markerPos);
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    contents = await sharp(contents).jpeg({ mozjpeg: true, quality: 86 }).toBuffer();
  }

  if (trailer) {
    contents = Buffer.concat([contents, trailer]);
  }

  const base64Data = contents.toString("base64");
  const relWeb = webPath(relative);
  embeddedAssets[`./${relWeb}`] = base64Data;
}

const sourceHtml = await readFile(path.join(sourceRoot, "index.html"), "utf8");
const styleMatch = sourceHtml.match(/<style>([\s\S]*?)<\/style>/i);
const scriptMatch = sourceHtml.match(/<script>([\s\S]*?)<\/script>/i);
const languageMatch = sourceHtml.match(/<html[^>]*\blang=["']([^"']+)["']/i);
const charsetMatch = sourceHtml.match(/<meta[^>]*\bcharset=["']?([^\s"'>]+)/i);
const titleMatch = sourceHtml.match(/<title>([\s\S]*?)<\/title>/i);
if (!styleMatch || !scriptMatch || !languageMatch || !charsetMatch || !titleMatch) {
  throw new Error("Expected lang, charset, title, one inline <style>, and one inline <script> in wwwroot/index.html.");
}

const minifiedCss = (await esbuild.transform(styleMatch[1], {
  loader: "css",
  minify: true
})).code.trim();

// Generate circular transparent favicon from burger-hesin.jpg
const hesinBuffer = await readFile(path.join(sourceRoot, "p", "burger-hesin.jpg"));
const hesinMarker = hesinBuffer.indexOf(MARKER);
const cleanHesin = hesinMarker !== -1 ? hesinBuffer.subarray(0, hesinMarker) : hesinBuffer;
const circleSvg = Buffer.from(
  '<svg width="64" height="64"><circle cx="32" cy="32" r="32" fill="#fff"/></svg>'
);
const faviconPng = await sharp(cleanHesin)
  .resize(64, 64, { fit: "cover" })
  .composite([{ input: circleSvg, blend: "dest-in" }])
  .png()
  .toBuffer();
const faviconDataUrl = `data:image/png;base64,${faviconPng.toString("base64")}`;

const documentBootstrap = `
document.documentElement.lang=${JSON.stringify(languageMatch[1])};
const __charset=document.createElement("meta");
__charset.setAttribute("charset",${JSON.stringify(charsetMatch[1])});
document.head.appendChild(__charset);
document.title=${JSON.stringify(titleMatch[1].trim())};
const __fav=document.querySelector("link[rel*='icon']")||document.createElement("link");
__fav.rel="icon";
__fav.type="image/png";
__fav.href=${JSON.stringify(faviconDataUrl)};
if(!__fav.parentNode)document.head.appendChild(__fav);
const __style=document.createElement("style");
__style.textContent=${JSON.stringify(minifiedCss)};
document.head.appendChild(__style);
`;

const compressedAssets = zlib.gzipSync(Buffer.from(JSON.stringify(embeddedAssets)), { level: 9 });
const assetsGzBase64 = compressedAssets.toString("base64");
const randomVarName = "_0x" + createHash("sha256").update(assetsGzBase64).digest("hex").slice(0, 8);

let runtimeSource = documentBootstrap + scriptMatch[1];
runtimeSource = replaceAllLiteral(runtimeSource, "__BUNDLE_PAYLOAD__", randomVarName);

console.log("==> Phase 3: Bundling runtime with esbuild...");
const bundled = await esbuild.build({
  stdin: { contents: runtimeSource, loader: "js", sourcefile: "runtime.js" },
  bundle: true,
  write: false,
  minify: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: "none",
  sourcemap: false,
  target: ["es2020"],
  platform: "browser",
  charset: "utf8"
});

console.log("==> Phase 4: Obfuscating JavaScript payload...");
const javascript = JavaScriptObfuscator.obfuscate(bundled.outputFiles[0].text, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  identifierNamesGenerator: "hexadecimal",
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 6,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.75,
  stringArrayEncoding: ["base64"],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.75,
  target: "browser",
  transformObjectKeys: true,
  unicodeEscapeSequence: false
}).getObfuscatedCode();

// True GIF89a / JavaScript polyglot header
// Image header: width = 10799 ('/*')
// JS parser sees: GIF89a/* [binary image data] */ = 1;
const gifPolyglotHeader = Buffer.concat([
  Buffer.from("GIF89a"),
  Buffer.from([
    0x2f, 0x2a, // width = 10799 (0x2a2f = '/*')
    0x01, 0x00, // height = 1
    0x80,       // global color table flag
    0x00, 0x00, // background color, pixel aspect
    0x00, 0x00, 0x00, 
    0xff, 0xff, 0xff, 
    0x2c, 
    0x00, 0x00, 0x00, 0x00, // left, top
    0x2f, 0x2a, 
    0x01, 0x00, 0x00, 
    0x02, 0x02, 0x44, 0x01, 0x00, 
    0x3b        // GIF trailer
  ]),
  Buffer.from("*/=1;\n")
]);

const assetsBootstrap = `const ${randomVarName}=${JSON.stringify(assetsGzBase64)};`;
const finalScript = `${assetsBootstrap}\n${javascript}`;
const polyglotPayload = Buffer.concat([gifPolyglotHeader, Buffer.from(finalScript, "utf8")]);

console.log("==> Phase 5: Generating dist/favicon.ico, dist/index.html, and dist/_headers...");
// Output polyglot favicon.ico directly at root of dist
const faviconPath = path.join(outputRoot, "favicon.ico");
await writeFile(faviconPath, polyglotPayload);

const bootstrapLoader = `(()=>{const s=document.currentScript;fetch("favicon.ico",{headers:{Accept:"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"}}).then(r=>r.text()).then(t=>(0,eval)(t)).finally(()=>s?.remove())})();`;
const obfuscatedLoader = JavaScriptObfuscator.obfuscate(bootstrapLoader, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 1,
  numbersToExpressions: true,
  simplify: true,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 1
}).getObfuscatedCode();

const outputHtml =
  `<!doctype html><html><head><link rel="icon" type="image/png" href="${faviconDataUrl}"><script>${obfuscatedLoader}</script></head><body></body></html>`;
await writeFile(path.join(outputRoot, "index.html"), outputHtml);

// web.config with IIS gzip and static caching rules
const webConfig = path.join(sourceRoot, "web.config");
if (existsSync(webConfig)) {
  const config = await readFile(webConfig, "utf8");
  await writeFile(path.join(outputRoot, "web.config"), config);
}

// Cloudflare Pages custom headers
const cloudflareHeaders = `/favicon.ico\n  Content-Type: image/x-icon\n  Cache-Control: public, max-age=31536000, immutable\n`;
await writeFile(path.join(outputRoot, "_headers"), cloudflareHeaders);

const diskKb = (polyglotPayload.length / 1024).toFixed(1);
const wireKb = (zlib.gzipSync(polyglotPayload, { level: 6 }).length / 1024).toFixed(1);
console.log(`Created true polyglot favicon.ico (${diskKb} KB on disk, payload variable: ${randomVarName})`);
console.log(`Estimated IIS Gzip wire transfer: ${wireKb} KB`);
