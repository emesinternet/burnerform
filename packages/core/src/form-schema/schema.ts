import { z } from "zod";
import { formImageSchema } from "./branding";
import { formFieldSchema } from "./fields";
import { FORM_LIMITS } from "./limits";

export const formSchema = z
  .object({
    version: z.literal(1),
    title: z.string().trim().min(1).max(FORM_LIMITS.maxTitleLength),
    description: z
      .string()
      .trim()
      .max(FORM_LIMITS.maxDescriptionLength)
      .optional(),
    confirmationMessage: z
      .string()
      .trim()
      .max(FORM_LIMITS.maxDescriptionLength)
      .optional(),
    formImage: formImageSchema.optional(),
    fields: z.array(formFieldSchema).min(1).max(FORM_LIMITS.maxFields),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, field] of value.fields.entries()) {
      if (seen.has(field.id)) {
        context.addIssue({
          code: "custom",
          path: ["fields", index, "id"],
          message: "Field IDs must be unique",
        });
      }
      seen.add(field.id);

      const optionGroups: Array<
        ["options" | "rows" | "columns", Array<{ id: string; label: string }>]
      > = [];
      if ("options" in field) optionGroups.push(["options", field.options]);
      if ("rows" in field) optionGroups.push(["rows", field.rows]);
      if ("columns" in field) optionGroups.push(["columns", field.columns]);
      for (const [property, entries] of optionGroups) {
        const optionIds = new Set<string>();
        entries.forEach((entry, optionIndex) => {
          if (optionIds.has(entry.id)) {
            context.addIssue({
              code: "custom",
              path: ["fields", index, property, optionIndex, "id"],
              message: "Option IDs must be unique within a field",
            });
          }
          optionIds.add(entry.id);
        });
      }

      if (field.type !== "multiple_choice") continue;
      if (
        field.minSelections !== undefined &&
        field.maxSelections !== undefined &&
        field.minSelections > field.maxSelections
      ) {
        context.addIssue({
          code: "custom",
          path: ["fields", index, "minSelections"],
          message: "Minimum selections must not exceed maximum selections",
        });
      }
      const available = Math.min(
        FORM_LIMITS.maxOptions,
        field.options.length + (field.allowOther ? 1 : 0),
      );
      if (
        field.minSelections !== undefined &&
        field.minSelections > available
      ) {
        context.addIssue({
          code: "custom",
          path: ["fields", index, "minSelections"],
          message: "Minimum selections exceed the available choices",
        });
      }
      if (
        field.maxSelections !== undefined &&
        field.maxSelections > available
      ) {
        context.addIssue({
          code: "custom",
          path: ["fields", index, "maxSelections"],
          message: "Maximum selections exceed the available choices",
        });
      }
    }

    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      FORM_LIMITS.maxSchemaBytes
    ) {
      context.addIssue({
        code: "custom",
        message: "Form schema exceeds the byte limit",
      });
    }
  });

export type FormSchema = z.infer<typeof formSchema>;

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

export function assertSafeObjectGraph(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("Cyclic input is not allowed");
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (forbiddenKeys.has(key)) throw new Error(`Forbidden property: ${key}`);
    assertSafeObjectGraph((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
}

export function parseFormSchema(input: unknown): FormSchema {
  assertSafeObjectGraph(input);
  return formSchema.parse(input);
}
