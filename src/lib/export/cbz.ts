/**
 * Pure TypeScript CBZ (Comic Book Zip) Archive Generator
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

/**
 * Creates a valid, standard-compliant .CBZ (ZIP) Blob from in-memory file entries.
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

  // Current DOS date/time: 2026-10-30 10:00:00
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

  // Assemble full archive
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
  return new Blob([archiveBytes as any], { type: "application/vnd.comicbook+zip" });
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

  // Normalize chapter number: pad integers to 3 digits (e.g. 54 -> 054, 1 -> 001)
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
