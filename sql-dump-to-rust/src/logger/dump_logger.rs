use std::time::Instant;
use sysinfo::{get_current_pid, Pid, System};

pub struct DumpProgressLogger {
    title: String,
    dump_bytes_size: u64,
    last_parsed_amount: u64,
    last_bytes_read_amount: u64,
    start_timestamp: Instant,
    last_timestamp: Instant,
    sys: System,
    pid: Pid,
}

impl DumpProgressLogger {
    pub fn new(bytes_size_of_dump: u64, log_title: String) -> Self {
        let now = Instant::now();
        Self {
            title: log_title,
            dump_bytes_size: bytes_size_of_dump,
            last_parsed_amount: 0,
            last_bytes_read_amount: 0,
            start_timestamp: now,
            last_timestamp: now,
            sys: System::new(),
            pid: get_current_pid().expect("Could not get current PID."),
        }
    }

    pub fn log(&mut self, bytes_read_amount: u64, parsed_amount: u64) {
        let now_timestamp = Instant::now();
        let mo_read = bytes_read_amount as f64 / 1024.0 / 1024.0;
        let mo_since = (bytes_read_amount - self.last_bytes_read_amount) as f64 / 1024.0 / 1024.0;

        let total_spend_time = self.start_timestamp.elapsed().as_secs_f64();
        let spend_time = self.last_timestamp.elapsed().as_secs_f64();

        if spend_time == 0.0 {
            return; // Avoid division by zero if called too frequently
        }

        let last_amount_parsed = parsed_amount - self.last_parsed_amount;
        let parsed_per_sec = last_amount_parsed as f64 / spend_time;
        let mo_per_sec = mo_since / spend_time;

        let estimation = if mo_per_sec > 0.0 {
            let mo_remain = (self.dump_bytes_size - bytes_read_amount) as f64 / 1024.0 / 1024.0;
            let est_in_sec = (mo_remain / mo_per_sec).floor() as u64;
            let h = est_in_sec / 3600;
            let m = (est_in_sec % 3600) / 60;
            let s = est_in_sec % 60;
            format!("{:02}h{:02}m{:02}s", h, m, s)
        } else {
            "N/A".to_string()
        };

        self.sys.refresh_all();
        let ram = if let Some(process) = self.sys.process(self.pid) {
            process.memory() as f64 / 1024.0 / 1024.0
        } else {
            0.0
        };

        self.last_timestamp = now_timestamp;
        self.last_parsed_amount = parsed_amount;
        self.last_bytes_read_amount = bytes_read_amount;

        println!(
            "\n\n{} -> {} parsed\nRam : {:.2} mo\n{:.2} s\n{:.2} parsed / s\n{:.2} mo/s\n{:.2} / {:.2} mo\n{} estimation of time left\n\n",
            self.title,
            parsed_amount,
            ram,
            total_spend_time,
            parsed_per_sec,
            mo_per_sec,
            mo_read,
            self.dump_bytes_size as f64 / 1024.0 / 1024.0,
            estimation
        );
    }
}