/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateStreamModal } from "../CreateStreamModal";
import type { TreasuryClient } from "../../lib/treasury-client";

const VALID_ADDRESS = "GDOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNIB";
const VALID_ADDRESS_2 = "GD6HLZWRE5FHK3SDLZB3FH56R3H3ECAAYCPWWU7O7EK4FCNT2Z7S6D5I";

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

const mockCreateStream = jest.fn().mockResolvedValue(undefined);
const mockClient = {
  createStream: mockCreateStream,
} as unknown as TreasuryClient;

const defaultProps = {
  client: mockClient,
  signerPublicKey: VALID_ADDRESS_2,
  tokenAddress: "CTOKEN123",
  signUnsignedXdr: jest.fn().mockResolvedValue("signed_xdr"),
  onClose: jest.fn(),
  onCreated: jest.fn(),
};

function fillRequiredFields(except?: string) {
  if (except !== "name") {
    fireEvent.change(screen.getByPlaceholderText("engineering"), { target: { value: "dev" } });
  }
  if (except !== "owner") {
    fireEvent.change(screen.getByPlaceholderText("G..."), { target: { value: VALID_ADDRESS } });
  }
  if (except !== "totalAllocated") {
    fireEvent.change(screen.getByPlaceholderText("1000000"), { target: { value: "1000000" } });
  }
  if (except !== "maxSingleSpend") {
    fireEvent.change(screen.getByPlaceholderText("500000"), { target: { value: "500000" } });
  }
  if (except !== "startLedger") {
    fireEvent.change(screen.getByPlaceholderText("1"), { target: { value: "100" } });
  }
  if (except !== "endLedger") {
    fireEvent.change(screen.getByPlaceholderText("100000"), { target: { value: "200000" } });
  }
}

describe("CreateStreamModal — Stellar address validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders the owner address input", () => {
      render(<CreateStreamModal {...defaultProps} />);
      expect(screen.getByPlaceholderText("G...")).toBeInTheDocument();
    });

    it("renders the Owner Address label", () => {
      render(<CreateStreamModal {...defaultProps} />);
      expect(screen.getByText("Owner Address")).toBeInTheDocument();
    });

    it("renders the Create Stream submit button", () => {
      render(<CreateStreamModal {...defaultProps} />);
      expect(screen.getByRole("button", { name: /create stream/i })).toBeInTheDocument();
    });

    it("submit button is enabled by default (no pre-validation)", () => {
      render(<CreateStreamModal {...defaultProps} />);
      const btn = screen.getByRole("button", { name: /create stream/i });
      expect(btn).not.toBeDisabled();
    });
  });

  describe("blur validation", () => {
    it("shows error on blur when owner address is invalid", async () => {
      render(<CreateStreamModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "GBADADDRESS");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("shows error on blur for lowercase address", async () => {
      render(<CreateStreamModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, VALID_ADDRESS.toLowerCase());
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("shows error on blur for address with wrong prefix", async () => {
      render(<CreateStreamModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "SDOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNIB");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
    });

    it("does not show error on blur when address is valid", async () => {
      render(<CreateStreamModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, VALID_ADDRESS);
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.queryByText("Invalid Stellar address.")).not.toBeInTheDocument();
      });
    });

    it("does not show error on blur when field is empty (required handled by toast)", async () => {
      render(<CreateStreamModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.queryByText("Invalid Stellar address.")).not.toBeInTheDocument();
      });
    });

    it("clears error when user types a valid address after an invalid one", async () => {
      render(<CreateStreamModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument());
      await userEvent.clear(input);
      await userEvent.type(input, VALID_ADDRESS);
      await waitFor(() => expect(screen.queryByText("Invalid Stellar address.")).not.toBeInTheDocument());
    });

    it("applies red border when address is invalid after blur", async () => {
      render(<CreateStreamModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => {
        expect(input.className).toContain("border-red-400");
      });
    });

    it("does not apply red border when address is valid", async () => {
      render(<CreateStreamModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, VALID_ADDRESS);
      fireEvent.blur(input);
      await waitFor(() => {
        expect(input.className).not.toContain("border-red-400");
      });
    });
  });

  describe("submit validation", () => {
    it("blocks submit and shows error when owner address is invalid", async () => {
      render(<CreateStreamModal {...defaultProps} />);
      fillRequiredFields("owner");
      fireEvent.change(screen.getByPlaceholderText("G..."), { target: { value: "GBADADDRESS" } });
      const form = screen.getByRole("button", { name: /create stream/i }).closest("form")!;
      fireEvent.submit(form);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
      expect(mockCreateStream).not.toHaveBeenCalled();
    });

    it("blocks submit when owner address has wrong prefix", async () => {
      render(<CreateStreamModal {...defaultProps} />);
      fillRequiredFields("owner");
      fireEvent.change(screen.getByPlaceholderText("G..."), {
        target: { value: "ADOOXICJPSOZDQRCEHZPR6MAX5PUZXVWGJ3QPVEU4DADIZQ4YBQOJNIB" },
      });
      const form = screen.getByRole("button", { name: /create stream/i }).closest("form")!;
      fireEvent.submit(form);
      await waitFor(() => {
        expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument();
      });
      expect(mockCreateStream).not.toHaveBeenCalled();
    });

    it("submit button is disabled while there is a validation error", async () => {
      render(<CreateStreamModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /create stream/i });
        expect(btn).toBeDisabled();
      });
    });

    it("submit button is re-enabled after error is cleared", async () => {
      render(<CreateStreamModal {...defaultProps} />);
      const input = screen.getByPlaceholderText("G...");
      await userEvent.type(input, "GBAD");
      fireEvent.blur(input);
      await waitFor(() => expect(screen.getByText("Invalid Stellar address.")).toBeInTheDocument());
      await userEvent.clear(input);
      await userEvent.type(input, VALID_ADDRESS);
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /create stream/i });
        expect(btn).not.toBeDisabled();
      });
    });
  });

  describe("cancel", () => {
    it("calls onClose when Cancel is clicked", async () => {
      const onClose = jest.fn();
      render(<CreateStreamModal {...defaultProps} onClose={onClose} />);
      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
