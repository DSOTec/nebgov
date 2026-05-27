use crate::{Checkpoint, TokenVotesContract};
use soroban_sdk::Env;

const SOROBAN_CPU_LIMIT: u64 = 100_000_000;

fn build_checkpoints(env: &Env, count: usize) -> soroban_sdk::Vec<Checkpoint> {
    let mut checkpoints = soroban_sdk::Vec::new(env);
    for i in 1..=count {
        checkpoints.push_back(Checkpoint {
            ledger: i as u32,
            votes: (i as i128) * 10,
            weighted_sum: (i as i128) * 10 * (i as i128),
        });
    }
    checkpoints
}

fn sample_ledgers(max_ledger: u32) -> [u32; 5] {
    [
        1,
        max_ledger / 4,
        max_ledger / 2,
        (max_ledger * 3) / 4,
        max_ledger,
    ]
}

fn measure_query(checkpoints: &soroban_sdk::Vec<Checkpoint>, ledger: u32) -> (i128, u64) {
    let env = checkpoints.env();
    let mut budget = env.cost_estimate().budget();
    budget.reset_default();
    let result = TokenVotesContract::binary_search(checkpoints, ledger);
    (result.votes, budget.cpu_instruction_cost())
}

fn run_scale_case(count: usize) -> u64 {
    let env = Env::default();
    env.mock_all_auths();
    let checkpoints = build_checkpoints(&env, count);
    let mut max_cpu = 0u64;

    for ledger in sample_ledgers(count as u32) {
        let (votes, cpu) = measure_query(&checkpoints, ledger);
        assert_eq!(votes, (ledger as i128) * 10);
        max_cpu = max_cpu.max(cpu);
    }

    assert!(
        max_cpu < SOROBAN_CPU_LIMIT,
        "binary search exceeded Soroban budget for {} checkpoints: {}",
        count,
        max_cpu
    );
    max_cpu
}

#[test]
fn test_cast_vote_with_1000_checkpoints_within_budget() {
    let max_100 = run_scale_case(100);
    let max_500 = run_scale_case(500);
    let max_1000 = run_scale_case(1000);

    assert!(
        max_500 >= max_100,
        "500 checkpoint case should not be faster than 100"
    );
    assert!(
        max_1000 >= max_500,
        "1000 checkpoint case should not be faster than 500"
    );
}

#[test]
fn test_binary_search_edge_cases() {
    let env = Env::default();
    env.mock_all_auths();

    // Multi-checkpoint edge cases.
    let checkpoints = build_checkpoints(&env, 1000);
    let edge_cases = [
        (100, 1000),   // exact checkpoint ledger
        (0, 0),        // before first checkpoint
        (2500, 10000), // after last checkpoint
    ];

    for (ledger, expected_votes) in edge_cases {
        let (votes, cpu) = measure_query(&checkpoints, ledger);
        assert_eq!(votes, expected_votes);
        assert!(cpu < SOROBAN_CPU_LIMIT);
    }

    // Single-checkpoint edge case.
    let mut single = soroban_sdk::Vec::new(&env);
    single.push_back(Checkpoint {
        ledger: 42,
        votes: 777,
        weighted_sum: 42 * 777,
    });

    let (before_votes, _) = measure_query(&single, 41);
    let (exact_votes, _) = measure_query(&single, 42);
    let (after_votes, _) = measure_query(&single, 43);
    assert_eq!(before_votes, 0);
    assert_eq!(exact_votes, 777);
    assert_eq!(after_votes, 777);
}
