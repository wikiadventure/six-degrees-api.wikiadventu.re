use rkyv::{Archived, rend::u32_le};
use rust_graph_types::CsrGraph;
use serde_json::json;
use std::collections::BinaryHeap;

struct BestCandidate {
    degree: u32,
    node: usize,
}

impl PartialEq for BestCandidate {
    fn eq(&self, other: &Self) -> bool {
        self.degree == other.degree && self.node == other.node
    }
}
impl Eq for BestCandidate {}
impl PartialOrd for BestCandidate {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for BestCandidate {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other.degree.cmp(&self.degree).then_with(|| other.node.cmp(&self.node))
    }
}

#[derive(Debug)]
pub struct BfsResult {
    pub farthest_dist: u32,
    pub best_target: usize,
    pub best_count: u128,
}

fn top_k_nodes_by_degree<I>(degree_iter: I, k: usize) -> Vec<usize>
where
    I: IntoIterator<Item = (usize, u32)>,
{
    let mut heap = BinaryHeap::with_capacity(k + 1);
    for (node, deg) in degree_iter {
        if heap.len() < k {
            heap.push(BestCandidate { degree: deg, node });
            continue;
        }
        let smallest = heap.peek().unwrap();
        if deg > smallest.degree || (deg == smallest.degree && node < smallest.node) {
            heap.pop();
            heap.push(BestCandidate { degree: deg, node });
        }
    }

    let mut top: Vec<_> = heap.into_vec();
    top.sort_by(|a, b| b.degree.cmp(&a.degree).then_with(|| a.node.cmp(&b.node)));
    top.into_iter().map(|candidate| candidate.node).collect()
}

fn count_shortest_paths(
    offsets: &[u32_le],
    edges: &[u32_le],
    start: usize,
    lcc_mask: &[bool],
) -> BfsResult {
    let n = lcc_mask.len();
    let mut dist = vec![-1i32; n];
    let mut count = vec![0u128; n];
    let mut queue = std::collections::VecDeque::with_capacity(32_768);

    dist[start] = 0;
    count[start] = 1;
    queue.push_back(start);

    let mut farthest = start;
    let mut farthest_dist = 0;
    let mut best_target = start;
    let mut best_count = 1u128;

    while let Some(u) = queue.pop_front() {
        let start_idx = offsets[u].to_native() as usize;
        let end_idx = offsets[u + 1].to_native() as usize;
        for &v_arch in &edges[start_idx..end_idx] {
            let v = v_arch.to_native() as usize;
            if !lcc_mask[v] {
                continue;
            }

            if dist[v] == -1 {
                dist[v] = dist[u] + 1;
                count[v] = count[u];
                queue.push_back(v);
            } else if dist[v] == dist[u] + 1 {
                count[v] = count[v].saturating_add(count[u]);
            }

            if dist[v] != -1 {
                let v_dist = dist[v] as u32;
                if v_dist > farthest_dist || (v_dist == farthest_dist && v < farthest) {
                    farthest_dist = v_dist;
                    farthest = v;
                }
                if count[v] > best_count || (count[v] == best_count && v < best_target) {
                    best_count = count[v];
                    best_target = v;
                }
            }
        }
    }

    BfsResult {
        farthest_dist,
        best_target,
        best_count,
    }
}

fn page_id_for(graph: &Archived<CsrGraph>, idx: usize) -> u32 {
    graph
        .index_to_page_id
        .get(&rkyv::rend::u32_le::from_native(idx as u32))
        .map(|v| v.to_native())
        .unwrap_or(0)
}

pub fn run(graph: &Archived<CsrGraph>, candidate_count: usize) -> serde_json::Value {
    eprintln!("Running sampled shortest-path count analysis...");
    let (lcc_mask, lcc_size) = crate::lcc::get_lcc_mask(graph);
    let n = lcc_mask.len();
    if lcc_size == 0 {
        return json!({ "lcc_size": 0 });
    }

    let mut candidates = Vec::new();
    candidates.push(lcc_mask.iter().position(|&b| b).unwrap());

    let mut candidate_nodes = Vec::new();
    candidate_nodes.extend(top_k_nodes_by_degree(
        (0..n).filter_map(|i| {
            if lcc_mask[i] {
                let deg = graph.offsets[i + 1].to_native().saturating_sub(graph.offsets[i].to_native());
                Some((i, deg))
            } else {
                None
            }
        }),
        candidate_count / 2,
    ));
    candidate_nodes.extend(top_k_nodes_by_degree(
        (0..n).filter_map(|i| {
            if lcc_mask[i] {
                let deg = graph.reverse_offsets[i + 1]
                    .to_native()
                    .saturating_sub(graph.reverse_offsets[i].to_native());
                Some((i, deg))
            } else {
                None
            }
        }),
        candidate_count / 2,
    ));

    candidates.extend(candidate_nodes);
    candidates.sort_unstable();
    candidates.dedup();

    let mut best_count = 0u128;
    let mut best_pair = (0usize, 0usize);
    let mut best_distance = 0u32;
    let mut best_mode = "forward";

    eprintln!("Selected {} candidate source/sink nodes", candidates.len());

    for (idx, &candidate) in candidates.iter().enumerate() {
        eprintln!("Running candidate {}/{}: node {}", idx + 1, candidates.len(), candidate);
        let result = count_shortest_paths(&graph.offsets, &graph.edges, candidate, &lcc_mask);
        if result.best_count > best_count {
            best_count = result.best_count;
            best_pair = (candidate, result.best_target);
            best_distance = result.farthest_dist;
            best_mode = "forward";
        }
        let reverse_result = count_shortest_paths(
            &graph.reverse_offsets,
            &graph.reverse_edges,
            candidate,
            &lcc_mask,
        );
        if reverse_result.best_count > best_count {
            best_count = reverse_result.best_count;
            best_pair = (reverse_result.best_target, candidate);
            best_distance = reverse_result.farthest_dist;
            best_mode = "reverse";
        }
    }

    json!({
        "lcc_size": lcc_size,
        "candidate_count": candidates.len(),
        "best_count": best_count.to_string(),
        "best_source": best_pair.0,
        "best_target": best_pair.1,
        "best_source_page_id": page_id_for(graph, best_pair.0),
        "best_target_page_id": page_id_for(graph, best_pair.1),
        "best_distance": best_distance,
        "best_direction": best_mode,
    })
}
