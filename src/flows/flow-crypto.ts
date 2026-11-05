/**
 * The Flow endpoint's encryption (data API 3.0). WhatsApp encrypts each request
 * with a fresh AES-128 key, wrapped with our RSA public key (OAEP, SHA-256);
 * the response is encrypted with the same AES key and the request's IV with
 * every bit flipped. Both payloads are AES-GCM with the 16-byte tag appended.
 */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import type { EncryptedFlowBody } from "./flows.interface";

const TAG_BYTES = 16;

/** A request that can't be decrypted: answered with HTTP 421, so WhatsApp refetches our public key. */
export class FlowDecryptError extends Error {}

/** A decrypted request, with what its response must be encrypted with. */
export interface DecryptedFlowRequest {
  body: unknown;
  aesKey: Buffer;
  iv: Buffer;
}

/** The private key from its PEM (literal `\n`s, as env vars often hold them, are accepted). */
export function loadPrivateKey(pem: string, passphrase = ""): KeyObject {
  return createPrivateKey({
    key: pem.replace(/\\n/g, "\n"),
    format: "pem",
    ...(passphrase ? { passphrase } : {}),
  });
}

function aes(key: Buffer): `aes-${128 | 192 | 256}-gcm` {
  switch (key.length) {
    case 16:
      return "aes-128-gcm";
    case 24:
      return "aes-192-gcm";
    case 32:
      return "aes-256-gcm";
    default:
      throw new FlowDecryptError(`Unexpected AES key length ${key.length}`);
  }
}

export function decryptFlowRequest(
  body: EncryptedFlowBody,
  privateKey: KeyObject,
): DecryptedFlowRequest {
  try {
    const aesKey = privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(body.encrypted_aes_key, "base64"),
    );
    const iv = Buffer.from(body.initial_vector, "base64");
    const data = Buffer.from(body.encrypted_flow_data, "base64");
    if (data.length <= TAG_BYTES) throw new Error("Encrypted data too short");
    const decipher = createDecipheriv(aes(aesKey), aesKey, iv);
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    const json = Buffer.concat([
      decipher.update(data.subarray(0, data.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
    return { body: JSON.parse(json) as unknown, aesKey, iv };
  } catch (error) {
    if (error instanceof FlowDecryptError) throw error;
    throw new FlowDecryptError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

const flip = (iv: Buffer) => Buffer.from(iv.map((byte) => byte ^ 0xff));

/** The response body: base64 of the AES-GCM ciphertext and its tag. */
export function encryptFlowResponse(
  response: unknown,
  aesKey: Buffer,
  iv: Buffer,
): string {
  const cipher = createCipheriv(aes(aesKey), aesKey, flip(iv));
  return Buffer.concat([
    cipher.update(JSON.stringify(response), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}

/** Encrypts a request as WhatsApp does: for tests and local checks of the endpoint. */
export function encryptFlowRequest(
  request: unknown,
  publicKey: KeyObject | string,
): { body: EncryptedFlowBody; aesKey: Buffer; iv: Buffer } {
  const aesKey = randomBytes(16);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-gcm", aesKey, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(request), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const wrapped = publicEncrypt(
    {
      key:
        typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey,
  );
  return {
    body: {
      encrypted_flow_data: data.toString("base64"),
      encrypted_aes_key: wrapped.toString("base64"),
      initial_vector: iv.toString("base64"),
    },
    aesKey,
    iv,
  };
}

/** Decrypts an endpoint response as WhatsApp does: for tests. */
export function decryptFlowResponse(
  encrypted: string,
  aesKey: Buffer,
  iv: Buffer,
): unknown {
  const data = Buffer.from(encrypted, "base64");
  const decipher = createDecipheriv(aes(aesKey), aesKey, flip(iv));
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  return JSON.parse(
    Buffer.concat([
      decipher.update(data.subarray(0, data.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8"),
  ) as unknown;
}
