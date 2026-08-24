import React from "react";
import renderer from "react-test-renderer";
import type { BondState } from "@nebgov/sdk";
import { BondStatusBadge } from "../BondStatusBadge";

const STATES: BondState[] = ["Locked", "Refunded", "Slashed"];

describe("BondStatusBadge", () => {
  it.each(STATES)("includes dark-mode colors for %s bonds", (state) => {
    const badge = renderer.create(<BondStatusBadge state={state} />).root.findByType("span");

    expect(badge.props.className).toMatch(/dark:bg-/);
    expect(badge.props.className).toMatch(/dark:text-/);
    expect(badge.props.className).toMatch(/dark:border-/);
  });
});
