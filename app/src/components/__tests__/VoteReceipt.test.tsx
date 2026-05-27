import React from "react";
import renderer from "react-test-renderer";
import { VoteSupport } from "@nebgov/sdk";
import { VoteReceipt } from "../VoteReceipt";

describe("VoteReceipt", () => {
  it("matches snapshot for For vote", () => {
    const tree = renderer
      .create(<VoteReceipt support={VoteSupport.For} weight={500_0000000n} />)
      .toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("matches snapshot for Against vote", () => {
    const tree = renderer
      .create(<VoteReceipt support={VoteSupport.Against} weight={300_0000000n} />)
      .toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("matches snapshot for Abstain vote", () => {
    const tree = renderer
      .create(<VoteReceipt support={VoteSupport.Abstain} weight={100_0000000n} />)
      .toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("matches snapshot with reason string", () => {
    const tree = renderer
      .create(
        <VoteReceipt
          support={VoteSupport.For}
          weight={500_0000000n}
          reason="This proposal aligns with our governance goals."
        />
      )
      .toJSON();
    expect(tree).toMatchSnapshot();
  });
});
