//! 测试用的本地假 WebDAV 服务器（只在 `cfg(test)` 编译）。
//!
//! 模拟 PROPFIND / PUT / DELETE 三种请求，支持失败注入、延迟与请求记录；
//! 只监听 `127.0.0.1:0`，测试之间互不影响，绝不联网。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;

#[derive(Default)]
pub(crate) struct FakeState {
    pub files: BTreeMap<String, (Vec<u8>, i64)>,
    /// 接下来多少个请求直接返回 `fail_status`。
    pub fail_requests: usize,
    pub fail_status: u16,
    pub delay: Duration,
    pub requests: Vec<String>,
    pub authorization: Vec<String>,
    /// 非 0 时 PROPFIND 返回这么多字节的填充体，用来测试出站响应上限。
    pub oversized_propfind_bytes: usize,
}

pub(crate) struct FakeDav {
    pub base_url: String,
    state: Arc<Mutex<FakeState>>,
    task: tokio::task::JoinHandle<()>,
}

impl FakeDav {
    pub(crate) async fn start(state: FakeState) -> Self {
        let state = Arc::new(Mutex::new(state));
        let app = Router::new().fallback(handler).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定本地假服务器失败");
        let addr = listener.local_addr().expect("读取本地端口失败");
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            base_url: format!("http://{addr}/dav"),
            state,
            task,
        }
    }

    pub(crate) fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Drop for FakeDav {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn handler(
    State(state): State<Arc<Mutex<FakeState>>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (delay, fail, fail_status, depth) = {
        let mut guard = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .requests
            .push(format!("{} {}", method.as_str(), uri.path()));
        if let Some(value) = headers.get("authorization") {
            guard
                .authorization
                .push(value.to_str().unwrap_or("").to_string());
        }
        let depth = headers
            .get("depth")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let delay = guard.delay;
        let fail = guard.fail_requests > 0;
        if fail {
            guard.fail_requests -= 1;
        }
        (delay, fail, guard.fail_status, depth)
    };

    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    if fail {
        return (
            StatusCode::from_u16(fail_status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            "fake failure",
        )
            .into_response();
    }

    let name = uri
        .path()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string();

    match method.as_str() {
        "PUT" => {
            let mut guard = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.files.insert(name, (body.to_vec(), 1_763_197_533));
            StatusCode::CREATED.into_response()
        }
        "DELETE" => {
            let mut guard = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.files.remove(&name);
            StatusCode::NO_CONTENT.into_response()
        }
        "PROPFIND" => {
            let guard = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if guard.oversized_propfind_bytes > 0 {
                return (
                    StatusCode::MULTI_STATUS,
                    [("content-type", "application/xml; charset=utf-8")],
                    " ".repeat(guard.oversized_propfind_bytes),
                )
                    .into_response();
            }
            let mut xml = String::from(
                "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:multistatus xmlns:d=\"DAV:\">",
            );
            xml.push_str(&format!(
                "<d:response><d:href>{}/</d:href><d:propstat><d:prop>\
                 <d:resourcetype><d:collection/></d:resourcetype>\
                 </d:prop></d:propstat></d:response>",
                base_path(&uri)
            ));
            if depth == "1" {
                for (name, (content, modified)) in &guard.files {
                    let stamp = chrono::DateTime::from_timestamp(*modified, 0)
                        .unwrap_or_else(|| {
                            chrono::DateTime::from_timestamp(0, 0).expect("epoch is valid")
                        })
                        .format("%a, %d %b %Y %H:%M:%S GMT");
                    xml.push_str(&format!(
                        "<d:response><d:href>{}/{name}</d:href><d:propstat><d:prop>\
                         <d:resourcetype/><d:getcontentlength>{}</d:getcontentlength>\
                         <d:getlastmodified>{stamp}</d:getlastmodified>\
                         </d:prop></d:propstat></d:response>",
                        base_path(&uri),
                        content.len()
                    ));
                }
            }
            xml.push_str("</d:multistatus>");
            (
                StatusCode::MULTI_STATUS,
                [("content-type", "application/xml; charset=utf-8")],
                xml,
            )
                .into_response()
        }
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

fn base_path(uri: &Uri) -> String {
    let path = uri.path().trim_end_matches('/');
    match path.rfind('/') {
        Some(index) => path[..index].to_string(),
        None => path.to_string(),
    }
}
