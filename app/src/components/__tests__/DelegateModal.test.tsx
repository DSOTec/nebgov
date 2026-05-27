import React from "react";
import renderer from "react-test-renderer";

// Mock heavy deps that require browser/wallet APIs
jest.mock("@nebgov/sdk", () => ({
  VotesClient: jest.fn(),
}));

jest.mock("@stellar/stellar-sdk", () => ({
  Keypair: { fromSecret: jest.fn() },
}));

jest.mock("../../lib/wallet-context", () => ({
  useWallet: () => ({ isConnected: false, publicKey: null }),
}));

import { DelegateModal } from "../DelegateModal";

describe("DelegateModal", () => {
  it("renders nothing when closed", () => {
    const tree = renderer
      .create(<DelegateModal open={false} onClose={jest.fn()} />)
      .toJSON();
    expect(tree).toBeNull();
  });

  it("matches snapshot when open", () => {
    const tree = renderer
      .create(<DelegateModal open={true} onClose={jest.fn()} />)
      .toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("matches snapshot when open with prefill address", () => {
    const tree = renderer
      .create(
        <DelegateModal
          open={true}
          onClose={jest.fn()}
          prefillAddress="GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT"
        />
      )
      .toJSON();
    expect(tree).toMatchSnapshot();
  });
});
