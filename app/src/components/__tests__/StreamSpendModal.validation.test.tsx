/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StreamSpendModal } from "../StreamSpendModal";
import type { TreasuryClient, TreasuryBudgetStream } from "../../lib/treasury-client";

const VALID_ADDRESS = "GDOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNIB";
const VALID_ADDRESS_2 = "GD6HLZWRE5FHK3SDLZB3FH56R3H3ECAAYCPWWU7O7EK4FCNT2Z7S6D5I";

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

const mockStreamSpend = jest.fn().mockResolvedValue(undefined);
const mockClient = {
  streamSpend: mockStreamSpend,
} as unknown as TreasuryClient;

const mockStream: TreasuryBudgetStream = {
  id: BigInt(1),
  name: "engineering",
  owner: VALID_ADDRESS_2,
  token: "CTOKEN123",
  totalAllocated: BigInt(1000000),
  totalSpent: BigInt(100000),
  maxSingleSpend: BigInt(500000),
  startLedger: 100,
  endLedger: 200000,
  cooldownLedgers: 0,
  lastSpendLedger: 0,
  spendCount: 0,
  createdByProposalId: 0n,
  isActive: true,
  isRevoked: false,
  revokedAtLedger: null,
};

const defaultProps = {
  client: mockClient,
  stream: mockStream,
  signerPublicKey: VALID_ADDRESS_2,
  signUnsignedXdr: jest.fn().mockResolvedValue("signed_xdr"),
  onClose: jest.fn(),
  onSpent: jest.fn(),
};

describe("StreamSpendModal — Stellar address validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders the recipient address input", () => {
      render(<StreamSpendModal {...defaultProps} />);
      expect(screen.getByPlaceholderText("G...")).toBeInTheDocument();
    });

    it("renders the Recipient Address label", () => {
      render(<StreamSpendModal {...defaultProps} />);
      expect(screen.getByText("Recipient Address")).toBeInTheDocument();
    });

    it("renders the Execute Spend submit button", () => {
      render(<StreamSpendModal {...defaultProps} />);
      expect(screen.getByRole("button", { name: /execute spend/i })).toBeInTheDocument();
    });

    it("shows stream name and remaining budget in the header", () => {
      render(<StreamSpendModal {...defaultProps} />);
      expect(screen.getByText(/engineering/i)).toBeInTheDocument();
      expect(screen.getByText(/900000/)).toBeInTheDocument();
    });

    it("disables submit when stream is not active", () => {
      const inactiveStream = { ...mockStream, isActive: false };
      render(<StreamSpendModal {...defaultProps} stream={inactiveStream} />);
      expect(screen.getByRole("button", { name: /execute spend/i })).toBeDisabled();
    });
  });

  describe("blur validation", () => {
    it("shows error on blur when recipient address is invalid", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "GBADADDRESS");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("shows error on blur for lowercase address", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, VALID_ADDRESS.toLowerCase());
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("shows error on blur for address with wrong prefix", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "SDOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNIB");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("shows error on blur for address with copy-paste trailing whitespace", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      fireEvent.change(input, { target: { value: "GBADADDRESS   " } });
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("does not show error on blur when address is valid", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, VALID_ADDRESS);
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.queryByText("Invalid Stellar address.")).not.toBeInTheDocument();
      });
    });

    it("does not show error on blur when field is empty", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.queryByText("Invalid Stellar address.")).not.toBeInTheDocument();
      });
    });

    it("clears error when user types a valid address after an invalid one", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument());
      await userEvent.clear(input);
      await userEvent.type(input, VALID_ADDRESS);
      await waitFor(() => expect(screen.queryByText("Invalid Stellar address.")).not.toBeInTheDocument());
    });

    it("applies red border when address is invalid after blur", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(input.className).toContain("border-red-400");
      });
    });

    it("does not apply red border when address is valid", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, VALID_ADDRESS);
      fireEvent.blur(input);
      await waitFor(() => {
        expect(input.className).not.toContain("border-red-400");
      });
    });
  });

  describe("submit validation", () => {
    it("blocks submit and shows error when recipient address is invalid", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "GBADADDRESS");
      fireEvent.change(screen.getByPlaceholderText("1000"), { target: { value: "1000" } });
      const form = input.closest("form")!;
      fireEvent.submit(form);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
      expect(mockStreamSpend).not.toHaveBeenCalled();
    });

    it("blocks submit when recipient has wrong prefix", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "ADOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNIB");
      fireEvent.change(screen.getByPlaceholderText("1000"), { target: { value: "1000" } });
      const form = input.closest("form")!;
      fireEvent.submit(form);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
      expect(mockStreamSpend).not.toHaveBeenCalled();
    });

    it("submit button is disabled while there is a validation error", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /execute spend/i });
        expect(btn).toBeDisabled();
      });
    });

    it("submit button is re-enabled after error is cleared", async () => {
      render(<StreamSpendModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument());
      await userEvent.clear(input);
      await userEvent.type(input, VALID_ADDRESS);
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /execute spend/i });
        expect(btn).not.toBeDisabled();
      });
    });

    it("submit button is disabled when stream is inactive even with valid address", async () => {
      const inactiveStream = { ...mockStream, isActive: false };
      render(<StreamSpendModal {...defaultProps} stream={inactiveStream} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, VALID_ADDRESS);
      const btn = screen.getByRole("button", { name: /execute spend/i });
      expect(btn).toBeDisabled();
    });
  });

  describe("cancel", () => {
    it("calls onClose when Cancel is clicked", async () => {
      const onClose = jest.fn();
      render(<StreamSpendModal {...defaultProps} onClose={onClose} />);
      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
