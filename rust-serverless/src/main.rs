use actix_web::{get, web, App, HttpServer, Responder, HttpResponse};
use actix_cors::Cors;
use env_logger;
use memmap2::Mmap;
use once_cell::sync::Lazy; // Import Lazy
use rayon::prelude::*;
use rkyv::rend::u32_le;
use rkyv::{access, rancor, Archive, Deserialize, Serialize};
use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};
use std::collections::HashMap;
use std::fs::File;

#[derive(Archive, Serialize, Deserialize, Debug, PartialEq)]
struct CsrGraph {
    offsets: Vec<u32>,
    edges: Vec<u32>,
    reverse_offsets: Vec<u32>,
    reverse_edges: Vec<u32>,
    page_id_to_index: HashMap<u32, u32>,
    index_to_page_id: HashMap<u32, u32>,
}

// Define a global static variable for the graph.
// It will be initialized exactly once, on the first time it's accessed.
static GRAPH: Lazy<&'static ArchivedCsrGraph> = Lazy::new(|| {
    log::info!("Lazily loading graph data for static access...");

    let file = File::open("graph.rkyv").expect("Failed to open graph.rkyv");
    // SAFETY: The file is trusted and not modified elsewhere.
    let mmap = unsafe { Mmap::map(&file).expect("Failed to memory-map the file.") };

    // Leak the mmap to get a 'static lifetime.
    let mmap_static: &'static [u8] = Box::leak(Box::new(mmap));

    // Use `access` for validation. Panics on failure, which is common for lazy_static.
    // For production, you might want more graceful error handling.
    access::<ArchivedCsrGraph, rancor::Error>(mmap_static).expect("Failed to validate archived graph.")
});


struct AppState {
    graph: &'static ArchivedCsrGraph,
}

fn reconstruct_paths(
    node: u32,
    start_node: u32,
    parents: &FxHashMap<u32, Vec<u32>>,
) -> Vec<Vec<u32>> {
    if node == start_node {
        return vec![vec![start_node]];
    }

    let mut paths = Vec::new();
    if let Some(parent_nodes) = parents.get(&node) {
        for &parent_node in parent_nodes {
            let parent_paths = reconstruct_paths(parent_node, start_node, parents);
            for mut path in parent_paths {
                path.push(node);
                paths.push(path);
            }
        }
    }
    paths
}

