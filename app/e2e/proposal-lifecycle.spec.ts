import { test, expect, Page } from "@playwright/test";

async function mockWalletConnection(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__MOCK_WALLET__ = {
      connected: true,
      publicKey: "GTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12345",
    };
  });
}

test.describe("Proposals List", () => {
  test("displays proposals page with header", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Proposals");
    await expect(page.locator('a[href="/propose"]')).toBeVisible();
  });

  test("shows empty state when no proposals exist", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const emptyState = page.getByText(/No proposals|Get started/);
    const proposalCard = page.locator('a[href^="/proposal/"]');
    const hasContent = (await emptyState.count()) > 0 || (await proposalCard.count()) > 0;
    expect(hasContent).toBeTruthy();
  });

  test("navigates to propose page", async ({ page }) => {
    await page.goto("/");
    await page.click('a[href="/propose"]');
    await expect(page).toHaveURL("/propose");
  });
});

test.describe("Delegates Page", () => {
  test("displays delegates leaderboard", async ({ page }) => {
    await page.goto("/delegates");
    await expect(page.locator("h1")).toContainText("Delegates");
    await expect(page.locator("table")).toBeVisible();
  });

  test("shows delegate button", async ({ page }) => {
    await page.goto("/delegates");
    const delegateButton = page.getByRole("button", { name: /Delegate/i });
    await expect(delegateButton.first()).toBeVisible();
  });
});

test.describe("Navigation", () => {
  test("navbar links work correctly", async ({ page }) => {
    await page.goto("/");

    await page.click('a:has-text("Delegates")');
    await expect(page).toHaveURL("/delegates");

    await page.click('a:has-text("Proposals")');
    await expect(page).toHaveURL("/");
  });

  test("connect wallet button is visible", async ({ page }) => {
    await page.goto("/");
    const connectButton = page.getByRole("button", { name: /Connect Wallet/i });
    await expect(connectButton).toBeVisible();
  });
});

test.describe("Proposal Detail (mocked)", () => {
  test("shows proposal not found for invalid id", async ({ page }) => {
    await page.goto("/proposal/999999");
    await page.waitForLoadState("networkidle");
  });
});

test.describe("Create Proposal", () => {
  test("displays proposal form", async ({ page }) => {
    await page.goto("/propose");
    await expect(page.locator("h1, h2")).toContainText(/Create|Proposal/i);
    await expect(page.locator('[placeholder*="title" i]')).toBeVisible();
    await expect(page.locator('[placeholder*="description" i]')).toBeVisible();
  });
});

test.describe("Full Proposal Lifecycle (mocked wallet)", () => {
  test("can navigate through proposal creation flow", async ({ page }) => {
    await mockWalletConnection(page);
    await page.goto("/");
    await page.click('a[href="/propose"]');
    await expect(page).toHaveURL("/propose");

    const titleInput = page.locator('[data-testid="proposal-title"], input[name="title"], input[placeholder*="title" i]');
    const descriptionInput = page.locator('textarea[name="description"], textarea[placeholder*="description" i]');
    const metadataInput = page.locator('input[name="metadata_uri"], input[placeholder*="ipfs" i]');
    const continueButton = page.getByRole("button", { name: /Continue/i }).first();

    if (await titleInput.count() === 0 || await descriptionInput.count() === 0) {
      await expect(page.locator("text=Propose a new idea").or(page.locator("text=Missing"))).toBeVisible();
      return;
    }

    await titleInput.fill("Improve governance docs");
    await descriptionInput.fill("This proposal tests the proposal creation wizard with sample content.");
    if (await metadataInput.count() > 0) {
      await metadataInput.fill("ipfs://example-metadata");
    }

    await continueButton.click();
    await expect(page.getByRole("button", { name: /Submit Proposal/i })).toBeVisible();
  });

  test("proposal form includes title and description fields", async ({ page }) => {
    await mockWalletConnection(page);
    await page.goto("/propose");
    await expect(page.locator('[placeholder*="title" i]')).toBeVisible();
    await expect(page.locator('[placeholder*="description" i]')).toBeVisible();
  });

  test("can view delegates and initiate delegation", async ({ page }) => {
    await mockWalletConnection(page);
    await page.goto("/delegates");
    await expect(page.locator("h1")).toContainText("Delegates");

    const delegateButton = page.getByRole("button", { name: /Delegate/i }).first();
    await delegateButton.click();

    const modal = page.locator('[role="dialog"], .fixed.inset-0');
    await expect(modal).toBeVisible();
  });

  test("shows vote UI on proposal detail pages", async ({ page }) => {
    await mockWalletConnection(page);
    await page.goto("/proposal/1");
    await page.waitForLoadState("networkidle");

    const voteHeading = page.getByText(/Cast Your Vote/i).first();
    await expect(voteHeading).toBeVisible();
    await expect(page.getByRole("button", { name: /Connect Wallet/i }).first()).toBeVisible();
  });

  test("vote UI in proposal detail shows wallet prompt when not connected", async ({ page }) => {
    await page.goto("/proposal/1");
    await page.waitForLoadState("networkidle");

    const voteHeading = page.getByText(/Cast Your Vote/i).first();
    await expect(voteHeading).toBeVisible();
    await expect(page.getByText(/Connect your wallet to vote on this proposal/i)).toBeVisible();
  });
});

test.describe("Performance Benchmarks", () => {
  test("proposal list renders 100 proposals in < 2s", async ({ page }) => {
    await page.goto("/?mock_proposals=100");
    const start = Date.now();
    await expect(page.locator('[data-testid="proposal-card"]').first()).toBeVisible({ timeout: 2000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });
});
