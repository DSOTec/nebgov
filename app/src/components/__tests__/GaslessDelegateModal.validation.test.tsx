/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GaslessDelegateModal } from "../GaslessDelegateModal";

const VALID_ADDRESS = "GDOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNIB";
const VALID_ADDRESS_2 = "GD6HLZWRE5FHK3SDLZB3FH56R3H3ECAAYCPWWU7O7EK4FCNT2Z7S6D5I";
const mockDelegateGasless = jest.fn();
const mockPreflightDelegatee = jest.fn();

jest.mock("../../lib/wallet-context", () => ({
  useWallet: () => ({
    isConnected: true,
    publicKey: VALID_ADDRESS_2,
    connect: jest.fn(),
  }),
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

jest.mock("../../hooks/useGaslessDelegation", () => ({
  useGaslessDelegation: () => ({
    delegateGasless: mockDelegateGasless.mockResolvedValue({ txHash: "txhash789" }),
    preflightDelegatee: mockPreflightDelegatee.mockResolvedValue(undefined),
    submitting: false,
  }),
  EXPIRY_PRESET_LABELS: {
    "1week": "1 week",
    "1month": "1 month",
    "6months": "6 months",
    "1year": "1 year",
  },
}));

const defaultProps = {
  open: true,
  onClose: jest.fn(),
  onDelegated: jest.fn(),
};

describe("GaslessDelegateModal — Stellar address validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDelegateGasless.mockReset();
    mockPreflightDelegatee.mockReset();
    mockDelegateGasless.mockResolvedValue({ txHash: "txhash789" });
    mockPreflightDelegatee.mockResolvedValue(undefined);
  });

  describe("rendering", () => {
    it("renders the delegatee input", () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      expect(screen.getByPlaceholderText("Stellar address (G...)")).toBeInTheDocument();
    });

    it("does not render when open is false", () => {
      render(<GaslessDelegateModal {...defaultProps} open={false} />);
      expect(screen.queryByPlaceholderText("Stellar address (G...)")).not.toBeInTheDocument();
    });

    it("prefills the delegatee input when prefillAddress is provided", () => {
      render(<GaslessDelegateModal {...defaultProps} prefillAddress={VALID_ADDRESS} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)") as HTMLInputElement;
      expect(input.value).toBe(VALID_ADDRESS);
    });

    it("renders the Delegate for free submit button", () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      expect(screen.getByRole("button", { name: /delegate for free/i })).toBeInTheDocument();
    });

    it("submit button is disabled when input is empty", () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      const btn = screen.getByRole("button", { name: /delegate for free/i });
      expect(btn).toBeDisabled();
    });

    it("renders top delegate quick-pick buttons when topDelegates is provided", () => {
      const topDelegates = [
        { address: VALID_ADDRESS, votingPower: 1000n, baseVotes: 1000n, delegatorCount: 1 },
        { address: VALID_ADDRESS_2, votingPower: 500n, baseVotes: 500n, delegatorCount: 1 },
      ];
      render(<GaslessDelegateModal {...defaultProps} topDelegates={topDelegates} />);
      expect(screen.getAllByRole("button").length).toBeGreaterThan(2);
    });
  });

  describe("blur validation", () => {
    it("shows error on blur when address is empty", async () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Address is required.")).toBeInTheDocument();
      });
    });

    it("shows error on blur when address is invalid", async () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "GBADADDRESS");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("shows error on blur for address with wrong prefix", async () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "SDOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNIB");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("shows error on blur for address with trailing newline", async () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      fireEvent.change(input, { target: { value: "GBADADDRESS\n" } });
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("clears error when user starts typing a new value", async () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument());
      await userEvent.clear(input);
      await userEvent.type(input, "G");
      await waitFor(() => expect(screen.queryByText("Invalid Stellar address.")).not.toBeInTheDocument());
    });

    it("does not show error before user interaction", () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      expect(screen.queryByText("Invalid Stellar address.")).not.toBeInTheDocument();
      expect(screen.queryByText("Address is required.")).not.toBeInTheDocument();
    });

    it("applies red border when address is invalid after blur", async () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(input.className).toContain("border-red-400");
      });
    });

    it("does not apply red border when address is valid", async () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, VALID_ADDRESS);
      fireEvent.blur(input);
      await waitFor(() => {
        expect(input.className).not.toContain("border-red-400");
      });
    });
  });

  describe("submit validation", () => {
    it("blocks submit and shows error when address is empty", async () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      const form = screen.getByPlaceholderText("Stellar address (G...)").closest("form")!;
      fireEvent.submit(form);
      await waitFor(() => {
        expect(screen.getByText("Address is required.")).toBeInTheDocument();
      });
    });

    it("blocks submit and shows error when address is invalid", async () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "GBADADDRESS");
      const form = input.closest("form")!;
      fireEvent.submit(form);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("submit button is disabled while there is a validation error", async () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /delegate for free/i });
        expect(btn).toBeDisabled();
      });
    });

    it("submit button is enabled when a valid address is entered", async () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, VALID_ADDRESS);
      const btn = screen.getByRole("button", { name: /delegate for free/i });
      expect(btn).not.toBeDisabled();
    });

    it("shows an inline error and skips the wallet-sign flow when preflight validation fails", async () => {
      mockPreflightDelegatee.mockRejectedValueOnce(new Error("This delegation would create a cycle."));
      render(<GaslessDelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, VALID_ADDRESS);
      const form = input.closest("form")!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByText("This delegation would create a cycle.")).toBeInTheDocument();
      });
      expect(mockDelegateGasless).not.toHaveBeenCalled();
    });
  });

  describe("top delegate quick-pick", () => {
    it("fills the input when a top delegate button is clicked", async () => {
      const topDelegates = [
        { address: VALID_ADDRESS, votingPower: 1000n, baseVotes: 1000n, delegatorCount: 1 },
      ];
      render(<GaslessDelegateModal {...defaultProps} topDelegates={topDelegates} />);
      const shortAddr = `${VALID_ADDRESS.slice(0, 4)}...${VALID_ADDRESS.slice(-4)}`;
      const pickBtn = screen.getByRole("button", { name: shortAddr });
      await userEvent.click(pickBtn);
      const input = screen.getByPlaceholderText("Stellar address (G...)") as HTMLInputElement;
      expect(input.value).toBe(VALID_ADDRESS);
    });
  });

  describe("expiry preset selection", () => {
    it("renders all four expiry preset buttons", () => {
      render(<GaslessDelegateModal {...defaultProps} />);
      expect(screen.getByRole("button", { name: "1 week" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "1 month" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "6 months" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "1 year" })).toBeInTheDocument();
    });
  });

  describe("cancel", () => {
    it("calls onClose when Cancel is clicked", async () => {
      const onClose = jest.fn();
      render(<GaslessDelegateModal {...defaultProps} onClose={onClose} />);
      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
