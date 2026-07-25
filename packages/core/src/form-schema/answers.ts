import { z } from "zod";
import type { FormField } from "./fields";
import { FORM_LIMITS } from "./limits";
import {
  assertSafeObjectGraph,
  parseFormSchema,
  type FormSchema,
} from "./schema";
import { isContentField, textFieldMaxLength } from "./utilities";

export type NormalizedAnswer = string | number | boolean | string[] | null;
export type NormalizedAnswers = Record<string, NormalizedAnswer>;
export const OTHER_CHOICE_PREFIX = "__other__:";
export const NONE_CHOICE_VALUE = "__none__";

export function normalizeAnswers(
  schemaInput: FormSchema,
  input: unknown,
): NormalizedAnswers {
  const schema = parseFormSchema(schemaInput);
  assertSafeObjectGraph(input);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Answers must be an object");
  }
  const source = input as Record<string, unknown>;
  const allowedIds = new Set(
    schema.fields
      .filter((field) => !isContentField(field))
      .map((field) => field.id),
  );
  for (const key of Object.keys(source)) {
    if (!allowedIds.has(key)) throw new Error(`Unknown answer field: ${key}`);
  }

  const result: NormalizedAnswers = Object.create(null) as NormalizedAnswers;
  for (const field of schema.fields) {
    if (isContentField(field)) continue;
    const raw = source[field.id];
    const missing =
      raw === undefined ||
      raw === null ||
      raw === "" ||
      (Array.isArray(raw) && raw.length === 0);
    if (missing) {
      if (field.required) throw new Error(`${field.label} is required`);
      result[field.id] = null;
      continue;
    }

    switch (field.type) {
      case "short_text":
      case "long_text": {
        if (typeof raw !== "string") {
          throw new Error(`${field.label} must be text`);
        }
        const value = raw.trim();
        if (value.length > textFieldMaxLength(field)) {
          throw new Error(`${field.label} is too long`);
        }
        result[field.id] = value;
        break;
      }
      case "email":
        result[field.id] = z.email().max(FORM_LIMITS.maxEmailLength).parse(raw);
        break;
      case "website": {
        const value = z.url().max(FORM_LIMITS.maxUrlLength).parse(raw);
        if (!/^https?:\/\//iu.test(value)) {
          throw new Error(`${field.label} must use http or https`);
        }
        result[field.id] = value;
        break;
      }
      case "phone": {
        const value = z
          .string()
          .max(FORM_LIMITS.maxPhoneLength)
          .regex(/^\+?[0-9().\-\s]+$/u)
          .parse(raw);
        const digitCount = value.replace(/\D/gu, "").length;
        if (digitCount < 7 || digitCount > 15) {
          throw new Error(`${field.label} must contain 7 to 15 digits`);
        }
        result[field.id] = value;
        break;
      }
      case "yes_no":
        if (typeof raw !== "boolean") {
          throw new Error(`${field.label} must be yes or no`);
        }
        result[field.id] = raw;
        break;
      case "time":
        result[field.id] = z
          .string()
          .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)
          .parse(raw);
        break;
      case "rating": {
        const value = typeof raw === "number" ? raw : Number(raw);
        if (
          !Number.isInteger(value) ||
          value < field.min ||
          value > field.max
        ) {
          throw new Error(`${field.label} is outside the allowed range`);
        }
        result[field.id] = value;
        break;
      }
      case "number": {
        const value = typeof raw === "number" ? raw : Number(raw);
        if (
          !Number.isFinite(value) ||
          (field.min !== undefined && value < field.min) ||
          (field.max !== undefined && value > field.max)
        ) {
          throw new Error(`${field.label} is outside the allowed range`);
        }
        result[field.id] = value;
        break;
      }
      case "date": {
        const value = z.iso.date().parse(raw);
        if (
          (field.min && value < field.min) ||
          (field.max && value > field.max)
        ) {
          throw new Error(`${field.label} is outside the allowed range`);
        }
        result[field.id] = value;
        break;
      }
      case "single_choice":
      case "dropdown":
        if (typeof raw !== "string" || !validChoiceValue(field, raw)) {
          throw new Error(`${field.label} contains an invalid choice`);
        }
        result[field.id] = raw;
        break;
      case "multiple_choice": {
        if (
          !Array.isArray(raw) ||
          raw.some((value) => typeof value !== "string") ||
          new Set(raw).size !== raw.length
        ) {
          throw new Error(`${field.label} contains invalid choices`);
        }
        const values = raw as string[];
        const noneSelected =
          values.length === 1 && values[0] === NONE_CHOICE_VALUE;
        if (
          values.some((value) => !validChoiceValue(field, value)) ||
          (values.includes(NONE_CHOICE_VALUE) && values.length > 1) ||
          (!noneSelected &&
            field.minSelections !== undefined &&
            values.length < field.minSelections) ||
          (!noneSelected &&
            field.maxSelections !== undefined &&
            values.length > field.maxSelections)
        ) {
          throw new Error(`${field.label} contains invalid choices`);
        }
        result[field.id] = values;
        break;
      }
      case "ranking":
        if (
          !Array.isArray(raw) ||
          raw.length !== field.options.length ||
          new Set(raw).size !== raw.length ||
          raw.some(
            (value) =>
              typeof value !== "string" ||
              !field.options.some((option) => option.id === value),
          )
        ) {
          throw new Error(`${field.label} contains an invalid ranking`);
        }
        result[field.id] = raw as string[];
        break;
      case "matrix": {
        if (
          !Array.isArray(raw) ||
          raw.some((value) => typeof value !== "string")
        ) {
          throw new Error(`${field.label} contains invalid selections`);
        }
        const pairs = raw as string[];
        if (new Set(pairs).size !== pairs.length) {
          throw new Error(`${field.label} contains duplicate selections`);
        }
        const seenRows = new Set<string>();
        for (const pair of pairs) {
          const [rowId, columnId, extra] = pair.split(":");
          if (
            extra !== undefined ||
            !field.rows.some((row) => row.id === rowId) ||
            !field.columns.some((column) => column.id === columnId) ||
            (!field.multiple && seenRows.has(rowId))
          ) {
            throw new Error(`${field.label} contains invalid selections`);
          }
          seenRows.add(rowId);
        }
        if (field.required && field.rows.some((row) => !seenRows.has(row.id))) {
          throw new Error(`${field.label} requires every row`);
        }
        result[field.id] = pairs;
        break;
      }
      case "consent":
        if (typeof raw !== "boolean" || (field.required && !raw)) {
          throw new Error(`${field.label} must be accepted`);
        }
        result[field.id] = raw;
        break;
    }
  }
  return result;
}

function validChoiceValue(
  field: Extract<
    FormField,
    { type: "single_choice" | "multiple_choice" | "dropdown" }
  >,
  value: string,
) {
  if (field.options.some((entry) => entry.id === value)) return true;
  if (field.allowNone && value === NONE_CHOICE_VALUE) return true;
  return (
    Boolean(field.allowOther) &&
    value.startsWith(OTHER_CHOICE_PREFIX) &&
    value.slice(OTHER_CHOICE_PREFIX.length).trim().length > 0 &&
    value.slice(OTHER_CHOICE_PREFIX.length).length <=
      FORM_LIMITS.maxOtherChoiceLength
  );
}
