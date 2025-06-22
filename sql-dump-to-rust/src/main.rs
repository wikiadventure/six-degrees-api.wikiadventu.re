use async_gen::futures_core::Stream;
use flate2::read::GzDecoder;
use indicatif::{ProgressBar, ProgressStyle};
use lazy_static::lazy_static;
use async_stream::stream;
use futures::StreamExt;
use regex::Regex;
use reqwest::Client;
use rkyv::{
    rancor::Error, to_bytes, Archive, Deserialize, Serialize,
};
use utf8_chars::BufReadCharsExt;
use std::{collections::HashMap, fs::File, io::{BufRead, BufReader, Seek, Write}};
use rustc_hash::{FxBuildHasher, FxHashMap};
use crate::dump_logger::DumpProgressLogger;
#[path = "logger/dump_logger.rs"] mod dump_logger;


lazy_static! {
    static ref WIKI_LANG: String =
    // env::var("WIKI_LANG").expect("WIKI_LANG environment variable not set");
        "en".to_string();
}

#[derive(Archive, Serialize, Deserialize, Debug, PartialEq)]
struct CsrGraph {
    offsets: Vec<usize>,
    edges: Vec<u32>,
    page_id_to_index: HashMap<u32, u32>,
    index_to_page_id: HashMap<u32, u32>,
}

pub struct SqlDumpStream {
    pub decoder: GzDecoder<File>,
    pub size: u64,
    pub file_handle_for_progress: File,
}

async fn sql_dump_stream_from_cache(file_type: &str) -> Result<SqlDumpStream, Box<dyn std::error::Error>> {
    let path = format!("cache/{}/{}wiki-latest-{}.sql.gz", &*WIKI_LANG, &*WIKI_LANG, file_type);
    let file_path = std::path::Path::new(&path);
    if file_path.exists() {
        println!("Using cached file: {}", path);
        let saved_file = std::fs::File::open(file_path)?;
        let progress_handle = saved_file.try_clone()?;
        let size = saved_file.metadata()?.len();
        return Ok(SqlDumpStream {
            decoder: flate2::read::GzDecoder::new(saved_file),
            size,
            file_handle_for_progress: progress_handle,
        });
    }
    let url = format!("https://dumps.wikimedia.org/{}wiki/latest/{}wiki-latest-{}.sql.gz",  &*WIKI_LANG, &*WIKI_LANG, file_type);
    println!("Downloading {}...", url);

    let client = Client::new();
    let mut res = client.get(&url).send().await?;
    let total_size = res.content_length().unwrap_or(0);
    let pb = ProgressBar::new(total_size);
    pb.set_style(ProgressStyle::default_bar()
        .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {bytes}/{total_bytes} ({eta})")
        .unwrap()
        .progress_chars("#>-"));
    let file_path = std::path::Path::new(&path);

    // Create parent directory if it doesn't exist
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut file = std::fs::File::create(file_path)?;
    
    // Note: `res` must be mutable to be read from.
    while let Some(chunk) = res.chunk().await? {
        file.write_all(&chunk)?;
        pb.inc(chunk.len() as u64);
    }
    pb.finish_with_message("Downloaded");
    // Open the newly downloaded file
    let saved_file = std::fs::File::open(file_path)?;
    let progress_handle = saved_file.try_clone()?;

    // Return a decompressed stream.
    Ok(SqlDumpStream {
        decoder: flate2::read::GzDecoder::new(saved_file),
        size: total_size,
        file_handle_for_progress: progress_handle,
    })
}


