/**
 * Pure TypeScript CBZ (Comic Book Zip) Archive Generator & Independent Reader
 * Zero runtime dependencies, high performance Method 0 (Store).
 */

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

export function computeCrc32(data: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

export interface CbzFileEntry {
  name: string;
  data: Uint8Array;
}

export interface ImageTypeInfo {
  mime: string;
  ext: string;
}

/**
 * Inspects binary magic numbers to verify image format integrity.
 * Returns { mime, ext } if valid, or null if the bytes do not represent a valid image.
 */
export function detectImageSignature(bytes: Uint8Array): ImageTypeInfo | null {
  if (!bytes || bytes.length < 4) return null;

  // PNG: 89 50 4E 47 (\x89PNG)
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { mime: "image/png", ext: "png" };
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  // WebP: RIFF .... WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  // GIF: GIF8
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return { mime: "image/gif", ext: "gif" };
  }

  return null;
}

/**
 * Creates a valid, standard-compliant .CBZ (ZIP) archive from in-memory file entries.
 * Uses Compression Method 0 (Store), which is optimal for already compressed images
 * (JPEG, PNG, WebP) and avoids heavy WASM/CPU overhead.
 */
export function createCbzArchive(entries: CbzFileEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const fileRecords: Array<{
    nameBytes: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
    dosTime: number;
    dosDate: number;
  }> = [];

  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  let currentOffset = 0;
  const localHeaderParts: Uint8Array[] = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const crc = computeCrc32(data);
    const offset = currentOffset;

    fileRecords.push({
      nameBytes,
      data,
      crc,
      offset,
      dosTime,
      dosDate,
    });

    // Local file header: 30 bytes + name length + data length
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);

    view.setUint32(0, 0x04034b50, true); // Local file header signature
    view.setUint16(4, 20, true); // Version needed to extract (2.0)
    view.setUint16(6, 0x0800, true); // General purpose bit flag (UTF-8)
    view.setUint16(8, 0, true); // Compression method: 0 (Store)
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint32(14, crc, true); // CRC-32
    view.setUint32(18, data.length, true); // Compressed size
    view.setUint32(22, data.length, true); // Uncompressed size
    view.setUint16(26, nameBytes.length, true); // File name length
    view.setUint16(28, 0, true); // Extra field length

    header.set(nameBytes, 30);

    localHeaderParts.push(header);
    localHeaderParts.push(data);

    currentOffset += header.length + data.length;
  }

  const centralDirectoryOffset = currentOffset;
  const centralDirectoryParts: Uint8Array[] = [];

  for (const record of fileRecords) {
    // Central directory header: 46 bytes + name length
    const cdHeader = new Uint8Array(46 + record.nameBytes.length);
    const cdView = new DataView(cdHeader.buffer);

    cdView.setUint32(0, 0x02014b50, true); // Central file header signature
    cdView.setUint16(4, 20, true); // Version made by
    cdView.setUint16(6, 20, true); // Version needed to extract
    cdView.setUint16(8, 0x0800, true); // Flags (UTF-8)
    cdView.setUint16(10, 0, true); // Method: Store
    cdView.setUint16(12, record.dosTime, true);
    cdView.setUint16(14, record.dosDate, true);
    cdView.setUint32(16, record.crc, true);
    cdView.setUint32(20, record.data.length, true);
    cdView.setUint32(24, record.data.length, true);
    cdView.setUint16(28, record.nameBytes.length, true);
    cdView.setUint16(30, 0, true); // Extra field length
    cdView.setUint16(32, 0, true); // File comment length
    cdView.setUint16(34, 0, true); // Disk number start
    cdView.setUint16(36, 0, true); // Internal attributes
    cdView.setUint32(38, 0, true); // External attributes
    cdView.setUint32(42, record.offset, true); // Relative offset of local header

    cdHeader.set(record.nameBytes, 46);
    centralDirectoryParts.push(cdHeader);
    currentOffset += cdHeader.length;
  }

  const centralDirectorySize = currentOffset - centralDirectoryOffset;

  // End of Central Directory record: 22 bytes
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);

  eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
  eocdView.setUint16(4, 0, true); // Number of this disk
  eocdView.setUint16(6, 0, true); // Disk with central directory
  eocdView.setUint16(8, fileRecords.length, true); // Total records on this disk
  eocdView.setUint16(10, fileRecords.length, true); // Total records in central directory
  eocdView.setUint32(12, centralDirectorySize, true); // Size of central directory
  eocdView.setUint32(16, centralDirectoryOffset, true); // Offset of start of central directory
  eocdView.setUint16(20, 0, true); // Comment length

  const totalLength = currentOffset + eocd.length;
  const archive = new Uint8Array(totalLength);

  let writePos = 0;
  for (const part of [...localHeaderParts, ...centralDirectoryParts, eocd]) {
    archive.set(part, writePos);
    writePos += part.length;
  }

  return archive;
}

