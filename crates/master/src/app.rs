use axum::routing::{get, post};
use axum::Router;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::routes;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    let index = state.web_dir.join("index.html");
    let static_files = ServeDir::new(state.web_dir.as_path()).fallback(ServeFile::new(index));

    Router::new()
        .route("/api/v1/health", get(routes::system::health))
        .route("/api/v1/auth/login", post(routes::auth::login))
        .route("/api/v1/auth/logout", post(routes::auth::logout))
        .route("/api/v1/auth/me", get(routes::auth::me))
        .route(
            "/api/v1/servers",
            get(routes::servers::list).post(routes::servers::create),
        )
        .route("/api/agent/ws", get(routes::agent::ws))
        .with_state(state)
        .fallback_service(static_files)
        .layer(TraceLayer::new_for_http())
}
