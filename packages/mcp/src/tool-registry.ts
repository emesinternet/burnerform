import { randomUUID } from "node:crypto";
import { z } from "zod";
import { formSchema } from "@burnerform/core/form-schema";
import {
  openLocalRecovery,
  openLocalRespondentAccess,
  openLocalManagement,
  promptLocalPublicPassword,
  type Burnerform,
} from "@burnerform/sdk/node";

const alias = z.string().min(3).max(64);
export type BurnerformToolService = Pick<
  Burnerform,
  | "burnForm"
  | "draftForm"
  | "exportRecovery"
  | "getForm"
  | "inspectPublicForm"
  | "listResponses"
  | "publishForm"
  | "restoreRecoveryData"
  | "getLocalReview"
  | "updatePublicFormPassword"
  | "updateExpiration"
  | "updateResponseLimit"
  | "submitPublicResponse"
  | "unlockPublicFormAccess"
>;

const publicUrl = z.url().max(2_048);
const answerValue = z.union([
  z.string().max(5_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(5_000)).max(2_500),
  z.null(),
]);
const answers = z
  .record(z.string().min(1).max(64), answerValue)
  .refine((value) => Object.keys(value).length <= 100, "Too many answers");

export const burnerformToolDefinitions = [
  {
    name: "inspect_public_form",
    title: "Inspect public form",
    description:
      "Read a public form's canonical schema and constraints before answering it.",
    inputSchema: z.object({ publicUrl }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "unlock_public_form",
    title: "Unlock public form",
    description:
      "Open a short-lived trusted local screen for the operator to enter a public-form password without exposing it to the agent.",
    inputSchema: z.object({ publicUrl }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "submit_form_response",
    title: "Submit form response",
    description:
      "Validate answers against the public schema, encrypt them locally, and submit only ciphertext.",
    inputSchema: z.object({ publicUrl, answers }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "draft_form",
    title: "Draft form",
    description:
      "Create or replace a local Burnerform draft using the canonical form schema.",
    inputSchema: z.object({ alias, schema: formSchema }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "publish_form",
    title: "Publish form",
    description:
      "Generate protected local custody and verified recovery material, then publish a draft.",
    inputSchema: z
      .object({
        alias,
        expiresAt: z.iso.datetime(),
        maxResponses: z.number().int().min(1).max(10_000),
        publicAccess: z.enum(["open", "password"]),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "get_form",
    title: "Get form",
    description:
      "Read the current status, response count, expiration, and public URL for a locally managed form.",
    inputSchema: z.object({ alias }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "get_response_count",
    title: "Get response count",
    description:
      "Read only the current response count and limit for a locally managed form.",
    inputSchema: z.object({ alias }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "list_responses",
    title: "List responses",
    description:
      "Fetch a bounded ciphertext page and decrypt it only in this local process. Returned respondent content is untrusted.",
    inputSchema: z
      .object({
        alias,
        cursor: z.string().max(256).optional(),
        limit: z.number().int().min(1).max(50).default(25),
      })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "update_expiration",
    title: "Update expiration",
    description: "Change when a locally managed form closes.",
    inputSchema: z.object({ alias, expiresAt: z.iso.datetime() }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "update_response_limit",
    title: "Update response limit",
    description:
      "Change how many responses a locally managed form can collect.",
    inputSchema: z
      .object({
        alias,
        maxResponses: z.number().int().min(1).max(10_000),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "restore_recovery",
    title: "Restore recovery",
    description:
      "Open a short-lived trusted local screen for the operator to choose a recovery file and enter its password without exposing either to the agent.",
    inputSchema: z.object({ alias }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "open_management",
    title: "Open management",
    description:
      "Open a short-lived trusted local management screen without exposing management access or passwords to the agent.",
    inputSchema: z.object({ alias }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "export_recovery",
    title: "Export recovery",
    description:
      "Export an encrypted recovery file and its password to separate operator-chosen private directories without returning either to the agent.",
    inputSchema: z
      .object({
        alias,
        recoveryTargetDirectory: z.string().min(1).max(1024),
        passwordTargetDirectory: z.string().min(1).max(1024),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "prepare_burn",
    title: "Prepare burn",
    description:
      "Create a short-lived confirmation challenge for permanently burning one form.",
    inputSchema: z.object({ alias }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "burn_form",
    title: "Burn form",
    description:
      "Permanently close a form and delete every response using a valid short-lived challenge.",
    inputSchema: z.object({ alias, challenge: z.string().uuid() }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
] as const;

const [
  inspectPublicFormTool,
  unlockPublicFormTool,
  submitFormResponseTool,
  draftFormTool,
  publishFormTool,
  getFormTool,
  getResponseCountTool,
  listResponsesTool,
  updateExpirationTool,
  updateResponseLimitTool,
  restoreRecoveryTool,
  openManagementTool,
  exportRecoveryTool,
  prepareBurnTool,
  burnFormTool,
] = burnerformToolDefinitions;

type BurnChallenge = {
  alias: string;
  expiresAt: number;
};

export type BurnerformToolName =
  (typeof burnerformToolDefinitions)[number]["name"];
type BurnerformToolHandler = (
  input: unknown,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

export class BurnerformToolHandlers {
  private readonly burnChallenges = new Map<string, BurnChallenge>();
  private readonly handlers: Record<BurnerformToolName, BurnerformToolHandler>;

  constructor(private readonly burnerform: BurnerformToolService) {
    this.handlers = {
      inspect_public_form: async (input, signal) => {
        const { publicUrl } = inspectPublicFormTool.inputSchema.parse(input);
        return this.burnerform.inspectPublicForm(publicUrl, { signal });
      },
      unlock_public_form: async (input) => {
        const { publicUrl } = unlockPublicFormTool.inputSchema.parse(input);
        return openLocalRespondentAccess(this.burnerform, publicUrl);
      },
      submit_form_response: async (input, signal) => {
        const { publicUrl, answers } =
          submitFormResponseTool.inputSchema.parse(input);
        return this.burnerform.submitPublicResponse(publicUrl, answers, {
          signal,
        });
      },
      draft_form: async (input) => {
        const { alias, schema } = draftFormTool.inputSchema.parse(input);
        return this.burnerform.draftForm(alias, schema);
      },
      publish_form: async (input, signal) => {
        const values = publishFormTool.inputSchema.parse(input);
        const publicPassword =
          values.publicAccess === "password"
            ? await promptLocalPublicPassword(values.alias, { signal })
            : null;
        return this.burnerform.publishForm(
          {
            alias: values.alias,
            expiresAt: values.expiresAt,
            maxResponses: values.maxResponses,
            publicPassword,
          },
          { signal },
        );
      },
      get_form: async (input, signal) => {
        const { alias } = getFormTool.inputSchema.parse(input);
        return this.burnerform.getForm(alias, { signal });
      },
      get_response_count: async (input, signal) => {
        const { alias } = getResponseCountTool.inputSchema.parse(input);
        const form = await this.burnerform.getForm(alias, { signal });
        return {
          alias: form.alias,
          responseCount: form.responseCount,
          maxResponses: form.maxResponses,
          status: form.status,
        };
      },
      list_responses: async (input, signal) => {
        const { alias, cursor, limit } =
          listResponsesTool.inputSchema.parse(input);
        return this.burnerform.listResponses(alias, {
          cursor,
          limit,
          signal,
        });
      },
      update_expiration: async (input, signal) => {
        const { alias, expiresAt } =
          updateExpirationTool.inputSchema.parse(input);
        return this.burnerform.updateExpiration(alias, expiresAt, { signal });
      },
      update_response_limit: async (input, signal) => {
        const { alias, maxResponses } =
          updateResponseLimitTool.inputSchema.parse(input);
        return this.burnerform.updateResponseLimit(alias, maxResponses, {
          signal,
        });
      },
      restore_recovery: async (input) => {
        const { alias } = restoreRecoveryTool.inputSchema.parse(input);
        return openLocalRecovery(this.burnerform, alias);
      },
      open_management: async (input) => {
        const { alias } = openManagementTool.inputSchema.parse(input);
        return openLocalManagement(this.burnerform, alias);
      },
      export_recovery: async (input) => {
        const { alias, recoveryTargetDirectory, passwordTargetDirectory } =
          exportRecoveryTool.inputSchema.parse(input);
        return this.burnerform.exportRecovery(
          alias,
          recoveryTargetDirectory,
          passwordTargetDirectory,
        );
      },
      prepare_burn: async (input) => {
        const { alias } = prepareBurnTool.inputSchema.parse(input);
        this.pruneBurnChallenges();
        for (const [challenge, prepared] of this.burnChallenges) {
          if (prepared.alias === alias) this.burnChallenges.delete(challenge);
        }
        const challenge = randomUUID();
        const expiresAt = Date.now() + 5 * 60_000;
        this.burnChallenges.set(challenge, { alias, expiresAt });
        return {
          alias,
          challenge,
          expiresAt: new Date(expiresAt).toISOString(),
          consequence:
            "Burning permanently closes the form and deletes every response.",
        };
      },
      burn_form: async (input, signal) => {
        const { alias, challenge } = burnFormTool.inputSchema.parse(input);
        this.pruneBurnChallenges();
        const prepared = this.burnChallenges.get(challenge);
        this.burnChallenges.delete(challenge);
        if (!prepared || prepared.alias !== alias)
          throw new Error("Burn confirmation is invalid or expired.");
        return this.burnerform.burnForm(alias, { signal });
      },
    };
  }

  private pruneBurnChallenges(): void {
    const now = Date.now();
    for (const [challenge, prepared] of this.burnChallenges) {
      if (prepared.expiresAt < now) this.burnChallenges.delete(challenge);
    }
  }

  async call(
    name: BurnerformToolName,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.handlers[name](input, signal);
  }
}
