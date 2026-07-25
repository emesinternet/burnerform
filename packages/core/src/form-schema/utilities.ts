import type { FormField } from "./fields";
import { FORM_LIMITS } from "./limits";
import { parseFormSchema, type FormSchema } from "./schema";

export function generateFieldId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

export async function hashFormSchema(schema: FormSchema): Promise<string> {
  const canonical = canonicalJson(parseFormSchema(schema));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

export function isContentField(
  field: FormField,
): field is Extract<FormField, { type: "information" | "section_title" }> {
  return field.type === "information" || field.type === "section_title";
}

export function textFieldMaxLength(
  field: Extract<FormField, { type: "short_text" | "long_text" }>,
): number {
  return (
    field.maxLength ??
    (field.type === "short_text"
      ? FORM_LIMITS.maxShortTextLength
      : FORM_LIMITS.maxLongTextLength)
  );
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