async fn sql_dump_parser(reader: &mut BufReader<GzDecoder<File>>, key_to_yield:Vec<&str>) -> impl Stream<Item=Vec<String>>  {stream! {
    
    let mut fields: Vec<String> = Vec::new();
    let mut line_buf = String::new();
    loop {
        line_buf.clear();
        if reader.read_line(&mut line_buf).expect("File incomplete") == 0 {
            panic!("Did not find CREATE TABLE statement");
        }
        if line_buf.starts_with("CREATE TABLE") {
            break;
        }
    }

    let re = Regex::new(r"^\s*`(.*)`").unwrap();
    loop {
        line_buf.clear();
        if reader.read_line(&mut line_buf).expect("File incomplete") == 0 {
            panic!("File ended during CREATE TABLE statement");
        }
        let line = &line_buf;
        let create_table_block_complete = line.starts_with(")");
        if create_table_block_complete {break;}
        let field = re.captures(&line).and_then(|caps| {
            caps.get(1).map(|m| m.as_str())
        });
        if field.is_some() {fields.push(field.unwrap().to_owned());}
    }

    let key_to_index: FxHashMap<&str, usize> = fields
        .iter()
        .enumerate()
        .map(|(index, field)| (field.as_str(), index))
        .collect();

    let index_to_yield: Vec<usize> = key_to_yield
        .iter()
        .filter_map(|k| key_to_index.get(k).copied())
        .collect();

    pub struct ProcessContext {
        pub inside_parenthesis: bool,
        pub inside_string: bool,
        pub escaped: bool,
        pub current_value: String,
        pub values: Vec<String>,
    }

    impl ProcessContext {
        /// Creates a new, empty ProcessContext.
        pub fn new() -> Self {
            Self {
                inside_parenthesis: false,
                inside_string: false,
                escaped: false,
                current_value: String::new(),
                values: Vec::new(),
            }
        }
    }

    let mut ctx = ProcessContext::new();

    fn process_char(c: char, ctx: &mut ProcessContext) -> bool {
        if ctx.inside_parenthesis {
            if ctx.inside_string {
                if ctx.escaped {
                    ctx.current_value.push(c);
                    ctx.escaped = false;
                } else if c == '\\' {
                    ctx.escaped = true;
                } else if c == '\'' {
                    ctx.inside_string = false;
                } else {
                    ctx.current_value.push(c);
                }
            } else {
                if c == '\'' {
                    ctx.inside_string = true;
                } else if c == ',' {
                    ctx.values.push(std::mem::take(&mut ctx.current_value));
                } else if c == ')' {
                    ctx.inside_parenthesis = false;
                    ctx.values.push(std::mem::take(&mut ctx.current_value));
                    return true;
                } else {
                    ctx.current_value.push(c);
                }
            }
        } else if c == '(' {
            ctx.inside_parenthesis = true;
        }
        return false;
    }
    for c in reader.chars() {
        let block_is_finished = process_char(c.expect("Error while reading dump file"), &mut ctx);
        if block_is_finished {
            yield index_to_yield
                .iter()
                .map(|index| ctx.values.get(*index).expect("File parsing error not enough value inside parsed block").clone())
                .collect();
            ctx.values = Vec::new();
        }
    }
}}

pub struct DumpParserContext {
    pub pages_map: FxHashMap<String, WikiPageId>,
    pub redirects_map: FxHashMap<u32, String>,
    pub linktarget_map: FxHashMap<u32, String>,
    pub pages_links: FxHashMap<u32, Vec<u32>>,
    pub links_count: usize,
}

pub struct WikiPageId {
    pub id: u32,
    pub is_redirect: bool,
}


async fn parse_and_load_page(ctx: &mut DumpParserContext) {
    let file_type = "page";
    let pages_map = &mut ctx.pages_map;
    let dump_stream: SqlDumpStream = sql_dump_stream_from_cache(file_type).await
        .expect(&format!("Failed to load wiki {} dump file", file_type));
    let mut reader = BufReader::new(dump_stream.decoder);
    let mut progress_handle = dump_stream.file_handle_for_progress;

    let mut logger = DumpProgressLogger::new(dump_stream.size, "Pages".to_string());
    let mut count:u64 = 0;

    let stream = sql_dump_parser(&mut reader, vec!["page_id","page_title", "page_namespace","page_is_redirect"]).await;
    tokio::pin!(stream);
    while let Some(page_data) = stream.next().await {
        let mut iter = page_data.into_iter();
        let page_id         = iter.next().expect("page_id is missing");
        let page_title      = iter.next().expect("page_title is missing");
        let page_namespace  = iter.next().expect("page_namespace is missing");
        if page_namespace != "0" {continue;}
        let page_is_redirect = iter.next().expect("page_is_redirect is missing");
        let wiki_page_id = WikiPageId {
            id: page_id.parse().expect("page_id is not a valid u32"),
            is_redirect: page_is_redirect == "1",
        };
        pages_map.insert(page_title, wiki_page_id);
        count += 1;
        if (count % 65_536) == 0 {
            let bytes_read_amount = progress_handle.stream_position().unwrap_or(0);
            logger.log(bytes_read_amount, count);
        }
    }


    let bytes_read_amount = progress_handle.stream_position().unwrap_or(0);
    logger.log(bytes_read_amount, count);
        

}

