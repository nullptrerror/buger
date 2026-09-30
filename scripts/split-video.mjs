import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const defaultInput = path.join(projectRoot, "wwwroot", "BURGER.mp4");
const defaultImagesDir = path.join(projectRoot, "wwwroot", "p");

export const MARKER = Buffer.from("MP4CHUNK");

export function stripPayload(buffer) {
  const markerPos = buffer.indexOf(MARKER);
  if (markerPos !== -1) {
    return buffer.subarray(0, markerPos);
  }
  return buffer;
}

export function splitVideo({
  input = defaultInput,
  imagesDir = defaultImagesDir
} = {}) {
  if (!fs.existsSync(input)) {
    throw new Error(`Input video not found: ${input}`);
  }

  if (!fs.existsSync(imagesDir)) {
    throw new Error(`Images directory not found: ${imagesDir}`);
  }

  const imageFiles = fs
    .readdirSync(imagesDir)
    .filter(file => /\.(jpe?g|png|webp)$/i.test(file))
    .sort();

  if (imageFiles.length === 0) {
    throw new Error(`No image files found in ${imagesDir}`);
  }

  const video = fs.readFileSync(input);
  const parts = imageFiles.length;
  const chunkSize = Math.ceil(video.length / parts);
  const embeddedFiles = [];

  console.log(`Embedding ${video.length} video bytes evenly across ${parts} images in ${imagesDir}...`);

  for (let i = 0; i < parts; i++) {
    const filename = imageFiles[i];
    const imagePath = path.join(imagesDir, filename);

    // Read current image and strip any existing payload
    const rawImage = fs.readFileSync(imagePath);
    const cleanImage = stripPayload(rawImage);

    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, video.length);
    const chunk = video.subarray(start, end);

    const index = Buffer.alloc(4);
    index.writeUInt32BE(i);

    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.length);

    const carrier = Buffer.concat([
      cleanImage,
      MARKER,
      index,
      length,
      chunk
    ]);

    fs.writeFileSync(imagePath, carrier);

    embeddedFiles.push({
      filename,
      imagePath,
      originalSize: cleanImage.length,
      chunkSize: chunk.length,
      totalSize: carrier.length
    });

    console.log(
      `[${i + 1}/${parts}] ${filename}: embedded chunk ${i} (${chunk.length} bytes, total file size: ${carrier.length} bytes)`
    );
  }

  return embeddedFiles;
}

// Direct CLI execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  splitVideo();
  console.log("Embedding complete.");
}
