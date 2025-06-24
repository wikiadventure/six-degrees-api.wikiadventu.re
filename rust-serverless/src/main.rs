use actix_web::{get, web, App, HttpServer, Responder, HttpResponse};
use env_logger;
use memmap2::Mmap;
use once_cell::sync::Lazy; // Import Lazy
use rayon::prelude::*;
use rkyv::rend::u32_le;
use rkyv::{access, rancor, Archive, Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs::File;

#[derive(Archive, Deserialize, Serialize)]
struct CsrGraph {
    offsets: Vec<u32>,
    edges: Vec<u32>,
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

fn find_all_shortest_path(
    graph: &'static ArchivedCsrGraph,
    start_page_id: u32,
    end_page_id: u32,
) -> Vec<Vec<u32>> {
    let start_page_id_le    = u32_le::from_native(start_page_id);
    let end_page_id_le      = u32_le::from_native(end_page_id);

    let start_page_idx      = *graph.page_id_to_index.get(&start_page_id_le).unwrap_or(&u32_le::from(0));
    let end_page_idx        = *graph.page_id_to_index.get(&end_page_id_le)  .unwrap_or(&u32_le::from(0));

    log::info!("Find all shortest path from {} to {}", start_page_id, end_page_id);
    log::info!("Mapped to index        from {} to {}", start_page_idx, end_page_idx);

    let start_idx = match graph.page_id_to_index.get(&start_page_id_le) {
        Some(&id) => u32::from(id) as usize,
        None => return Vec::new(),
    };
    let end_idx = match graph.page_id_to_index.get(&end_page_id_le) {
        Some(&id) => u32::from(id) as usize,
        None => return Vec::new(),
    };

    if start_idx == end_idx {
        return vec![vec![start_page_id]];
    }

    let num_nodes = graph.offsets.len() - 1;
    
    let mut dist = vec![u32::MAX; num_nodes];
    let mut parents: Vec<Vec<usize>> = vec![Vec::new(); num_nodes];
    let mut queue = VecDeque::new();

    dist[start_idx] = 0;
    queue.push_back(start_idx);

    let mut shortest_dist = u32::MAX;

    while let Some(u_idx) = queue.pop_front() {
        // If we have found a shortest path, no need to explore longer paths
        if dist[u_idx] > shortest_dist {
            continue;
        }

        // If we reached the end node, update the shortest distance found so far
        if u_idx == end_idx {
            shortest_dist = dist[u_idx];
            continue;
        }
        let neighbors_start_le  = graph.offsets[u_idx];
        let neighbors_end_le    = graph.offsets[u_idx+1];
        

        let neighbors_start = u32::from(neighbors_start_le) as usize;
        let neighbors_end   = u32::from(neighbors_end_le) as usize;

        for v_idx_le in &graph.edges[neighbors_start..neighbors_end] {
            let v_idx = u32::from(*v_idx_le) as usize;
            let u_dist = dist[u_idx];

            if dist[v_idx] > u_dist + 1 {
                dist[v_idx] = u_dist + 1;
                parents[v_idx].clear();
                parents[v_idx].push(u_idx);
                queue.push_back(v_idx);
            } else if dist[v_idx] == u_dist + 1 {
                parents[v_idx].push(u_idx);
            }
        }
    }

    if shortest_dist == u32::MAX {
        return Vec::new(); // No path found
    }

    let paths_indices = build_paths_parallel(end_idx, start_idx, &parents);

    // Convert paths of indices back to paths of page IDs, in parallel
    paths_indices
        .into_par_iter() // Use parallel iterator
        .map(|mut path| {
            path.reverse(); // Reverse the path to get start -> end order
            path.into_iter()
                .map(|idx| {
                    let idx_le = u32_le::from_native(idx as u32);
                    u32::from(*graph.index_to_page_id.get(&idx_le).unwrap())
                })
                .collect()
        })
        .collect()
}

fn build_paths_parallel(
    current_idx: usize,
    start_idx: usize,
    parents: &Vec<Vec<usize>>,
) -> Vec<Vec<usize>> {
    if current_idx == start_idx {
        return vec![vec![start_idx]];
    }

    let parent_nodes = match parents.get(current_idx) {
        Some(p) if !p.is_empty() => p,
        _ => return Vec::new(),
    };

    parent_nodes
        .par_iter() // Iterate over parents in parallel
        .flat_map(|&parent_idx| {
            // Recursively build paths from each parent
            build_paths_parallel(parent_idx, start_idx, parents)
                .into_par_iter()
                .map(move |mut path| {
                    path.push(current_idx); // Append current node to each path found
                    path
                })
        })
        .collect()
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
            .app_data(graph_data.clone())
            .service(all_shortest_path)
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
