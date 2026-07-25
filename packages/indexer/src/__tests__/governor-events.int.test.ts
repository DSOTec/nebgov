import { SorobanRpc, nativeToScVal } from "@stellar/stellar-sdk";
import { initDb, pool } from "../db";
import { processEvents } from "../events";

class FakeServer {
  constructor(private events: SorobanRpc.Api.EventResponse[]) {}
  async getEvents() {
    return { events: this.events };
  }
}

function makeEvent(params: {
  contractId: string;
  ledger: number;
  type: string;
  topicArgs?: any[];
  value: unknown;
}): SorobanRpc.Api.EventResponse {
  const topic = [
    nativeToScVal(params.type, { type: "symbol" }),
    ...(params.topicArgs ?? []).map((a) => nativeToScVal(a, { type: "symbol" })),
  ];
  const value = nativeToScVal(params.value);
  return {
    type: "contract",
    ledger: params.ledger,
    contractId: params.contractId as any,
    topic,
    value,
  } as any;
}

describe("governor event indexing (integration)", () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    it.skip("DATABASE_URL not set", () => undefined);
    return;
  }

  const GOVERNOR = "CGOVERNORTESTADDRESS00000000000000000000000000000000000000";

  beforeAll(async () => {
    await initDb();
    await pool.query("DELETE FROM config_updates");
    await pool.query("DELETE FROM governor_upgrades");
    try {
      await pool.query("DELETE FROM proposer_reputation");
    } catch {
      // Table may not exist if migration hasn't run
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("indexes ConfigUpdated event into config_updates", async () => {
    const configUpdated = makeEvent({
      contractId: GOVERNOR,
      ledger: 200,
      type: "ConfigUpdated",
      value: {
        old_settings: {
          voting_delay: 1,
          voting_period: 2,
          quorum_numerator: 30,
          proposal_threshold: 1000n,
          guardian: "GOLDGUARDIAN1111111111111111111111111111",
          proposal_grace_period: 3,
        },
        new_settings: {
          voting_delay: 2,
          voting_period: 3,
          quorum_numerator: 35,
          proposal_threshold: 2000n,
          guardian: "GNEWGUARDIAN111111111111111111111111111",
          proposal_grace_period: 4,
        },
      },
    });

    const server = new FakeServer([configUpdated]) as unknown as SorobanRpc.Server;
    const latest = await processEvents(
      server,
      { rpcUrl: "http://fake", governorAddress: GOVERNOR, pollIntervalMs: 1 },
      1,
    );

    expect(latest).toBe(200);

    const rows = await pool.query(
      "SELECT ledger, new_settings FROM config_updates ORDER BY id DESC LIMIT 1",
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].ledger).toBe(200);
    const settings = rows.rows[0].new_settings;
    expect(settings.voting_delay).toBe(2);
    expect(settings.voting_period).toBe(3);
    expect(settings.quorum_numerator).toBe(35);
  });

  it("indexes GovernorUpgraded event into governor_upgrades", async () => {
    const newHashBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      newHashBytes[i] = i;
    }

    const upgraded = makeEvent({
      contractId: GOVERNOR,
      ledger: 201,
      type: "GovernorUpgraded",
      value: {
        old_hash: new Uint8Array([0, 1, 2]),
        new_hash: newHashBytes,
      },
    });

    const server = new FakeServer([upgraded]) as unknown as SorobanRpc.Server;
    const latest = await processEvents(
      server,
      { rpcUrl: "http://fake", governorAddress: GOVERNOR, pollIntervalMs: 1 },
      1,
    );

    expect(latest).toBe(201);

    const rows = await pool.query(
      "SELECT ledger, new_wasm_hash FROM governor_upgrades ORDER BY id DESC LIMIT 1",
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].ledger).toBe(201);
    expect(rows.rows[0].new_wasm_hash).toBe(
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    );
  });

  it("indexes legacy config_updated short-form event", async () => {
    const configUpdatedLegacy = makeEvent({
      contractId: GOVERNOR,
      ledger: 202,
      type: "config_updated",
      topicArgs: [],
      value: {
        new_settings: {
          voting_delay: 3,
          voting_period: 4,
          quorum_numerator: 40,
          proposal_threshold: 3000n,
          guardian: "GLEGACYGUARDIAN1111111111111111111111111",
          proposal_grace_period: 5,
        },
      },
    });

    const server = new FakeServer([configUpdatedLegacy]) as unknown as SorobanRpc.Server;
    const latest = await processEvents(
      server,
      { rpcUrl: "http://fake", governorAddress: GOVERNOR, pollIntervalMs: 1 },
      1,
    );

    expect(latest).toBe(202);

    const rows = await pool.query(
      "SELECT new_settings FROM config_updates WHERE ledger = 202 ORDER BY id DESC LIMIT 1",
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].new_settings.voting_delay).toBe(3);
  });

  it("indexes legacy upgraded short-form event", async () => {
    const upgradedLegacy = makeEvent({
      contractId: GOVERNOR,
      ledger: 203,
      type: "upgraded",
      value: {
        new_hash: new Uint8Array([255, 254, 253]),
      },
    });

    const server = new FakeServer([upgradedLegacy]) as unknown as SorobanRpc.Server;
    const latest = await processEvents(
      server,
      { rpcUrl: "http://fake", governorAddress: GOVERNOR, pollIntervalMs: 1 },
      1,
    );

    expect(latest).toBe(203);

    const rows = await pool.query(
      "SELECT new_wasm_hash FROM governor_upgrades WHERE ledger = 203 ORDER BY id DESC LIMIT 1",
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].new_wasm_hash).toBe("fffefdj");
  });

  it("includes treasuryAddress in contractIds when configured", async () => {
    const TREASURY = "CTREASURYTESTADDRESS000000000000000000000000000000000000";
    let capturedContractIds: string[] = [];

    class ServerWithCapture {
      async getEvents(opts: any) {
        capturedContractIds = opts.filters[0].contractIds;
        return { events: [] };
      }
    }

    const server = new ServerWithCapture() as unknown as SorobanRpc.Server;
    await processEvents(
      server,
      {
        rpcUrl: "http://fake",
        governorAddress: GOVERNOR,
        treasuryAddress: TREASURY,
        pollIntervalMs: 1,
      },
      1,
    );

    expect(capturedContractIds).toContain(GOVERNOR);
    expect(capturedContractIds).toContain(TREASURY);
  });

  it("indexes ReputationUpdated event into proposer_reputation", async () => {
    const proposer = "GPROPOSER111111111111111111111111111111111";
    const reputationUpdated = makeEvent({
      contractId: GOVERNOR,
      ledger: 204,
      type: "ReputationUpdated",
      topicArgs: [proposer],
      value: {
        old_score: 100n,
        new_score: 150n,
        reason: "active_proposal_passed",
      },
    });

    const server = new FakeServer([reputationUpdated]) as unknown as SorobanRpc.Server;
    const latest = await processEvents(
      server,
      { rpcUrl: "http://fake", governorAddress: GOVERNOR, pollIntervalMs: 1 },
      1,
    );

    expect(latest).toBe(204);

    const rows = await pool.query(
      "SELECT proposer, old_score, new_score, reason FROM proposer_reputation WHERE ledger = 204",
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].proposer).toBe(proposer);
    expect(rows.rows[0].old_score).toBe(100);
    expect(rows.rows[0].new_score).toBe(150);
    expect(rows.rows[0].reason).toBe("active_proposal_passed");
  });
});