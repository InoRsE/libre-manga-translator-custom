import fs from "fs";
import path from "path";

async function downloadModel() {
  const modelDir = path.resolve(process.cwd(), "models");
  if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });
  const modelPath = path.join(modelDir, "detector-v4-s_int8.onnx");

  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 10_000_000) {
    console.log("Model already exists at:", modelPath);
    return;
  }

  console.log("Downloading detector-v4-s_int8.onnx from HuggingFace (11MB)...");
  const url = "https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector-v4-s_int8.onnx";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
  const buf = await res.arrayBuffer();
  fs.writeFileSync(modelPath, Buffer.from(buf));
  console.log("Downloaded successfully! Size:", fs.statSync(modelPath).size);
}

downloadModel().catch(console.error);

