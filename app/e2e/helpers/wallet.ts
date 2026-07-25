import { type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";

export async function mockWalletConnection(page: Page, keypair: Keypair) {
  const publicKey = keypair.publicKey();

  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__E2E_MOCK_WALLET__ = {
      connected: true,
      publicKey,
      address: `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}`,
    };
  });
}
