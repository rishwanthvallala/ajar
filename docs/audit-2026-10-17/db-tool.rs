// Local audit fault-injection helper. Never use against production databases.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let db = rusqlite::Connection::open(&args[1])?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    db.execute_batch(&args[2])?;
    Ok(())
}
