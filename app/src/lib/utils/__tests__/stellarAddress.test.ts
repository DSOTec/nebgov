import { isValidStellarAddress } from "../stellarAddress";

const VALID_ADDRESS = "GDOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNIB";
const VALID_ADDRESS_2 = "GD6HLZWRE5FHK3SDLZB3FH56R3H3ECAAYCPWWU7O7EK4FCNT2Z7S6D5I";

describe("isValidStellarAddress", () => {
  describe("valid addresses", () => {
    it("returns true for a valid Ed25519 public key", () => {
      expect(isValidStellarAddress(VALID_ADDRESS)).toBe(true);
    });

    it("returns true for a second valid Ed25519 public key", () => {
      expect(isValidStellarAddress(VALID_ADDRESS_2)).toBe(true);
    });

    it("trims leading whitespace before validating", () => {
      expect(isValidStellarAddress("  " + VALID_ADDRESS)).toBe(true);
    });

    it("trims trailing whitespace before validating", () => {
      expect(isValidStellarAddress(VALID_ADDRESS + "  ")).toBe(true);
    });

    it("trims both leading and trailing whitespace", () => {
      expect(isValidStellarAddress("  " + VALID_ADDRESS + "  ")).toBe(true);
    });

    it("trims newline characters before validating", () => {
      expect(isValidStellarAddress(VALID_ADDRESS + "\n")).toBe(true);
    });

    it("trims tab characters before validating", () => {
      expect(isValidStellarAddress("\t" + VALID_ADDRESS)).toBe(true);
    });
  });

  describe("invalid addresses", () => {
    it("returns false for an empty string", () => {
      expect(isValidStellarAddress("")).toBe(false);
    });

    it("returns false for a whitespace-only string", () => {
      expect(isValidStellarAddress("   ")).toBe(false);
    });

    it("returns false for an address that does not start with G", () => {
      expect(isValidStellarAddress("ADOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNIB")).toBe(false);
    });

    it("returns false for a lowercase address", () => {
      expect(isValidStellarAddress(VALID_ADDRESS.toLowerCase())).toBe(false);
    });

    it("returns false for an address that is too short", () => {
      expect(isValidStellarAddress("GDOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNI")).toBe(false);
    });

    it("returns false for an address that is too long", () => {
      expect(isValidStellarAddress(VALID_ADDRESS + "B")).toBe(false);
    });

    it("returns false for a random short string", () => {
      expect(isValidStellarAddress("GABC123")).toBe(false);
    });

    it("returns false for a string with invalid base32 characters", () => {
      expect(isValidStellarAddress("G" + "0".repeat(55))).toBe(false);
    });

    it("returns false for a contract address (C...)", () => {
      expect(isValidStellarAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM")).toBe(false);
    });

    it("returns false for a numeric string", () => {
      expect(isValidStellarAddress("12345678901234567890123456789012345678901234567890123456")).toBe(false);
    });

    it("returns false for an address with an internal space", () => {
      const withSpace = VALID_ADDRESS.slice(0, 28) + " " + VALID_ADDRESS.slice(29);
      expect(isValidStellarAddress(withSpace)).toBe(false);
    });

    it("returns false for a corrupted checksum", () => {
      const corrupted = VALID_ADDRESS.slice(0, -2) + "AA";
      expect(isValidStellarAddress(corrupted)).toBe(false);
    });

    it("returns false for undefined cast to string", () => {
      expect(isValidStellarAddress(String(undefined))).toBe(false);
    });

    it("returns false for null cast to string", () => {
      expect(isValidStellarAddress(String(null))).toBe(false);
    });
  });
});
