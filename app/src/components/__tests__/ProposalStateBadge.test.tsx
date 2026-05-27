import React from "react";
import renderer from "react-test-renderer";
import { ProposalState } from "@nebgov/sdk";
import { ProposalStateBadge } from "../ProposalStateBadge";

const STATES = [
  ProposalState.Pending,
  ProposalState.Active,
  ProposalState.Succeeded,
  ProposalState.Defeated,
  ProposalState.Queued,
  ProposalState.Executed,
  ProposalState.Cancelled,
  ProposalState.Expired,
];

describe("ProposalStateBadge", () => {
  it.each(STATES)("matches snapshot for state %s", (state) => {
    const tree = renderer.create(<ProposalStateBadge state={state} />).toJSON();
    expect(tree).toMatchSnapshot();
  });
});