export function createCbzBlob(entries: CbzFileEntry[]): Blob {
  const archiveBytes = createCbzArchive(entries);
  return new Blob([archiveBytes as any], {
    type: "application/vnd.comicbook+zip",
  });
}

/**
 * Independent ZIP reader and integrity validator.
 * Parses and verifies central directory, local file headers, and CRC-32 checksums.
 */
export function parseZipArchive(archiveBytes: Uint8Array): {
  files: Array<{
    name: string;
    data: Uint8Array;
    crc: number;
    isValidCrc: boolean;
  }>;
} {
  const decoder = new TextDecoder();
  const view = new DataView(
    archiveBytes.buffer,
    archiveBytes.byteOffset,
    archiveBytes.byteLength,
  );

  // Find EOCD (search from back)
  let eocdOffset = -1;
  for (let i = archiveBytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error("Invalid ZIP archive: End of Central Directory signature not found");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const files: Array<{
    name: string;
    data: Uint8Array;
    crc: number;
    isValidCrc: boolean;
  }> = [];

  let currentCdPos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(currentCdPos, true) !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header signature at offset ${currentCdPos}`);
    }

    const expectedCrc = view.getUint32(currentCdPos + 16, true);
    const uncompressedSize = view.getUint32(currentCdPos + 24, true);
    const nameLength = view.getUint16(currentCdPos + 28, true);
    const extraLength = view.getUint16(currentCdPos + 30, true);
    const commentLength = view.getUint16(currentCdPos + 32, true);
    const localHeaderOffset = view.getUint32(currentCdPos + 42, true);

    const nameBytes = archiveBytes.subarray(
      currentCdPos + 46,
      currentCdPos + 46 + nameLength,
    );
    const fileName = decoder.decode(nameBytes);

    // Read local header
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error(`Invalid Local File header signature at offset ${localHeaderOffset}`);
    }
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;

    const data = archiveBytes.subarray(dataStart, dataStart + uncompressedSize);
    const computedCrc = computeCrc32(data);

    files.push({
      name: fileName,
      data,
      crc: expectedCrc,
      isValidCrc: computedCrc === expectedCrc,
    });

    currentCdPos += 46 + nameLength + extraLength + commentLength;
  }

  return { files };
}

/**
 * Sanitizes and formats a CBZ filename according to project standards:
 * e.g. series "Zipang", chapter "54", lang "TH" -> "ZIPANG_Ch054_TH.cbz"
 */
export function formatCbzFilename(
  seriesName: string,
  chapterId: string,
  targetLang = "TH",
): string {
  const cleanSeries = (seriesName || "MANGA")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .toUpperCase();

  const chNum = parseFloat(chapterId);
  const chStr = !isNaN(chNum)
    ? Number.isInteger(chNum)
      ? String(chNum).padStart(3, "0")
      : String(chNum)
    : chapterId.replace(/[^\w.-]/g, "") || "001";

  const cleanLang = (targetLang || "TH").toUpperCase();
  return `${cleanSeries}_Ch${chStr}_${cleanLang}.cbz`;
}

/**
 * Converts a base64 Data URL to a Uint8Array.
 */
export function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const commaIdx = dataUrl.indexOf(",");
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Safe, chunked binary to base64 converter avoiding call stack overflow.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  const chunkSize = 0x8000; // 32KB
  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + chunkSize, len)) as any,
    );
  }
  return btoa(binary);
}
