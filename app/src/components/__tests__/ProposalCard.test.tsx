import React from "react";
import renderer from "react-test-renderer";
import { ProposalState } from "@nebgov/sdk";
import { ProposalCard } from "../ProposalCard";

const BASE_PROPS = {
  id: 1n,
  description: "Transfer 1000 NEB to treasury",
  votesFor: 750_0000000n,
  votesAgainst: 250_0000000n,
};

const STATES: ProposalState[] = [
  ProposalState.Pending,
  ProposalState.Active,
  ProposalState.Succeeded,
  ProposalState.Defeated,
  ProposalState.Queued,
  ProposalState.Executed,
  ProposalState.Cancelled,
];

describe("ProposalCard", () => {
  it.each(STATES)("matches snapshot for state %s", (state) => {
    const tree = renderer
      .create(<ProposalCard {...BASE_PROPS} state={state} />)
      .toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("matches snapshot with long description", () => {
    const tree = renderer
      .create(
        <ProposalCard
          {...BASE_PROPS}
          state={ProposalState.Active}
          description={"A".repeat(200)}
        />
      )
      .toJSON();
    expect(tree).toMatchSnapshot();
  });
});
