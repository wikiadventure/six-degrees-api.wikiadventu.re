use actix_web::{get, web, App, HttpServer, Responder, HttpResponse};
use actix_cors::Cors;
use env_logger;
use memmap2::Mmap;
use once_cell::sync::Lazy; // Import Lazy
use rayon::prelude::*;
use rkyv::rend::u32_le;
use rkyv::{Archive, Deserialize, Serialize};
use rust_graph_types::{CsrGraph, ArchivedCsrGraph};
use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};
use std::collections::HashMap;
use std::fs::File;
use deadpool_redis::{Config, Pool, Runtime};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PageId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeIdx(pub u32);

const MAX_PATHS_TO_RETURN: usize = 1000;

// Define a global static variable for the graph.
// It will be initialized exactly once, on the first time it's accessed.
static GRAPH: Lazy<&'static ArchivedCsrGraph> = Lazy::new(|| {
    log::info!("Lazily loading graph data for static access...");

    let file = File::open("graph.rkyv").expect("Failed to open graph.rkyv");
    // SAFETY: The file is structurally guaranteed to be valid by our graph builder,
    // and since it is deployed statically via Docker, it will not be mutated concurrently.
    let mmap = unsafe { Mmap::map(&file).expect("Failed to memory-map the file.") };

    // Leak the mmap to get a 'static lifetime.
    let mmap_static: &'static [u8] = Box::leak(Box::new(mmap));

    #[cfg(target_os = "linux")]
    {
        log::info!("Warming up page cache in the background using madvise...");
        // SAFETY: We pass a valid mapped address to libc::madvise, ensuring length is correct.
        // It's a non-destructive kernel hint and strictly read-only mapping.
        unsafe {
            let addr = mmap_static.as_ptr() as *mut libc::c_void;
            let len = mmap_static.len();
            if libc::madvise(addr, len, libc::MADV_WILLNEED) != 0 {
                log::warn!("madvise(MADV_WILLNEED) failed");
            } else {
                log::info!("madvise successfully hinted the kernel to preload the graph.");
            }
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Fallback for non-Linux: Spawn a background thread to sequentially warm up the page cache
        std::thread::spawn(move || {
            log::info!("Warming up page cache in the background (fallback)...");
            let mut _sink = 0;
            // Read 1 byte every 4KB (standard OS page size) to force a page fault
            for i in (0..mmap_static.len()).step_by(4096) {
                _sink ^= unsafe { std::ptr::read_volatile(&mmap_static[i]) };
            }
            log::info!("Page cache warm-up complete! Warmed {} MB.", mmap_static.len() / 1024 / 1024);
        });
    }

    // SAFETY: We trust the `graph.rkyv` blob aligns correctly to ArchievedCsrGraph.
    // The builder script directly serializes to this exact memory layout, 
    // ensuring we don't encounter uninitialized/padding bytes that cause UB.
    unsafe { rkyv::access_unchecked::<ArchivedCsrGraph>(mmap_static) }
});


struct AppState {
    graph: &'static ArchivedCsrGraph,
    pool: Pool,
    wiki_lang: String,
}

