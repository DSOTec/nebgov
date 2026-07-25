/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DelegateModal } from "../DelegateModal";

const VALID_ADDRESS = "GDOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNIB";
const VALID_ADDRESS_2 = "GD6HLZWRE5FHK3SDLZB3FH56R3H3ECAAYCPWWU7O7EK4FCNT2Z7S6D5I";

jest.mock("../lib/wallet-context", () => ({
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

jest.mock("@nebgov/sdk", () => ({
  VotesClient: jest.fn().mockImplementation(() => ({
    delegate: jest.fn().mockResolvedValue("txhash123"),
    undelegate: jest.fn().mockResolvedValue("txhash456"),
  })),
}));

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    Keypair: {
      fromSecret: jest.fn().mockReturnValue({ publicKey: () => VALID_ADDRESS_2 }),
    },
  };
});

const defaultProps = {
  open: true,
  onClose: jest.fn(),
  onDelegated: jest.fn(),
};

describe("DelegateModal — Stellar address validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS = "CTEST_GOV";
    process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS = "CTEST_TL";
    process.env.NEXT_PUBLIC_VOTES_ADDRESS = "CTEST_VOTES";
    process.env.NEXT_PUBLIC_DELEGATE_SECRET_KEY = "SCZANGBA5RLKJRDNKPNM5HXJFKZGKZAZBCM5YWKZQKZQKZQKZQKZQKZ";
  });

  describe("rendering", () => {
    it("renders the delegatee input", () => {
      render(<DelegateModal {...defaultProps} />);
      expect(screen.getByPlaceholderText("Stellar address (G...)")).toBeInTheDocument();
    });

    it("does not render when open is false", () => {
      render(<DelegateModal {...defaultProps} open={false} />);
      expect(screen.queryByPlaceholderText("Stellar address (G...)")).not.toBeInTheDocument();
    });

    it("prefills the delegatee input when prefillAddress is provided", () => {
      render(<DelegateModal {...defaultProps} prefillAddress={VALID_ADDRESS} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)") as HTMLInputElement;
      expect(input.value).toBe(VALID_ADDRESS);
    });

    it("renders the Delegate submit button", () => {
      render(<DelegateModal {...defaultProps} />);
      expect(screen.getByRole("button", { name: /delegate$/i })).toBeInTheDocument();
    });

    it("submit button is disabled when input is empty", () => {
      render(<DelegateModal {...defaultProps} />);
      const btn = screen.getByRole("button", { name: /delegate$/i });
      expect(btn).toBeDisabled();
    });
  });

  describe("blur validation", () => {
    it("shows error on blur when address is empty", async () => {
      render(<DelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Address is required.")).toBeInTheDocument();
      });
    });

    it("shows error on blur when address is invalid", async () => {
      render(<DelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "GBADADDRESS");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("shows error on blur for lowercase address", async () => {
      render(<DelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, VALID_ADDRESS.toLowerCase());
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("shows error on blur for address missing G prefix", async () => {
      render(<DelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "ADOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNIB");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("clears error when a valid address is typed after an invalid one", async () => {
      render(<DelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument());
      await userEvent.clear(input);
      await userEvent.type(input, VALID_ADDRESS);
      await waitFor(() => expect(screen.queryByText("Invalid Stellar address.")).not.toBeInTheDocument());
    });

    it("does not show error before the user has interacted with the input", () => {
      render(<DelegateModal {...defaultProps} />);
      expect(screen.queryByText("Invalid Stellar address.")).not.toBeInTheDocument();
      expect(screen.queryByText("Address is required.")).not.toBeInTheDocument();
    });

    it("applies red border class when address is invalid after blur", async () => {
      render(<DelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(input.className).toContain("border-red-400");
      });
    });

    it("does not apply red border when address is valid", async () => {
      render(<DelegateModal {...defaultProps} />);
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
      render(<DelegateModal {...defaultProps} />);
      const form = screen.getByRole("button", { name: /delegate$/i }).closest("form")!;
      fireEvent.submit(form);
      await waitFor(() => {
        expect(screen.getByText("Address is required.")).toBeInTheDocument();
      });
    });

    it("blocks submit and shows error when address is invalid", async () => {
      render(<DelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "GBADADDRESS");
      const form = input.closest("form")!;
      fireEvent.submit(form);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("submit button is disabled while there is a validation error", async () => {
      render(<DelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /delegate$/i });
        expect(btn).toBeDisabled();
      });
    });

    it("submit button is enabled when a valid address is entered", async () => {
      render(<DelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, VALID_ADDRESS);
      const btn = screen.getByRole("button", { name: /delegate$/i });
      expect(btn).not.toBeDisabled();
    });
  });

  describe("delegate-to-myself shortcut", () => {
    it("fills the input with the connected wallet address", async () => {
      render(<DelegateModal {...defaultProps} />);
      const selfBtn = screen.getByRole("button", { name: /delegate to myself/i });
      await userEvent.click(selfBtn);
      const input = screen.getByPlaceholderText("Stellar address (G...)") as HTMLInputElement;
      expect(input.value).toBe(VALID_ADDRESS_2);
    });

    it("clears any existing validation error when self-fill is used", async () => {
      render(<DelegateModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("Stellar address (G...)");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument());
      const selfBtn = screen.getByRole("button", { name: /delegate to myself/i });
      await userEvent.click(selfBtn);
      await waitFor(() => expect(screen.queryByText("Invalid Stellar address.")).not.toBeInTheDocument());
    });
  });

  describe("cancel", () => {
    it("calls onClose when Cancel is clicked", async () => {
      const onClose = jest.fn();
      render(<DelegateModal {...defaultProps} onClose={onClose} />);
      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
