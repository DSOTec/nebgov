import { test, expect } from "@playwright/test";
import { ProposalState, VoteSupport, hashDescription } from "@nebgov/sdk";
import { createSdkClients, hasE2eEnv, createSigner, createGovernorConfig } from "./helpers/sdk";
import { mockWalletConnection } from "./helpers/wallet";

const testIfConfigured = hasE2eEnv() ? test : test.skip;

testIfConfigured.describe("Full Governance Lifecycle (testnet)", () => {
  let signer: ReturnType<typeof createSigner>;
  let config: ReturnType<typeof createGovernorConfig>;
  let governor: ReturnType<typeof createSdkClients>["governor"];
  let proposalId: bigint;

  test.beforeAll(() => {
    const clients = createSdkClients();
    signer = clients.signer;
    config = clients.config;
    governor = clients.governor;
  });

  test("1. Create a proposal via SDK and verify Pending state in the UI", async ({ page }) => {
    const description = `E2E Lifecycle Test Proposal

This proposal was created by the end-to-end governance lifecycle test.
It demonstrates the full proposal lifecycle on Soroban testnet.`;

    const descriptionHash = await hashDescription(description);
    const targets = [config.governorAddress];
    const fnNames: string[] = ["proposal_count"];
    const calldatas: Uint8Array[] = [new Uint8Array(0)];

    proposalId = await governor.propose(
      signer,
      description,
      descriptionHash,
      "",
      targets,
      fnNames,
      calldatas,
    );

    expect(proposalId).toBeGreaterThan(0n);

    await mockWalletConnection(page, signer);
    await page.goto("/");
    await expect(page.locator(`a[href="/proposal/${proposalId}"]`).first()).toBeVisible();

    await page.goto(`/proposal/${proposalId}`);
    await expect(page.getByText("Pending").first()).toBeVisible();
  });

  test("2. Wait for Active, cast Vote For, and verify Succeeded state", async ({ page }) => {
    await mockWalletConnection(page, signer);

    await governor.waitForProposalState(proposalId, ProposalState.Active);

    await page.goto(`/proposal/${proposalId}`);
    await expect(page.getByText("Active").first()).toBeVisible();

    await governor.castVote(signer, proposalId, VoteSupport.For);

    await governor.waitForProposalState(proposalId, ProposalState.Succeeded);

    await page.goto(`/proposal/${proposalId}`);
    await expect(page.getByText("Succeeded").first()).toBeVisible();
  });

  test("3. Queue and verify Queued state in the UI", async ({ page }) => {
    await mockWalletConnection(page, signer);

    await governor.queue(signer, proposalId);

    const state = await governor.getProposalState(proposalId);
    expect(state).toBe(ProposalState.Queued);

    await page.goto(`/proposal/${proposalId}`);
    await expect(page.getByText("Queued").first()).toBeVisible();
    await expect(page.getByText("Veto Window Open").first()).toBeVisible();
  });

  test("4. Execute and verify Executed state in the UI", async ({ page }) => {
    await mockWalletConnection(page, signer);

    await governor.execute(signer, proposalId);

    const state = await governor.getProposalState(proposalId);
    expect(state).toBe(ProposalState.Executed);

    await page.goto(`/proposal/${proposalId}`);
    await expect(page.getByText("Executed").first()).toBeVisible();
  });
});
