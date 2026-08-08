use rkyv::Archived;
use rust_graph_types::CsrGraph;
use serde_json::json;
use std::collections::VecDeque;

fn bfs(graph: &Archived<CsrGraph>, start: usize, lcc_mask: &[bool]) -> (u32, usize) {
    let n = lcc_mask.len();
    let mut visited = vec![false; n];
    let mut queue = VecDeque::new();
    
    visited[start] = true;
    queue.push_back((start, 0));
    
    let mut max_dist = 0;
    let mut farthest_node = start;

    while let Some((u, dist)) = queue.pop_front() {
        if dist > max_dist {
            max_dist = dist;
            farthest_node = u;
        }
        
        let start_idx = graph.offsets[u].to_native() as usize;
        let end_idx = graph.offsets[u + 1].to_native() as usize;
        let neighbors = &graph.edges[start_idx..end_idx];
        
        for &v_arch in neighbors {
            let v = v_arch.to_native() as usize;
            if lcc_mask[v] && !visited[v] {
                visited[v] = true;
                queue.push_back((v, dist + 1));
            }
        }
    }
    
    (max_dist, farthest_node)
}

pub fn run(graph: &Archived<CsrGraph>) -> serde_json::Value {
    eprintln!("Running iFUB (Multi-Sweep)...");
    let (lcc_mask, lcc_size) = crate::lcc::get_lcc_mask(graph);
    
    if lcc_size == 0 {
        return json!({ "diameter": 0 });
    }
    
    // Pick a first node in the LCC
    let first_node = lcc_mask.iter().position(|&b| b).unwrap();
    
    let mut current_node = first_node;
    let mut max_dist = 0;
    let mut best_start = current_node;
    let mut best_end = current_node;

    // 4 sweeps are usually enough for Wikipedia graph diameter lower bounds
    for sweep in 1..=4 {
        eprintln!("Sweep {} starting from node {}", sweep, current_node);
        let (dist, farthest) = bfs(graph, current_node, &lcc_mask);
        eprintln!("  -> Reached node {} at distance {}", farthest, dist);
        if dist > max_dist {
            max_dist = dist;
            best_start = current_node;
            best_end = farthest;
        }
        current_node = farthest;
    }

    // Attempt to map our internal index back to actual Page IDs using the graph's hashmap
    // If the hashmap lookups fail for any reason, we safely fallback to 0.
    let from_page_id = graph.index_to_page_id.get(&rkyv::rend::u32_le::from_native(best_start as u32)).map(|v| v.to_native()).unwrap_or(0);
    let to_page_id = graph.index_to_page_id.get(&rkyv::rend::u32_le::from_native(best_end as u32)).map(|v| v.to_native()).unwrap_or(0);

    json!({ 
        "diameter_lower_bound": max_dist,
        "from_idx": best_start,
        "to_idx": best_end,
        "from_page_id": from_page_id,
        "to_page_id": to_page_id,
        "lcc_size": lcc_size
    })
}