fn reconstruct_paths(
    node: NodeIdx,
    start_node: NodeIdx,
    parents: &FxHashMap<NodeIdx, Vec<NodeIdx>>,
) -> Vec<Vec<NodeIdx>> {
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
    let start_page = PageId(start_page_id);
    let end_page = PageId(end_page_id);

    let start_node = match graph.page_id_to_index.get(&u32_le::from_native(start_page.0)) {
        Some(id) => NodeIdx(id.to_native()),
        None => return vec![],
    };
    let end_node = match graph.page_id_to_index.get(&u32_le::from_native(end_page.0)) {
        Some(id) => NodeIdx(id.to_native()),
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
    let mut forward_dist: FxHashMap<NodeIdx, u32> = FxHashMap::with_hasher(FxBuildHasher::default());
    forward_dist.insert(start_node, 0);
    let mut backward_dist: FxHashMap<NodeIdx, u32> = FxHashMap::with_hasher(FxBuildHasher::default());
    backward_dist.insert(end_node, 0);

    let mut forward_parents: FxHashMap<NodeIdx, Vec<NodeIdx>> = FxHashMap::with_hasher(FxBuildHasher::default());
    let mut backward_parents: FxHashMap<NodeIdx, Vec<NodeIdx>> = FxHashMap::with_hasher(FxBuildHasher::default());

    let mut meeting_nodes = FxHashSet::with_hasher(FxBuildHasher::default());
    let mut shortest_path_len = u32::MAX;
    let mut forward_depth = 0;
    let mut backward_depth = 0;

    let parallel_threshold = /* 1000 items */ 1000;

    while !forward_frontier.is_empty() && !backward_frontier.is_empty() {
        // Stop if we can't find a shorter path than we've already found.
        if forward_depth + backward_depth >= shortest_path_len {
            break;
        }

        // Python script trick: expand the frontier with fewer outgoing links.
        // Fallback to sequential iteration for small frontiers to avoid Thread Pool overhead
        let forward_link_count: usize = if forward_frontier.len() < parallel_threshold {
            forward_frontier.iter().map(|&u| {
                let start = graph.offsets[u.0 as usize].to_native() as usize;
                let end = graph.offsets[(u.0 + 1) as usize].to_native() as usize;
                end - start
            }).sum()
        } else {
            forward_frontier.par_iter().map(|&u| {
                let start = graph.offsets[u.0 as usize].to_native() as usize;
                let end = graph.offsets[(u.0 + 1) as usize].to_native() as usize;
                end - start
            }).sum()
        };

        let backward_link_count: usize = if backward_frontier.len() < parallel_threshold {
            backward_frontier.iter().map(|&u| {
                let start = graph.reverse_offsets[u.0 as usize].to_native() as usize;
                let end = graph.reverse_offsets[(u.0 + 1) as usize].to_native() as usize;
                end - start
            }).sum()
        } else {
            backward_frontier.par_iter().map(|&u| {
                let start = graph.reverse_offsets[u.0 as usize].to_native() as usize;
                let end = graph.reverse_offsets[(u.0 + 1) as usize].to_native() as usize;
                end - start
            }).sum()
        };

        let expand_forward = forward_link_count <= backward_link_count;

        if expand_forward {
            forward_depth += 1;
            let mut next_frontier = FxHashSet::with_capacity_and_hasher(forward_frontier.len() * 5, FxBuildHasher::default());
            for &u in &forward_frontier {
                let start_offset = graph.offsets[u.0 as usize].to_native() as usize;
                let end_offset = graph.offsets[(u.0 + 1) as usize].to_native() as usize;
                for v_le in &graph.edges[start_offset..end_offset] {
                    let v = NodeIdx(v_le.to_native());

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
                let start_offset = graph.reverse_offsets[u.0 as usize].to_native() as usize;
                let end_offset = graph.reverse_offsets[(u.0 + 1) as usize].to_native() as usize;
                for v_le in &graph.reverse_edges[start_offset..end_offset] {
                    let v = NodeIdx(v_le.to_native());

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

    let all_paths: FxHashSet<Vec<NodeIdx>> = meeting_nodes
        .par_iter()
        .flat_map(|&meet_node| {
            let forward_paths = reconstruct_paths(meet_node, start_node, &forward_parents);
            let backward_paths = reconstruct_paths(meet_node, end_node, &backward_parents);

            let mut combined_paths = Vec::with_capacity(forward_paths.len() * backward_paths.len());

            for f_path in &forward_paths {
                for b_path in &backward_paths {
                    // Pre-allocate exact size to avoid repeated allocations
                    let mut path = Vec::with_capacity(f_path.len() + b_path.len() - 1);
                    path.extend_from_slice(f_path);
                    // Append reversed backward path skipping the overlap meeting node
                    path.extend(b_path.iter().rev().skip(1));
                    combined_paths.push(path);
                }
            }
            combined_paths
        })
        .collect();

    all_paths.into_par_iter().map(|path| {
        path.into_iter().map(|idx| graph.index_to_page_id.get(&u32_le::from_native(idx.0)).unwrap().to_native()).collect()
    }).collect()
}

#[get("/all-shortest-path/{from_page_id}/to/{to_page_id}")]
async fn all_shortest_path(
    state: web::Data<AppState>,
    path_params: web::Path<(u32, u32)>,
) -> impl Responder {
    let (from_page_id, to_page_id) = path_params.into_inner();
    let cache_key = format!("{}:{}:{}", state.wiki_lang, from_page_id, to_page_id);

    // Check cache
    if let Ok(mut conn) = state.pool.get().await {
        let result: Result<Option<String>, _> = redis::cmd("GET").arg(&cache_key).query_async(&mut conn).await;
        if let Ok(Some(cached_str)) = result {
            return HttpResponse::Ok().content_type("application/json").body(cached_str);
        }
    }

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
    let limited_paths: Vec<_> = paths.iter().take(MAX_PATHS_TO_RETURN).cloned().collect();

    let response = serde_json::json!({
        "paths": limited_paths,
        "num_paths": num_paths,
        "shortest_path_length": shortest_path_length,
        "path_limit": MAX_PATHS_TO_RETURN,
        "truncated": num_paths > MAX_PATHS_TO_RETURN,
        "time_spent_ms": elapsed_time.as_millis()
    });

    let raw_str = response.to_string();

    if elapsed_time.as_millis() >= 1000 {
        let pool = state.pool.clone();
        let cache_key_clone = cache_key.clone();
        let cache_val = raw_str.clone();
        actix_web::rt::spawn(async move {
            if let Ok(mut conn) = pool.get().await {
                // Save to Redis (no expiration requested, but EX could be added if needed)
                let _result: Result<(), _> = redis::cmd("SET")
                    .arg(&cache_key_clone)
                    .arg(&cache_val)
                    .query_async(&mut conn)
                    .await;
            }
        });
    }

    HttpResponse::Ok().content_type("application/json").body(raw_str)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let wiki_lang = std::env::var("WIKI_LANG").unwrap_or_else(|_| "en".to_string());
    let redis_url = std::env::var("REDIS_URL").expect("REDIS_URL must be set");

    let cfg = Config::from_url(redis_url);
    let pool = cfg.create_pool(Some(Runtime::Tokio1)).unwrap();

    let graph = &*GRAPH;
    let app_state = AppState { graph, pool, wiki_lang };
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
