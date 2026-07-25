import type { WrappedSecret } from "@burnerform/core/crypto/wrapped-secret";

export type ResponseAccessMode =
  "shared_password" | "creator_password" | "creator_only";

export interface CreatorOnlyRecord {
  version: 1;
  mode: "creator_only";
  formId: string;
  keyId: string;
  publicKey: string;
  privateKey: CryptoKey;
  managementKey: string;
}
export interface CreatorPasswordRecord {
  version: 1;
  mode: "creator_password";
  formId: string;
  keyId: string;
  publicKey: string;
  wrappedLocalCustody: WrappedSecret;
}
export interface SharedPasswordRecord {
  version: 1;
  mode: "shared_password";
  formId: string;
  keyId: string;
  publicKey: string;
  managementKey: string;
  wrappedResponseKey: WrappedSecret;
}
export type CreatorCustodyRecord =
  CreatorOnlyRecord | CreatorPasswordRecord | SharedPasswordRecord;

export interface RecoveryFile {
  format: "burnerform-recovery";
  version: 1;
  formId: string;
  keyId: string;
  publicKey: string;
  createdAt: string;
  wrappedCustody: WrappedSecret;
}

export interface UnlockedCustody {
  privateKey: CryptoKey;
  managementKey?: string;
  lifecycleAccess: boolean;
}
