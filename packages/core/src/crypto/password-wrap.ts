import {
  asArrayBuffer,
  decodeBase64Url,
  encodeBase64Url,
  randomBytes,
  utf8,
  utf8Decoder,
} from "./encoding";
import { wrappedSecretSchema, type WrappedSecret } from "./wrapped-secret";

export { wrappedSecretSchema, type WrappedSecret } from "./wrapped-secret";

export const ARGON2ID_PARAMETERS = {
  version: 1,
  memoryKiB: 19_456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
} as const;

async function deriveArgon(
  passwordBytes: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const { argon2id } = await import("hash-wasm");
  const result = await argon2id({
    password: passwordBytes,
    salt,
    parallelism: ARGON2ID_PARAMETERS.parallelism,
    iterations: ARGON2ID_PARAMETERS.passes,
    memorySize: ARGON2ID_PARAMETERS.memoryKiB,
    hashLength: ARGON2ID_PARAMETERS.tagLength,
    outputType: "binary",
  });
  return result as Uint8Array;
}

async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  if (password.length < 12)
    throw new Error("Password must contain at least 12 characters");
  const passwordBytes = utf8.encode(password);
  try {
    return await deriveArgon(passwordBytes, salt);
  } finally {
    passwordBytes.fill(0);
  }
}

function wrapAad(kdfName: string, salt: string): Uint8Array {
  return utf8.encode(`burnerform:wrapped-secret:v1:${kdfName}:${salt}`);
}

export async function wrapSecret(
  secret: Uint8Array,
  password: string,
): Promise<WrappedSecret> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const derived = await derive(password, salt);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      asArrayBuffer(derived),
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const saltEncoded = encodeBase64Url(salt);
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(nonce),
        additionalData: asArrayBuffer(wrapAad("argon2id", saltEncoded)),
        tagLength: 128,
      },
      key,
      asArrayBuffer(secret),
    );
    const kdf = { name: "argon2id", ...ARGON2ID_PARAMETERS, salt: saltEncoded };
    return wrappedSecretSchema.parse({
      version: 1,
      kdf,
      cipher: {
        name: "AES-256-GCM",
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
      },
    });
  } finally {
    derived.fill(0);
  }
}

export async function unwrapSecret(
  input: unknown,
  password: string,
): Promise<Uint8Array> {
  const wrapped = wrappedSecretSchema.parse(input);
  const salt = decodeBase64Url(wrapped.kdf.salt);
  const derived = await derive(password, salt);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      asArrayBuffer(derived),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(decodeBase64Url(wrapped.cipher.nonce)),
        additionalData: asArrayBuffer(
          wrapAad(wrapped.kdf.name, wrapped.kdf.salt),
        ),
        tagLength: 128,
      },
      key,
      asArrayBuffer(decodeBase64Url(wrapped.cipher.ciphertext)),
    );
    return new Uint8Array(plaintext);
  } finally {
    derived.fill(0);
  }
}

export async function wrapJson(
  value: unknown,
  password: string,
): Promise<WrappedSecret> {
  return wrapSecret(utf8.encode(JSON.stringify(value)), password);
}
export async function unwrapJson<T>(
  value: unknown,
  password: string,
): Promise<T> {
  const bytes = await unwrapSecret(value, password);
  try {
    return JSON.parse(utf8Decoder.decode(bytes)) as T;
  } finally {
    bytes.fill(0);
  }
}
