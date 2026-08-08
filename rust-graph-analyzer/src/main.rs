use clap::{Parser, Subcommand};
use memmap2::MmapOptions;
use rkyv::Archived;
use rust_graph_types::CsrGraph;
use serde::Serialize;
use std::fs::File;
use std::time::Instant;

mod lcc;
mod ifub;
mod top_paths;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// Path to the graph file
    #[arg(short, long, default_value = "/app/graph.rkyv")]
    graph_path: String,
}

#[derive(Subcommand)]
enum Commands {
    /// Find Largest Connected Component
    Lcc,
    /// Run iFUB for Exact Diameter
    Ifub,
    /// Approximate highest distinct shortest-path count pairs
    TopPaths {
        /// Number of candidate source/sink nodes to sample
        #[arg(short, long, default_value_t = 20)]
        candidates: usize,
    },
}

#[derive(Serialize)]
struct OutputMetrics {
    algorithm: String,
    time_ms: u128,
    result: serde_json::Value,
}

fn load_graph(path: &str) -> std::io::Result<memmap2::Mmap> {
    let file = File::open(path)?;
    let mmap = unsafe { MmapOptions::new().map(&file)? };
    #[cfg(target_os = "linux")]
    unsafe { libc::madvise(mmap.as_ptr() as *mut libc::c_void, mmap.len(), libc::MADV_WILLNEED); }
    Ok(mmap)
}

fn main() {
    let cli = Cli::parse();
    
    eprintln!("Loading graph from {}...", cli.graph_path);
    let start_load = Instant::now();
    let mmap = load_graph(&cli.graph_path).expect("Failed to load graph file");
    let archived_graph = unsafe { rkyv::access_unchecked::<Archived<CsrGraph>>(&mmap) };
    eprintln!("Graph loaded in {}ms", start_load.elapsed().as_millis());

    let start_algo = Instant::now();
    let (algo_name, result_json) = match &cli.command {
        Commands::Lcc => {
            ("lcc", lcc::run(archived_graph))
        }
        Commands::Ifub => {
            ("ifub", ifub::run(archived_graph))
        }
        Commands::TopPaths { candidates } => {
            ("top_paths", top_paths::run(archived_graph, *candidates))
        }
    };
    let time_ms = start_algo.elapsed().as_millis();

    let output = OutputMetrics {
        algorithm: algo_name.to_string(),
        time_ms,
        result: result_json,
    };

    println!("{}", serde_json::to_string(&output).unwrap());
}
