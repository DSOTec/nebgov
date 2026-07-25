/**
 * Explicit XDR <-> native encode/decode helpers used by the mock executors.
 *
 * We deliberately avoid `nativeToScVal`'s untyped object/map inference for
 * struct-shaped return values: Soroban unit-enum variants (e.g.
 * `ProposalState::Active`) encode as a one-element `Vec<Symbol>`, which
 * generic inference does not produce. Building every return value explicitly
 * keeps the encoding unambiguous and matches what `contracts/governor`,
 * `contracts/timelock`, and `contracts/token-votes` actually put on the wire.
 */
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

export function encAddress(addr: string): xdr.ScVal {
  return nativeToScVal(addr, { type: "address" });
}

export function encU32(n: number): xdr.ScVal {
  return nativeToScVal(n, { type: "u32" });
}

export function encU64(n: bigint | number): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}

export function encI128(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

export function encBool(b: boolean): xdr.ScVal {
  return nativeToScVal(b, { type: "boolean" });
}

export function encString(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: "string" });
}

export function encBytes(b: Uint8Array): xdr.ScVal {
  return nativeToScVal(Buffer.from(b), { type: "bytes" });
}

export function encSymbol(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s);
}

/** A data-less Rust enum variant (e.g. `ProposalState::Active`) -> `Vec<Symbol>` of length 1. */
export function encEnum(variant: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]);
}

export function encVec(items: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(items);
}

export function encVoid(): xdr.ScVal {
  return xdr.ScVal.scvVoid();
}

/** A `#[contracttype] struct` -> sorted `ScMap` keyed by field name symbols. */
export function encMap(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const keys = Object.keys(fields).sort();
  return xdr.ScVal.scvMap(
    keys.map(
      (key) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(key),
          val: fields[key],
        }),
    ),
  );
}

/** Decode a data-less enum variant name from a `Vec<Symbol>`-shaped native value. */
export function decodeEnumVariant(native: unknown): string {
  if (Array.isArray(native) && native.length > 0 && typeof native[0] === "string") {
    return native[0];
  }
  throw new Error(`Expected an enum variant (Vec<Symbol>), got ${JSON.stringify(native)}`);
}
