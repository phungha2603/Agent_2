import { readFile } from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export type ContentPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/** Reads an image file into [label, inline_data] Gemini content parts, or [] if it can't be read. */
export async function readImageParts(label: string, filePath: string | undefined): Promise<ContentPart[]> {
  if (!filePath) return [];
  const mimeType = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
  if (!mimeType) return [];
  try {
    const buffer = await readFile(filePath);
    return [{ text: label }, { inlineData: { mimeType, data: buffer.toString("base64") } }];
  } catch {
    return [];
  }
}