pub struct WikiRedirectToResolve {
    pub _from_id: u32,
    pub _to_title: String,
}

async fn parse_and_load_redirect(ctx: &mut DumpParserContext) {
    let file_type = "redirect";

    let pages_map = &ctx.pages_map;
    let redirects_map = &mut ctx.redirects_map;
    let mut redirects_to_resolve:Vec<WikiRedirectToResolve> = Vec::new();

    let dump_stream = sql_dump_stream_from_cache(file_type).await
        .expect(&format!("Failed to load wiki {} dump file", file_type));
    let mut reader = BufReader::new(dump_stream.decoder);
    let mut progress_handle = dump_stream.file_handle_for_progress;

    let mut logger = DumpProgressLogger::new(dump_stream.size, "Redirects".to_string());
    let mut count:u64 = 0;

    let stream = sql_dump_parser(&mut reader, vec!["rd_from","rd_namespace","rd_title"/*,"rd_interwiki","rd_fragment"*/]).await;
    tokio::pin!(stream);
    while let Some(redirect_data) = stream.next().await {
        let mut iter = redirect_data.into_iter();
        let rd_from      = iter.next().expect("rd_from is missing");
        let rd_namespace = iter.next().expect("rd_namespace is missing");
        if rd_namespace != "0" {continue;}
        let rd_title     = iter.next().expect("rd_title is missing");
        let _to_is_redirect_option = pages_map.get(&rd_title);
        // the redirect lead to a page that does not exist ( most likely  it's not in the article namespace)
        if _to_is_redirect_option.is_none() {continue;}
        let _to_is_redirect = _to_is_redirect_option.unwrap();
        // let rd_interwiki = iter.next().expect("rd_interwiki is missing");
        // let rd_fragment  = iter.next().expect("rd_fragment is missing");

        let _from: u32 = rd_from.parse().expect("rd_from is not a valid u32");
        let _to = _to_is_redirect.id;
        let is_redirect = _to_is_redirect.is_redirect;
        count += 1;
        if (count % 65_536) == 0 {
            let bytes_read_amount = progress_handle.stream_position().unwrap_or(0);
            logger.log(bytes_read_amount, count);
        }
        // The redirect lead to another redirect that need to be resolved
        if is_redirect {
            redirects_to_resolve.push(WikiRedirectToResolve {_from_id: _from, _to_title: rd_title});
            continue;
         // The redirect lead to a valid page
        } else {
            redirects_map.insert(_from, rd_title);

        }
    }

    
    let bytes_read_amount = progress_handle.stream_position().unwrap_or(0);
    logger.log(bytes_read_amount, count);
        

    // for  wikiRedirectToResolve in redirects_to_resolve {
    //     let _to_title = wikiRedirectToResolve._to_title;
    //     let _to = resolveRedirect(Some(&_to_title), pages_map, redirects_map);
    //     if _to.is_none() {continue;}
    //     // nextBatch.push({_from, _to});
            
    //     count += 1;
    //     if (count % 65_536) == 0 {
    //         let bytes_read_amount = progress_handle.stream_position().unwrap_or(0);
    //         logger.log(bytes_read_amount, count);
    //     }
        
    // }

}

