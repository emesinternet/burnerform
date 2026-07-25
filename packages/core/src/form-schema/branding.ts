import { z } from "zod";

export const FORM_IMAGE_INPUT_BYTES = 2 * 1024 * 1024;
export const FORM_IMAGE_BYTES = 32 * 1024;
export const FORM_IMAGE_SIZE = 128;

export const formImageSchema = z
  .object({
    format: z.literal("webp"),
    data: z
      .string()
      .min(1)
      .max(Math.ceil((FORM_IMAGE_BYTES * 4) / 3))
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      const bytes = decodeBase64Url(value.data);
      if (bytes.byteLength > FORM_IMAGE_BYTES || !isSafeSquareWebp(bytes))
        throw new Error("invalid form image");
    } catch {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "Form image must be a safe 128×128 WebP under 32 KB",
      });
    }
  });

export type FormImage = z.infer<typeof formImageSchema>;

function decodeBase64Url(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isSafeSquareWebp(bytes: Uint8Array) {
  if (
    bytes.byteLength < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 12) !== "WEBP" ||
    uint32(bytes, 4) + 8 !== bytes.byteLength
  )
    return false;

  let offset = 12;
  let width: number | undefined;
  let height: number | undefined;
  let imageChunks = 0;
  while (offset + 8 <= bytes.byteLength) {
    const type = ascii(bytes, offset, offset + 4);
    const length = uint32(bytes, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.byteLength) return false;
    if (!["VP8 ", "VP8L", "VP8X", "ALPH"].includes(type)) return false;

    if (type === "VP8 ") {
      if (
        length < 10 ||
        bytes[start + 3] !== 0x9d ||
        bytes[start + 4] !== 0x01 ||
        bytes[start + 5] !== 0x2a
      )
        return false;
      width = uint16(bytes, start + 6) & 0x3fff;
      height = uint16(bytes, start + 8) & 0x3fff;
      imageChunks += 1;
    } else if (type === "VP8L") {
      if (length < 5 || bytes[start] !== 0x2f) return false;
      const dimensions = uint32(bytes, start + 1);
      width = (dimensions & 0x3fff) + 1;
      height = ((dimensions >>> 14) & 0x3fff) + 1;
      imageChunks += 1;
    } else if (type === "VP8X") {
      if (length !== 10 || (bytes[start] & ~0x10) !== 0) return false;
      width = uint24(bytes, start + 4) + 1;
      height = uint24(bytes, start + 7) + 1;
    }
    offset = end + (length % 2);
  }

  return (
    offset === bytes.byteLength &&
    imageChunks === 1 &&
    width === FORM_IMAGE_SIZE &&
    height === FORM_IMAGE_SIZE
  );
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end));
}

function uint16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint24(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}
