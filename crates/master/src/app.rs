use axum::routing::{get, patch, post};
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
        .route(
            "/api/v1/servers/{id}/nodes",
            get(routes::nodes::list).post(routes::nodes::create),
        )
        .route(
            "/api/v1/nodes/{id}",
            patch(routes::nodes::update).delete(routes::nodes::delete),
        )
        .route("/api/v1/servers/{id}/apply", post(routes::nodes::apply))
        .route(
            "/api/v1/users",
            get(routes::users::list).post(routes::users::create),
        )
        .route(
            "/api/v1/users/{id}",
            patch(routes::users::update).delete(routes::users::delete),
        )
        .route(
            "/api/v1/users/{id}/packages",
            get(routes::users::list_user_packages).post(routes::users::create_user_package),
        )
        .route(
            "/api/v1/user-packages/{id}",
            patch(routes::users::update_user_package).delete(routes::users::delete_user_package),
        )
        .route(
            "/api/v1/packages",
            get(routes::packages::list).post(routes::packages::create),
        )
        .route(
            "/api/v1/packages/{id}",
            patch(routes::packages::update).delete(routes::packages::delete),
        )
        .route(
            "/api/v1/certificates",
            get(routes::certificates::list).post(routes::certificates::create),
        )
        .route(
            "/api/v1/certificates/{id}",
            axum::routing::delete(routes::certificates::delete),
        )
        .route("/api/v1/stats/overview", get(routes::stats::overview))
        .route("/api/v1/stats/traffic", get(routes::stats::traffic))
        .route(
            "/api/v1/enforcement/events",
            get(routes::enforcement::events),
        )
        // 公开订阅入口：不加鉴权，短码即凭证。
        .route("/api/v1/sub/{short_code}", get(routes::subscribe::get))
        .route("/api/agent/ws", get(routes::agent::ws))
        .with_state(state)
        .fallback_service(static_files)
        .layer(TraceLayer::new_for_http())
}