async fn parse_and_load_link_target(ctx: &mut DumpParserContext) {
    let file_type = "linktarget";

    let linktarget_map = &mut ctx.linktarget_map;

    let dump_stream = sql_dump_stream_from_cache(file_type).await
        .expect(&format!("Failed to load wiki {} dump file", file_type));
    let mut reader = BufReader::new(dump_stream.decoder);
    let mut progress_handle = dump_stream.file_handle_for_progress;

    let mut logger = DumpProgressLogger::new(dump_stream.size, "Link target".to_string());
    let mut count:u64 = 0;

    let stream = sql_dump_parser(&mut reader, vec!["lt_id","lt_namespace", "lt_title" ]).await;
    tokio::pin!(stream);
    while let Some(linktarget_data) = stream.next().await {
        let mut iter = linktarget_data.into_iter();
        let raw_lt_id       = iter.next().expect("lt_id is missing");
        let lt_namespace    = iter.next().expect("lt_namespace is missing");
        if lt_namespace != "0" {continue;}
        let lt_title        = iter.next().expect("lt_title is missing");
        let lt_id = raw_lt_id.parse().expect("lt_id is not a valid u32");
        linktarget_map.insert(lt_id,lt_title);
        count+=1;
        if (count % 65_536) == 0 {
            let bytes_read_amount = progress_handle.stream_position().unwrap_or(0);
            logger.log(bytes_read_amount, count);
        }
    }


    let bytes_read_amount = progress_handle.stream_position().unwrap_or(0);
    logger.log(bytes_read_amount, count);
    

}

async fn parse_and_load_page_links(ctx:&mut DumpParserContext) {
    let file_type = "pagelinks";

    // let csr_graph = Csr {

    // }
    
    let pages_map = &ctx.pages_map;
    let linktarget_map = &ctx.linktarget_map;
    let redirects_map= &ctx.redirects_map;
    let pages_links= &mut ctx.pages_links;

    let dump_stream = sql_dump_stream_from_cache(file_type).await
        .expect(&format!("Failed to load wiki {} dump file", file_type));
    let mut reader = BufReader::new(dump_stream.decoder);
    let mut progress_handle = dump_stream.file_handle_for_progress;

    let mut logger = DumpProgressLogger::new(dump_stream.size, "Page Links".to_string());
    let mut count:u64 = 0;

    let stream = sql_dump_parser(&mut reader, vec!["pl_from"/*, "pl_from_namespace"*/, "pl_target_id"]).await;
    tokio::pin!(stream);
    while let Some(pagelinks_data) = stream.next().await {
        let mut iter = pagelinks_data.into_iter();
        let pl_from             = iter.next().expect("pl_from is missing");
        //let pl_from_namespace   = iter.next().expect("pl_from_namespace is missing");
        let raw_pl_target_id    = iter.next().expect("pl_target_id is missing");
        let pl_target_id :u32 = raw_pl_target_id.parse().expect("pl_target_id is not a valid u32");
        let _to_title_option = linktarget_map.get(&pl_target_id);
        if _to_title_option.is_none() {continue;}
        let _to_title = _to_title_option.unwrap();
        let _to_is_redirect_option = pages_map.get(_to_title);
        if _to_is_redirect_option.is_none() {continue;}
        let _to_is_redirect = _to_is_redirect_option.unwrap();
        let _from:u32 = pl_from.parse().expect("pl_from is not a valid u32");
        let _to = _to_is_redirect.id;
        let is_redirect = _to_is_redirect.is_redirect;
        ctx.links_count += 1;
        if is_redirect {
            let _to_resolved_option = resolve_redirect(redirects_map.get(&_to), pages_map, redirects_map);
            if _to_resolved_option.is_none() {continue;}
            let _to_resolved =_to_resolved_option.unwrap();
            if !pages_links.contains_key(&_from) {
                pages_links.insert(_from, vec![_to_resolved]);
            } else {
                pages_links.entry(_from).or_default().push(_to_resolved); 
            }
            // nextBatch.push({_from, _to: _to_resolved});
            // The link resolve to a valid page
        } else {
            if !pages_links.contains_key(&_from) {
                pages_links.insert(_from, vec![_to]);
            } else {
                pages_links.entry(_from).or_default().push(_to); 
            }
        }
        count+=1;
        if (count % 65_536) == 0 {
            let bytes_read_amount = progress_handle.stream_position().unwrap_or(0);
            logger.log(bytes_read_amount, count);
        }

    }

    let bytes_read_amount = progress_handle.stream_position().unwrap_or(0);
    logger.log(bytes_read_amount, count);

}

