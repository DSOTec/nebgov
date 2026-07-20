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

  it.each(STATES)("renders a non-empty badge for state %s", (state) => {
    const tree = renderer.create(<ProposalStateBadge state={state} />).toJSON();
    expect(tree).toBeTruthy();
    expect(tree).toHaveProperty("type", "span");
    expect(tree).toHaveProperty("children");
    const json = Array.isArray(tree) ? tree[0] : tree;
    expect(Array.isArray(json?.children)).toBe(true);
    expect((json?.children as unknown[]).length).toBeGreaterThan(0);
  });
});
