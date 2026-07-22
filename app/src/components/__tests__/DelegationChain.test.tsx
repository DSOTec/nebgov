import React from "react";
import renderer from "react-test-renderer";
import { DelegationChain } from "../DelegationChain";

describe("DelegationChain", () => {
  it("shows a message when the chain is empty", () => {
    const tree = renderer.create(<DelegationChain chain={[]} />).toJSON();
    expect(JSON.stringify(tree)).toContain("No delegation chain found");
  });

  it("shows a not-delegating message for a single-element chain", () => {
    const tree = renderer
      .create(<DelegationChain chain={["GADDR1"]} />)
      .toJSON();
    expect(JSON.stringify(tree)).toContain("Not delegating to anyone else");
  });

  it("renders every address and an arrow between each hop", () => {
    const chain = ["GADDR1", "GADDR2", "GADDR3"];
    const tree = renderer.create(<DelegationChain chain={chain} />).toJSON();
    const serialized = JSON.stringify(tree);

    for (const address of chain) {
      expect(serialized).toContain(address);
    }
    expect((serialized.match(/→/g) ?? []).length).toBe(chain.length - 1);
  });
});