fn resolve_redirect(page_title_option:Option<&String>, pages_map: &FxHashMap<String, WikiPageId>, redirects_map: &FxHashMap<u32, String>) -> Option<u32> {
    if page_title_option.is_none() {return None;}
    let page_title = page_title_option.unwrap();

    let mut n:u8 = 0;
    let page_id = pages_map.get(page_title).expect("page_title should be in pages_map").id;
    let mut last_title = redirects_map.get(&page_id);
    while n<10 {
        if last_title.is_none() {return None;}
        let _to_is_redirect_option = pages_map.get(last_title.unwrap());
        if _to_is_redirect_option.is_none() {return None;}
        let _to_is_redirect = _to_is_redirect_option.unwrap();
        let id = _to_is_redirect.id;
        let is_redirect = _to_is_redirect.is_redirect;
        if !is_redirect {return Some(id);}
        last_title = redirects_map.get(&id);
        n+=1;
    }
    None
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut ctx = DumpParserContext {
        pages_map: FxHashMap::with_hasher(FxBuildHasher::default()),
        redirects_map: FxHashMap::with_hasher(FxBuildHasher::default()),
        linktarget_map: FxHashMap::with_hasher(FxBuildHasher::default()),
        pages_links: FxHashMap::with_hasher(FxBuildHasher::default()),
        links_count: 0
    };
    println!("\nStart parsing pages dump...");
    parse_and_load_page(&mut ctx).await;
    println!("\nPages dump parsing complete!");
    println!("\nStart parsing redirect dump...");
    parse_and_load_redirect(&mut ctx).await;
    println!("\nRedirect dump parsing complete!");
    println!("\nStart parsing linktarget dump...");
    parse_and_load_link_target(&mut ctx).await;
    println!("\nLinktarget dump parsing complete!");
    println!("\nStart parsing page links dump...");
    parse_and_load_page_links(&mut ctx).await;
    println!("\nPage links dump parsing complete!");

    println!("\nAdding page with no links");
    for (_page_title, wiki_page_id) in ctx.pages_map.iter() {
        let page_id = wiki_page_id.id;
        if !ctx.pages_links.contains_key(&page_id) {
            ctx.pages_links.insert(page_id, vec![]);
        }
    }

    println!("\nBuilding Compressed Sparse Row Graph");

    let mut logger = DumpProgressLogger::new(ctx.pages_links.len().try_into().unwrap(), "Building CSR".to_string());

    let mut page_ids: Vec<u32> = ctx.pages_links.keys().copied().collect();
    page_ids.sort_unstable();

    let page_id_to_index: HashMap<u32, u32> = page_ids
        .iter()
        .enumerate()
        .map(|(i, page_id)| (*page_id, i as u32))
        .collect();

    let index_to_page_id: HashMap<u32, u32> = page_id_to_index.iter().map(|(&k, &v)| (v, k)).collect();

    let mut offsets = Vec::with_capacity(page_ids.len() + 1);
    let mut edges = Vec::with_capacity(ctx.links_count);
    offsets.push(0);
    let mut i: u32 = 0;

    for page_id in &page_ids {
        if let Some(links) = ctx.pages_links.get(page_id) {
            for link_page_id in links {
                if let Some(link_index) = page_id_to_index.get(link_page_id) {
                    edges.push(*link_index);
                }
            }
        }
        offsets.push(edges.len());

        i += 1;
        if i % 65_536 == 0 {
            logger.log(i.into(), i.into());
        }
    }

    logger.log(i.into(), i.into());
    println!("\nBuild of Compressed Sparse Row Graph complete");
    let graph = CsrGraph {
        offsets,
        edges,
        page_id_to_index,
        index_to_page_id
    };

    println!("\nSerializing graph...");
    let bytes = to_bytes::<Error>(&graph).expect("Graph RKYV serialization failed");
    let mut file = File::create("graph.rkyv")?;
    file.write_all(&bytes).expect("Failed to write graph to graph.rkyv");
    println!("Graph serialized to graph.rkyv");

    Ok(())
}
