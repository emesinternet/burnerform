import { z } from "zod";
import { FORM_LIMITS } from "./limits";

const id = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const label = z.string().trim().min(1).max(FORM_LIMITS.maxLabelLength);
const helpText = z
  .string()
  .trim()
  .max(FORM_LIMITS.maxHelpTextLength)
  .optional();
const common = { id, label, helpText, required: z.boolean().default(false) };
const option = z
  .object({
    id,
    label: z.string().trim().min(1).max(FORM_LIMITS.maxOptionLength),
  })
  .strict();
const choiceExtensions = {
  allowOther: z.boolean().optional(),
  allowNone: z.boolean().optional(),
};

const shortText = z
  .object({
    type: z.literal("short_text"),
    ...common,
    placeholder: z.string().max(FORM_LIMITS.maxPlaceholderLength).optional(),
    maxLength: z
      .number()
      .int()
      .min(1)
      .max(FORM_LIMITS.maxShortTextLength)
      .optional(),
  })
  .strict();
const longText = z
  .object({
    type: z.literal("long_text"),
    ...common,
    placeholder: z.string().max(FORM_LIMITS.maxPlaceholderLength).optional(),
    maxLength: z
      .number()
      .int()
      .min(1)
      .max(FORM_LIMITS.maxLongTextLength)
      .optional(),
  })
  .strict();
const email = z
  .object({
    type: z.literal("email"),
    ...common,
    placeholder: z.string().max(FORM_LIMITS.maxPlaceholderLength).optional(),
  })
  .strict();
const website = z
  .object({
    type: z.literal("website"),
    ...common,
    placeholder: z.string().max(FORM_LIMITS.maxPlaceholderLength).optional(),
  })
  .strict();
const phone = z
  .object({
    type: z.literal("phone"),
    ...common,
    placeholder: z.string().max(FORM_LIMITS.maxPlaceholderLength).optional(),
  })
  .strict();
const yesNo = z.object({ type: z.literal("yes_no"), ...common }).strict();
const time = z
  .object({
    type: z.literal("time"),
    ...common,
    format: z.enum(["12", "24"]).default("12"),
  })
  .strict();
const rating = z
  .object({
    type: z.literal("rating"),
    ...common,
    min: z.number().int().min(0).max(1).default(1),
    max: z.number().int().min(2).max(10).default(5),
    display: z.enum(["scale", "stars"]).default("scale"),
    minLabel: z.string().max(FORM_LIMITS.maxOptionLength).optional(),
    maxLabel: z.string().max(FORM_LIMITS.maxOptionLength).optional(),
  })
  .strict()
  .refine((value) => value.min < value.max, {
    message: "Rating minimum must be less than maximum",
  })
  .refine((value) => value.display !== "stars" || value.min === 1, {
    message: "Visual ratings must start at 1",
  });
const numberField = z
  .object({
    type: z.literal("number"),
    ...common,
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().finite().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.min === undefined ||
      value.max === undefined ||
      value.min <= value.max,
    {
      message: "Minimum must not exceed maximum",
    },
  );
const date = z
  .object({
    type: z.literal("date"),
    ...common,
    min: z.iso.date().optional(),
    max: z.iso.date().optional(),
  })
  .strict()
  .refine((value) => !value.min || !value.max || value.min <= value.max, {
    message: "Minimum date must not exceed maximum date",
  });
const singleChoice = z
  .object({
    type: z.literal("single_choice"),
    ...common,
    ...choiceExtensions,
    options: z.array(option).min(1).max(FORM_LIMITS.maxOptions),
  })
  .strict();
const multipleChoice = z
  .object({
    type: z.literal("multiple_choice"),
    ...common,
    ...choiceExtensions,
    options: z.array(option).min(1).max(FORM_LIMITS.maxOptions),
    minSelections: z.number().int().min(0).optional(),
    maxSelections: z
      .number()
      .int()
      .min(1)
      .max(FORM_LIMITS.maxOptions)
      .optional(),
  })
  .strict();
const dropdown = z
  .object({
    type: z.literal("dropdown"),
    ...common,
    ...choiceExtensions,
    placeholder: z.string().max(FORM_LIMITS.maxPlaceholderLength).optional(),
    options: z.array(option).min(1).max(FORM_LIMITS.maxOptions),
  })
  .strict();
const ranking = z
  .object({
    type: z.literal("ranking"),
    ...common,
    options: z.array(option).min(2).max(FORM_LIMITS.maxOptions),
  })
  .strict();
const matrix = z
  .object({
    type: z.literal("matrix"),
    ...common,
    rows: z.array(option).min(1).max(FORM_LIMITS.maxOptions),
    columns: z.array(option).min(2).max(FORM_LIMITS.maxOptions),
    multiple: z.boolean().default(false),
  })
  .strict();
const consent = z
  .object({
    type: z.literal("consent"),
    ...common,
    statement: z
      .string()
      .trim()
      .min(1)
      .max(FORM_LIMITS.maxConsentStatementLength),
  })
  .strict();

export const informationStyleSchema = z.enum([
  "default",
  "alert",
  "error",
  "info",
  "warning",
  "question",
  "success",
  "tip",
  "note",
  "announcement",
]);
export type InformationStyle = z.infer<typeof informationStyleSchema>;

const information = z
  .object({
    type: z.literal("information"),
    id,
    text: z.string().trim().min(1).max(FORM_LIMITS.maxInformationTextLength),
    style: informationStyleSchema.optional(),
  })
  .strict();
const sectionTitle = z
  .object({
    type: z.literal("section_title"),
    id,
    label: z.string().trim().min(1).max(FORM_LIMITS.maxSectionTitleLength),
    helpText: z
      .string()
      .trim()
      .max(FORM_LIMITS.maxSectionDescriptionLength)
      .optional(),
    required: z.literal(false).default(false),
  })
  .strict();

export const formFieldSchema = z.discriminatedUnion("type", [
  shortText,
  longText,
  email,
  website,
  phone,
  yesNo,
  time,
  rating,
  numberField,
  date,
  singleChoice,
  multipleChoice,
  dropdown,
  ranking,
  matrix,
  consent,
  information,
  sectionTitle,
]);
export type FormField = z.infer<typeof formFieldSchema>;
export type FormFieldType = FormField["type"];

export const FORM_FIELD_REGISTRY = [
  { type: "short_text", label: "Short answer", group: "Write" },
  { type: "long_text", label: "Long answer", group: "Write" },
  { type: "single_choice", label: "Single choice", group: "Choose" },
  { type: "multiple_choice", label: "Multiple choice", group: "Choose" },
  { type: "dropdown", label: "Dropdown", group: "Choose" },
  { type: "yes_no", label: "Yes / No", group: "Choose" },
  { type: "rating", label: "Rating", group: "Choose" },
  { type: "ranking", label: "Ranking", group: "Choose" },
  { type: "matrix", label: "Matrix", group: "Choose" },
  { type: "consent", label: "Consent", group: "Choose" },
  { type: "email", label: "Email", group: "Details" },
  { type: "number", label: "Number", group: "Details" },
  { type: "date", label: "Date", group: "Details" },
  { type: "time", label: "Time", group: "Details" },
  { type: "website", label: "Website", group: "Details" },
  { type: "phone", label: "Phone", group: "Details" },
  { type: "information", label: "Information", group: "Explain" },
  { type: "section_title", label: "Section title", group: "Explain" },
] as const satisfies readonly {
  type: FormFieldType;
  label: string;
  group: "Write" | "Choose" | "Details" | "Explain";
}[];
