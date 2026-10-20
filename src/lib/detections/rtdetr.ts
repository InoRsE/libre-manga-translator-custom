import * as ort from "onnxruntime-web/all";
import { yieldToMain } from "../utils";
import { scalingImage, restoreBoundingBox, containmentNMS } from "./utils";
import { refineDetections } from "./boxes";

/**
 * RT-DETR-v2 detector wrapper for `ogkalu/comic-text-and-bubble-detector`
 * Model: `detector-v4-s_int8.onnx` (Apache-2.0, ~11.1 MB).
 * Classes: 0: bubble, 1: text_bubble, 2: text_free.
 */
const INPUT_SIZE = 640;

export async function runRtDetrDetection(
  session: ort.InferenceSession,
  imageSrc: string,
  minConfidence = 0.35,
): Promise<Bbox[]> {
  const { imageData, origWidth, origHeight } = await scalingImage(imageSrc, INPUT_SIZE);

  const plane = INPUT_SIZE * INPUT_SIZE;
  const buffer = new Float32Array(3 * plane);
  const inv255 = 1.0 / 255.0;

  await yieldToMain();
  for (let i = 0; i < plane; i++) {
    const idx = i * 4;
    buffer[i] = imageData.data[idx] * inv255;
    buffer[plane + i] = imageData.data[idx + 1] * inv255;
    buffer[plane * 2 + i] = imageData.data[idx + 2] * inv255;
  }

  await yieldToMain();
  let imageTensor: ort.Tensor | null = new ort.Tensor("float32", buffer, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  // The model rescales its predictions into the size declared here. We fed it a
  // letterboxed INPUT_SIZE square, so declare the square and undo the letterbox
  // ourselves via restoreBoundingBox — declaring origWidth/origHeight here would
  // re-apply an independent x/y stretch to boxes that already sit in letterbox space.
  const sizeArray = new BigInt64Array([BigInt(INPUT_SIZE), BigInt(INPUT_SIZE)]);
  let sizeTensor: ort.Tensor | null = new ort.Tensor("int64", sizeArray, [1, 2]);

  const inNames = session.inputNames;
  const feeds: Record<string, ort.Tensor> = {};
  feeds[inNames[0] ?? "images"] = imageTensor;
  feeds[inNames[1] ?? "orig_target_sizes"] = sizeTensor;

  let labelsTensor: ort.Tensor | null = null;
  let boxesTensor: ort.Tensor | null = null;
  let scoresTensor: ort.Tensor | null = null;
  try {
    const results = await session.run(feeds);
    await yieldToMain();
    labelsTensor = results["labels"];
    boxesTensor = results["boxes"];
    scoresTensor = results["scores"];
    const labelsData = (await labelsTensor.getData()) as BigInt64Array | Int32Array;
    const boxesData = (await boxesTensor.getData()) as Float32Array;
    const scoresData = (await scoresTensor.getData()) as Float32Array;

  const textBoxes: Bbox[] = [];
  const bubbleBoxes: Bbox[] = [];
  const count = Math.min(labelsData.length, scoresData.length);

  for (let i = 0; i < count; i++) {
    const score = scoresData[i];
    if (score < minConfidence) continue;
    const label = Number(labelsData[i]);

    const letterboxed = restoreBoundingBox(
      {
        x1: boxesData[i * 4],
        y1: boxesData[i * 4 + 1],
        x2: boxesData[i * 4 + 2],
        y2: boxesData[i * 4 + 3],
        confidence: score,
      },
      origWidth,
      origHeight,
      INPUT_SIZE,
    );

    const x1 = Math.max(0, Math.min(origWidth, letterboxed.x1));
    const y1 = Math.max(0, Math.min(origHeight, letterboxed.y1));
    const x2 = Math.max(0, Math.min(origWidth, letterboxed.x2));
    const y2 = Math.max(0, Math.min(origHeight, letterboxed.y2));
    if (x2 - x1 < 4 || y2 - y1 < 4) continue;

    const box: Bbox = { x1, y1, x2, y2, confidence: score };
    if (label === 1 || label === 2) {
      textBoxes.push(box);
    } else if (label === 0) {
      bubbleBoxes.push(box);
    }
  }

  // If text boxes found, use them; if only bubbles found, fall back to bubbles
  const targetBoxes = textBoxes.length > 0 ? textBoxes : bubbleBoxes;
  const nms = containmentNMS(targetBoxes);
  return refineDetections(nms, origWidth, origHeight).boxes;
  } finally {
    imageTensor?.dispose?.();
    sizeTensor?.dispose?.();
    labelsTensor?.dispose?.();
    boxesTensor?.dispose?.();
    scoresTensor?.dispose?.();
  }
}
