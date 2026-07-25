mod report;
mod runner;
mod scenario;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};

use runner::SimulationRunner;
use scenario::Scenario;

#[derive(Parser)]
#[command(name = "nebgov-sim", about = "NebGov governance simulation harness")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run a single scenario file and write a JSON report.
    Run {
        #[arg(short, long)]
        scenario: PathBuf,
        #[arg(short, long, default_value = "report.json")]
        output: PathBuf,
        #[arg(long)]
        verbose: bool,
    },
    /// Run every `*.json` scenario in a directory.
    RunAll {
        #[arg(short, long, default_value = "tools/sim/src/scenarios")]
        scenarios_dir: PathBuf,
        #[arg(short, long, default_value = "tools/sim/reports")]
        output_dir: PathBuf,
    },
    /// Structurally validate a scenario file without running it.
    Validate { scenario: PathBuf },
    /// List built-in scenarios shipped under `tools/sim/src/scenarios/`.
    ListScenarios {
        #[arg(short, long, default_value = "tools/sim/src/scenarios")]
        scenarios_dir: PathBuf,
    },
}

fn main() {
    let cli = Cli::parse();

    match cli.command {
        Command::Run {
            scenario,
            output,
            verbose,
        } => run_one(&scenario, &output, verbose),
        Command::RunAll {
            scenarios_dir,
            output_dir,
        } => run_all(&scenarios_dir, &output_dir),
        Command::Validate { scenario } => validate(&scenario),
        Command::ListScenarios { scenarios_dir } => list_scenarios(&scenarios_dir),
    }
}

fn load_scenario(path: &Path) -> Scenario {
    match Scenario::from_file(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("failed to load scenario {}: {}", path.display(), e);
            std::process::exit(1);
        }
    }
}

fn run_one(scenario_path: &Path, output: &Path, verbose: bool) {
    let scenario = load_scenario(scenario_path);
    if let Err(e) = scenario.validate() {
        eprintln!("scenario '{}' is invalid: {}", scenario.name, e);
        std::process::exit(1);
    }

    println!("Running scenario '{}'...", scenario.name);
    let mut runner = SimulationRunner::new(&scenario);
    let _ = runner.run();
    runner.check_expect_errors();
    let report = runner.get_report().clone();

    print_summary(&report, verbose);
    write_report(&report, output);

    if report.failed_steps > 0 {
        std::process::exit(1);
    }
    if report.compute_budget_warnings.iter().any(|w| w.utilization_pct >= 100.0) {
        std::process::exit(1);
    }
}

fn run_all(scenarios_dir: &Path, output_dir: &Path) {
    let entries = match std::fs::read_dir(scenarios_dir) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("failed to read {}: {}", scenarios_dir.display(), e);
            std::process::exit(1);
        }
    };

    std::fs::create_dir_all(output_dir).ok();

    let mut any_failed = false;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let scenario = load_scenario(&path);
        if let Err(e) = scenario.validate() {
            eprintln!("scenario '{}' is invalid: {}", scenario.name, e);
            any_failed = true;
            continue;
        }

        println!("Running scenario '{}'...", scenario.name);
        let mut runner = SimulationRunner::new(&scenario);
        let _ = runner.run();
        runner.check_expect_errors();
        let report = runner.get_report().clone();

        print_summary(&report, false);
        if report.failed_steps > 0 || report.compute_budget_warnings.iter().any(|w| w.utilization_pct >= 100.0) {
            any_failed = true;
        }

        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("report");
        let out_path = output_dir.join(format!("{}.json", stem));
        write_report(&report, &out_path);
    }

    if any_failed {
        std::process::exit(1);
    }
}

fn validate(scenario_path: &Path) {
    let scenario = load_scenario(scenario_path);
    match scenario.validate() {
        Ok(()) => println!("scenario '{}' is valid ({} steps)", scenario.name, scenario.steps.len()),
        Err(e) => {
            eprintln!("scenario '{}' is invalid: {}", scenario.name, e);
            std::process::exit(1);
        }
    }
}

fn list_scenarios(scenarios_dir: &Path) {
    let entries = match std::fs::read_dir(scenarios_dir) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("failed to read {}: {}", scenarios_dir.display(), e);
            std::process::exit(1);
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match Scenario::from_file(&path) {
            Ok(s) => println!("{:<24} {} ({} steps)", path.file_name().unwrap().to_string_lossy(), s.description, s.steps.len()),
            Err(e) => println!("{:<24} <invalid: {}>", path.file_name().unwrap().to_string_lossy(), e),
        }
    }
}

fn print_summary(report: &report::SimulationReport, verbose: bool) {
    println!(
        "  {}/{} steps passed, final ledger {}",
        report.passed_steps, report.total_steps, report.final_ledger
    );
    if !report.compute_budget_warnings.is_empty() {
        println!("  {} compute budget warning(s)", report.compute_budget_warnings.len());
    }
    if !report.storage_warnings.is_empty() {
        println!("  {} storage warning(s)", report.storage_warnings.len());
    }
    if report.failed_steps > 0 {
        println!("  {} FAILED step(s):", report.failed_steps);
        for r in report.step_results.iter().filter(|r| !r.success && !r.anticipated_failure) {
            println!("    [{}] {}: {}", r.step_index, r.step_type, r.error.as_deref().unwrap_or("unknown error"));
        }
    } else if verbose {
        for r in &report.step_results {
            println!("    [{}] {} ok ({} cpu insns)", r.step_index, r.step_type, r.cpu_insns);
        }
    }
}

fn write_report(report: &report::SimulationReport, path: &Path) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    match serde_json::to_string_pretty(report) {
        Ok(json) => {
            if let Err(e) = std::fs::write(path, json) {
                eprintln!("failed to write report to {}: {}", path.display(), e);
            } else {
                println!("  report written to {}", path.display());
            }
        }
        Err(e) => eprintln!("failed to serialize report: {}", e),
    }
}
