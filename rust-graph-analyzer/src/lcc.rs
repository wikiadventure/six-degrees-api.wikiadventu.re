use rkyv::Archived;
use rust_graph_types::CsrGraph;
use serde_json::json;
use std::collections::HashMap;

pub fn get_lcc_mask(graph: &Archived<CsrGraph>) -> (Vec<bool>, usize) {
    let n = (graph.offsets.len() - 1) as usize;
    let mut visited = vec![false; n];
    let mut order = Vec::with_capacity(n);

    eprintln!("LCC: Forward DFS...");
    for i in 0..n {
        if !visited[i] {
            let mut stack = vec![(i, 0)];
            visited[i] = true;
            while let Some(&(u, edge_idx)) = stack.last() {
                let start = graph.offsets[u].to_native() as usize;
                let end = graph.offsets[u + 1].to_native() as usize;
                
                let mut pushed = false;
                for idx in edge_idx..(end - start) {
                    let v = graph.edges[start + idx].to_native() as usize;
                    if !visited[v] {
                        stack.last_mut().unwrap().1 = idx + 1;
                        visited[v] = true;
                        stack.push((v, 0));
                        pushed = true;
                        break;
                    }
                }
                if !pushed {
                    order.push(u);
                    stack.pop();
                }
            }
        }
    }

    eprintln!("LCC: Reverse DFS...");
    let mut comp = vec![u32::MAX; n];
    let mut comp_counts = HashMap::new();
    let mut current_comp = 0;

    for &i in order.iter().rev() {
        if comp[i] == u32::MAX {
            let mut size = 0;
            let mut stack = vec![i];
            comp[i] = current_comp;
            while let Some(u) = stack.pop() {
                size += 1;
                let start = graph.reverse_offsets[u].to_native() as usize;
                let end = graph.reverse_offsets[u + 1].to_native() as usize;
                let neighbors = &graph.reverse_edges[start..end];
                for &v_arch in neighbors {
                    let v = v_arch.to_native() as usize;
                    if comp[v] == u32::MAX {
                        comp[v] = current_comp;
                        stack.push(v);
                    }
                }
            }
            comp_counts.insert(current_comp, size);
            current_comp += 1;
        }
    }

    let lcc_id = comp_counts.iter().max_by_key(|&(_, size)| size).map(|(id, _)| *id).unwrap_or(0);
    let lcc_size = *comp_counts.get(&lcc_id).unwrap_or(&0) as usize;

    eprintln!("LCC: Largest component found with size {}", lcc_size);

    let mut lcc_mask = vec![false; n];
    for i in 0..n {
        if comp[i] == lcc_id {
            lcc_mask[i] = true;
        }
    }

    (lcc_mask, lcc_size)
}

pub fn run(graph: &Archived<CsrGraph>) -> serde_json::Value {
    eprintln!("Running LCC...");
    let (_, size) = get_lcc_mask(graph);
    json!({ "size": size, "components": 0 })
}
