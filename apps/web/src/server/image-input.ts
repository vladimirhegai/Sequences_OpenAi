import type { ImageInputV1 } from "../shared";
import { ApiProblem } from "./errors";

export const MAX_IMAGE_INPUT_BYTES = 15 * 1_024 * 1_024;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 100_000_000;

type ImageKind = Pick<ImageInputV1, "mediaType" | "width" | "height"> & {
  extension: "png" | "jpg" | "webp";
};

export async function readBoundedImageBody(request: Request): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ApiProblem(400, "invalid_content_length", "Image Content-Length is invalid");
    }
    if (length > MAX_IMAGE_INPUT_BYTES) {
      throw new ApiProblem(413, "image_input_too_large", "Images cannot exceed 15 MiB");
    }
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_INPUT_BYTES) {
      await reader.cancel();
      throw new ApiProblem(413, "image_input_too_large", "Images cannot exceed 15 MiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function inspectImageInput(bytes: Uint8Array, declaredMediaType: string | null): ImageKind {
  if (bytes.byteLength === 0) {
    throw new ApiProblem(422, "empty_image_input", "The attached image is empty");
  }
  if (bytes.byteLength > MAX_IMAGE_INPUT_BYTES) {
    throw new ApiProblem(413, "image_input_too_large", "Images cannot exceed 15 MiB");
  }
  const image = inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
  if (!image) {
    throw new ApiProblem(
      422,
      "unsupported_image_input",
      "Attach a valid PNG, JPEG, or WebP screenshot",
    );
  }
  const normalized = declaredMediaType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized && normalized !== image.mediaType) {
    throw new ApiProblem(
      422,
      "image_type_mismatch",
      "The image bytes do not match the declared file type",
    );
  }
  if (
    image.width > MAX_IMAGE_DIMENSION ||
    image.height > MAX_IMAGE_DIMENSION ||
    image.width * image.height > MAX_IMAGE_PIXELS
  ) {
    throw new ApiProblem(
      422,
      "image_dimensions_too_large",
      "Images cannot exceed 16384 px on either side or 100 megapixels",
    );
  }
  return image;
}

function inspectPng(bytes: Uint8Array): ImageKind | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return dimensions("image/png", "png", width, height);
}

function inspectJpeg(bytes: Uint8Array): ImageKind | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) break;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && length >= 7) {
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      return dimensions("image/jpeg", "jpg", width, height);
    }
    offset += length;
  }
  return null;
}

function inspectWebp(bytes: Uint8Array): ImageKind | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") {
    return null;
  }
  const kind = ascii(bytes, 12, 16);
  if (kind === "VP8X") {
    return dimensions("image/webp", "webp", 1 + uint24(bytes, 24), 1 + uint24(bytes, 27));
  }
  if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    const width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
    const height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
    return dimensions("image/webp", "webp", width, height);
  }
  if (kind === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
    const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
    return dimensions("image/webp", "webp", 1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
  }
  return null;
}

function dimensions(
  mediaType: ImageKind["mediaType"],
  extension: ImageKind["extension"],
  width: number,
  height: number,
): ImageKind | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { mediaType, extension, width, height };
}

function uint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}
