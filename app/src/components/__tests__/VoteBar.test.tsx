import React from "react";
import renderer from "react-test-renderer";
import { VoteBar } from "../VoteBar";

describe("VoteBar", () => {
  it("matches snapshot with all-for votes", () => {
    const tree = renderer
      .create(<VoteBar votesFor={1000_0000000n} votesAgainst={0n} votesAbstain={0n} />)
      .toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("matches snapshot with all-against votes", () => {
    const tree = renderer
      .create(<VoteBar votesFor={0n} votesAgainst={500_0000000n} votesAbstain={0n} />)
      .toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("matches snapshot with mixed votes", () => {
    const tree = renderer
      .create(
        <VoteBar
          votesFor={600_0000000n}
          votesAgainst={300_0000000n}
          votesAbstain={100_0000000n}
        />
      )
      .toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("matches snapshot with zero votes", () => {
    const tree = renderer
      .create(<VoteBar votesFor={0n} votesAgainst={0n} votesAbstain={0n} />)
      .toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("matches snapshot with abstain-heavy votes", () => {
    const tree = renderer
      .create(
        <VoteBar
          votesFor={100_0000000n}
          votesAgainst={100_0000000n}
          votesAbstain={800_0000000n}
        />
      )
      .toJSON();
    expect(tree).toMatchSnapshot();
  });
});
