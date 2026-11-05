use std::sync::Arc;

use mmrust_domain::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
    pub web_dir: Arc<std::path::PathBuf>,
}

impl AppState {
    pub fn new(db: Db, web_dir: impl Into<std::path::PathBuf>) -> Self {
        Self {
            db: Arc::new(db),
            web_dir: Arc::new(web_dir.into()),
        }
    }
}
