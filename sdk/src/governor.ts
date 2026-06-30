// Re-export everything from the modular governor structure for backwards compatibility
export * from "./governor/index";

// Keep standalone utility functions and types that don't belong to the modular structure
import {
  GovernorConfig,
  GovernorSettings,
  GovernorSettingsValidationLimits,
} from "./types";

/** Options for uploading proposal metadata to IPFS. */
export interface MetadataUploadOptions {
  /** Pinata API Key (JWT or API Key) */
  pinataApiKey?: string;
  /** Pinata Secret Key (if using API Key/Secret pair) */
  pinataSecretKey?: string;
  /**
   * Custom uploader function for other IPFS gateways.
   *
   * Use this to integrate any storage provider not natively supported by the
   * SDK (e.g. web3.storage, nft.storage, Filebase, etc.).  The function
   * receives the raw description string and must return a fully-qualified
   * IPFS URI (`ipfs://…`).
   *
   * @example
   * // web3.storage integration (tracked in issue #429)
   * const options: MetadataUploadOptions = {
   *   customUploader: async (content) => {
   *     // Use @web3-storage/w3up-client or any compatible library here.
   *     throw new Error("web3.storage uploader not yet configured");
   *   },
   * };
   */
  customUploader?: (content: string) => Promise<string>;
}

/**
 * Compute SHA-256 hash of a proposal description.
 *
 * This function uses the Web Crypto API in browser environments and
 * Node.js crypto module in server-side environments. The input is
 * UTF-8 encoded before hashing, and the output is a 64-character
 * lowercase hex string.
 *
 * @param text - The proposal description text to hash
 * @returns Hex-encoded SHA-256 hash (64 lowercase characters)
 */
export async function hashDescription(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);

  // Use Web Crypto API (available in both browser and Node.js 18+)
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Fallback to Node.js crypto module
  if (typeof require !== "undefined") {
    try {
      const cryptoNode = require("crypto");
      const hash = cryptoNode.createHash("sha256").update(data).digest("hex");
      return hash;
    } catch (e) {
      // ignore and try next fallback
    }
  }

  throw new Error("No crypto API available in this environment");
}

/**
 * Synchronous version of hashDescription for environments where async is not needed.
 * Uses the same algorithm and encoding.
 */
export function hashDescriptionSync(text: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);

  // Try Node.js crypto first (synchronous)
  if (typeof require !== "undefined") {
    try {
      const cryptoNode = require("crypto");
      const hash = cryptoNode.createHash("sha256").update(data).digest("hex");
      return hash;
    } catch (e) {
      // ignore and try next fallback
    }
  }

  throw new Error("Synchronous SHA-256 is only available in Node.js environments. Use async hashDescription instead.");
}

/**
 * Upload proposal description to IPFS and compute its SHA-256 hash.
 *
 * This helper simplifies the "Step 1" of creating a proposal by handling
 * the IPFS pinning (via Pinata or custom uploader) and generating the
 * description_hash required by the governor contract.
 *
 * @param description - The full text description of the proposal
 * @param options - Upload credentials and provider selection
 * @returns The IPFS URI (ipfs://...) and hex-encoded SHA-256 hash
 */
export async function uploadProposalMetadata(
  description: string,
  options: MetadataUploadOptions,
): Promise<{ uri: string; hash: string }> {
  const hash = await hashDescription(description);
  let uri = "";

  if (options.customUploader) {
    uri = await options.customUploader(description);
  } else if (options.pinataApiKey) {
    // Pinata API implementation
    // We use the JSON pinning endpoint: https://api.pinata.cloud/pinning/pinJSONToIPFS
    const body = {
      pinataContent: {
        description,
        version: "1.0",
      },
      pinataMetadata: {
        name: `nebgov-proposal-${hash.substring(0, 8)}`,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (options.pinataSecretKey) {
      // Legacy API Key + Secret pair
      headers["pinata_api_key"] = options.pinataApiKey;
      headers["pinata_secret_api_key"] = options.pinataSecretKey;
    } else {
      // Modern JWT
      headers["Authorization"] = `Bearer ${options.pinataApiKey}`;
    }

    const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Pinata upload failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as { IpfsHash: string };
    uri = `ipfs://${data.IpfsHash}`;
  } else {
    throw new Error("No IPFS upload provider configured in options");
  }

  return { uri, hash };
}
