use rkyv::{Archive, Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Archive, Serialize, Deserialize, Debug, PartialEq)]
pub struct CsrGraph {
    pub offsets: Vec<u32>,
    pub edges: Vec<u32>,
    pub reverse_offsets: Vec<u32>,
    pub reverse_edges: Vec<u32>,
    pub page_id_to_index: HashMap<u32, u32>,
    pub index_to_page_id: HashMap<u32, u32>,
}