fn find_all_shortest_path(
    graph: &'static ArchivedCsrGraph,
    start_page_id: u32,
    end_page_id: u32,
) -> Vec<Vec<u32>> {
    let start_node = match graph.page_id_to_index.get(&u32_le::from_native(start_page_id)) {
        Some(id) => id.to_native(),
        None => return vec![],
    };
    let end_node = match graph.page_id_to_index.get(&u32_le::from_native(end_page_id)) {
        Some(id) => id.to_native(),
        None => return vec![],
    };

    if start_node == end_node {
        return vec![vec![start_page_id]];
    }

    // Use HashSets for frontiers for efficient lookups and to represent levels.
    let mut forward_frontier = FxHashSet::with_hasher(FxBuildHasher::default());
    forward_frontier.insert(start_node);
    let mut backward_frontier = FxHashSet::with_hasher(FxBuildHasher::default());
    backward_frontier.insert(end_node);

    // Visited maps store distances and parents.
    let mut forward_dist: FxHashMap<u32, u32> = FxHashMap::with_hasher(FxBuildHasher::default());
    forward_dist.insert(start_node, 0);
    let mut backward_dist: FxHashMap<u32, u32> = FxHashMap::with_hasher(FxBuildHasher::default());
    backward_dist.insert(end_node, 0);

    let mut forward_parents: FxHashMap<u32, Vec<u32>> = FxHashMap::with_hasher(FxBuildHasher::default());
    let mut backward_parents: FxHashMap<u32, Vec<u32>> = FxHashMap::with_hasher(FxBuildHasher::default());

    let mut meeting_nodes = FxHashSet::with_hasher(FxBuildHasher::default());
    let mut shortest_path_len = u32::MAX;
    let mut forward_depth = 0;
    let mut backward_depth = 0;

    while !forward_frontier.is_empty() && !backward_frontier.is_empty() {
        // Stop if we can't find a shorter path than we've already found.
        if forward_depth + backward_depth >= shortest_path_len {
            break;
        }

        // Python script trick: expand the frontier with fewer outgoing links.
        let forward_link_count: usize = forward_frontier.par_iter().map(|&u| {
            let start = graph.offsets[u as usize].to_native() as usize;
            let end = graph.offsets[(u + 1) as usize].to_native() as usize;
            end - start
        }).sum();
        let backward_link_count: usize = backward_frontier.par_iter().map(|&u| {
            let start = graph.reverse_offsets[u as usize].to_native() as usize;
            let end = graph.reverse_offsets[(u + 1) as usize].to_native() as usize;
            end - start
        }).sum();

        let expand_forward = forward_link_count <= backward_link_count;

        if expand_forward {
            forward_depth += 1;
            let mut next_frontier = FxHashSet::with_capacity_and_hasher(forward_frontier.len() * 5, FxBuildHasher::default());
            for &u in &forward_frontier {
                let start_offset = graph.offsets[u as usize].to_native() as usize;
                let end_offset = graph.offsets[(u + 1) as usize].to_native() as usize;
                for v_le in &graph.edges[start_offset..end_offset] {
                    let v = v_le.to_native();

                    if !forward_dist.contains_key(&v) {
                        forward_dist.insert(v, forward_depth);
                        forward_parents.insert(v, vec![u]);
                        next_frontier.insert(v);
                    } else if forward_dist[&v] == forward_depth {
                        forward_parents.get_mut(&v).unwrap().push(u);
                    }
                }
            }
            forward_frontier = next_frontier;

            // Check for intersections with the backward search's visited nodes.
            for &node in &forward_frontier {
                if let Some(&bwd_dist) = backward_dist.get(&node) {
                    let path_len = forward_depth + bwd_dist;
                    if path_len < shortest_path_len {
                        shortest_path_len = path_len;
                        meeting_nodes.clear();
                        meeting_nodes.insert(node);
                    } else if path_len == shortest_path_len {
                        meeting_nodes.insert(node);
                    }
                }
            }
        } else { // Expand backward
            backward_depth += 1;
            let mut next_frontier = FxHashSet::with_capacity_and_hasher(backward_frontier.len() * 5, FxBuildHasher::default());
            for &u in &backward_frontier {
                let start_offset = graph.reverse_offsets[u as usize].to_native() as usize;
                let end_offset = graph.reverse_offsets[(u + 1) as usize].to_native() as usize;
                for v_le in &graph.reverse_edges[start_offset..end_offset] {
                    let v = v_le.to_native();

                    if !backward_dist.contains_key(&v) {
                        backward_dist.insert(v, backward_depth);
                        backward_parents.insert(v, vec![u]);
                        next_frontier.insert(v);
                    } else if backward_dist[&v] == backward_depth {
                        backward_parents.get_mut(&v).unwrap().push(u);
                    }
                }
            }
            backward_frontier = next_frontier;

            // Check for intersections with the forward search's visited nodes.
            for &node in &backward_frontier {
                if let Some(&fwd_dist) = forward_dist.get(&node) {
                    let path_len = backward_depth + fwd_dist;
                    if path_len < shortest_path_len {
                        shortest_path_len = path_len;
                        meeting_nodes.clear();
                        meeting_nodes.insert(node);
                    } else if path_len == shortest_path_len {
                        meeting_nodes.insert(node);
                    }
                }
            }
        }
    }

    if meeting_nodes.is_empty() {
        return vec![];
    }

    let all_paths: FxHashSet<Vec<u32>> = meeting_nodes
        .par_iter()
        .flat_map(|&meet_node| {
            let forward_paths = reconstruct_paths(meet_node, start_node, &forward_parents);
            let backward_paths = reconstruct_paths(meet_node, end_node, &backward_parents);

            let mut combined_paths = Vec::with_capacity(forward_paths.len() * backward_paths.len());

            for f_path in &forward_paths {
                for b_path in &backward_paths {
                    let mut path = f_path.clone();
                    let mut reversed_b_path = b_path.clone();
                    reversed_b_path.reverse();
                    path.extend_from_slice(&reversed_b_path[1..]);
                    combined_paths.push(path);
                }
            }
            combined_paths
        })
        .collect();

    all_paths.into_par_iter().map(|path| {
        path.into_iter().map(|idx| graph.index_to_page_id.get(&u32_le::from_native(idx)).unwrap().to_native()).collect()
    }).collect()
}

#[get("/all-shortest-path/{from_page_id}/to/{to_page_id}")]
async fn all_shortest_path(
    state: web::Data<AppState>,
    path_params: web::Path<(u32, u32)>,
) -> impl Responder {
    let (from_page_id, to_page_id) = path_params.into_inner();

    let graph = state.graph;

    let start_time = std::time::Instant::now();

    let paths = web::block(move || {
        find_all_shortest_path(graph, from_page_id, to_page_id)
    })
    .await
    .unwrap();

    let elapsed_time = start_time.elapsed();

    let num_paths = paths.len();
    let shortest_path_length = paths.iter().map(|path| path.len()).min().unwrap_or(0);

    let response = serde_json::json!({
        "paths": paths,
        "num_paths": num_paths,
        "shortest_path_length": shortest_path_length,
        "time_spent_ms": elapsed_time.as_millis()
    });

    HttpResponse::Ok().json(response)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let graph = &*GRAPH;
    let app_state = AppState { graph };
    let graph_data = web::Data::new(app_state);

    
    log::info!("Graph data loaded and ready.");

    log::info!("Graph edges {}", graph.edges.len());
    log::info!("Graph offsets {}", graph.offsets.len());
    log::info!("Graph  pages offsets {}", graph.offsets[67819+1]);
    log::info!("Graph  pages offsets {}", graph.offsets[67819+2]);
    for v  in graph.offsets.to_vec().iter().rev().take(10) {
        log::info!("- {}", v);
    }

    let port_str = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let port = port_str.parse::<u16>().unwrap_or(8080);

    log::info!("Starting server at http://0.0.0.0:{}", port);
    HttpServer::new(move || {
        App::new()
            .wrap(Cors::default().allow_any_origin()) // Add CORS middleware to allow all origins
            .app_data(graph_data.clone())
            .service(all_shortest_path)
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
