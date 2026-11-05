//! claude.ai artifacts shown inside the window (requested 2026-10-29: "When creating artifact
//! can you allow to open it in-app like happens on claude code app? Right now it's opening in
//! the chrome"). claude.ai refuses to be framed (`frame-ancestors 'self'`), so the window shows
//! an artifact in a WebView2 of its own that the page places over the panel or dialog holding it
//! (`ClaudePageViewer.svelte`): a wry child webview of the main window, made outside Tauri, so it
//! carries no IPC, no init scripts and no custom protocols, and what it loads reaches nothing of
//! the app. An artifact is private to the account that published it, so each Claude account has
//! a claude.ai session of its own, a WebView2 profile folder under app data `claude-ai/<account>/`,
//! which the reader signs in to once. Windows only: elsewhere the link opens in the browser. See
//! docs/CAPABILITIES.md.
use serde::Deserialize;

/// The event that tells the page whether a pane has keyboard focus, which the window still has.
#[cfg_attr(not(windows), allow(dead_code))]
const FOCUS_EVENT: &str = "studio-claude-page-focus";
/// The event that tells the page an account's pane ended with its browser process.
#[cfg_attr(not(windows), allow(dead_code))]
const ENDED_EVENT: &str = "studio-claude-page-ended";
#[cfg(not(windows))]
const UNSUPPORTED: &str = "claude.ai artifacts open in the browser on this computer.";

/// What the page asks of the pane of the view it shows.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Request {
    /// Orders the page's requests: one that arrives after a later one changes nothing.
    pub seq: u64,
    /// The view asking, so that a view going away hides only a pane it showed.
    pub view: String,
    /// The Claude account whose claude.ai session shows the artifact.
    pub account: String,
    pub url: String,
    /// Which loading of the artifact the view shows: a new one loads the artifact again.
    pub load: String,
    /// The view's slot in the window, in CSS pixels, or none while it is hidden or covered.
    pub bounds: Option<Bounds>,
    pub dark: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A name the page gives a view or a loading: a UUID, or anything as short and plain.
#[cfg_attr(not(windows), allow(dead_code))]
fn plain(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// An account's id as its profile folder is named.
fn account_id(id: &str) -> Result<String, String> {
    uuid::Uuid::parse_str(id)
        .ok()
        .filter(|_| id.len() == 36)
        .map(|id| id.to_string())
        .ok_or_else(|| "Unknown account".into())
}

impl Request {
    /// The request as it is carried out, or why it is refused: only an artifact's own link on
    /// claude.ai, in a slot inside the window.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn checked(mut self) -> Result<Self, String> {
        if !plain(&self.view) || !plain(&self.load) {
            return Err("Unknown view".into());
        }
        self.account = account_id(&self.account)?;
        if !crate::providers::published_artifacts::valid_url(&self.url) {
            return Err("Only claude.ai artifacts open here".into());
        }
        self.bounds = match self.bounds {
            Some(b) if [b.x, b.y, b.width, b.height].iter().any(|v| !v.is_finite()) => {
                return Err("Unknown place".into())
            }
            // A slot not laid out yet shows nothing.
            Some(b) if b.width < 1.0 || b.height < 1.0 => None,
            bounds => bounds,
        };
        Ok(self)
    }
}

/// Where a link the pane follows opens.
#[derive(Debug, PartialEq)]
#[cfg_attr(not(windows), allow(dead_code))]
enum Destination {
    /// In the pane: claude.ai, and every page it signs in through.
    Pane,
    /// In the browser, or the mail or phone app.
    Outside,
    /// Nowhere: files, scripts and the browser's own pages.
    Nowhere,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn destination(url: &str) -> Destination {
    let scheme = url
        .split_once(':')
        .map(|(scheme, _)| scheme.to_ascii_lowercase());
    match scheme.as_deref() {
        Some("https") => Destination::Pane,
        Some("http" | "mailto" | "tel") => Destination::Outside,
        _ => Destination::Nowhere,
    }
}

/// Whether a window a page opens on a click stays in the pane's session instead of going to the
/// browser. Continue with Google opens Google's sign-in in a window and takes the result from it
/// through `window.opener`, which a window in the browser does not have: it ended blank at
/// `gsi/transform`, and claude.ai, handed no window, showed its sign-in error.
#[cfg_attr(not(windows), allow(dead_code))]
fn answers_its_opener(url: &str) -> bool {
    tauri::Url::parse(url)
        .is_ok_and(|url| url.scheme() == "https" && url.host_str() == Some("accounts.google.com"))
}

/// Shows an artifact in its account's pane, or hides the pane a view showed.
#[tauri::command]
pub async fn claude_page(
    app: tauri::AppHandle,
    call: crate::calls::Call,
    request: Request,
) -> Result<(), String> {
    call.once(async move {
        #[cfg(windows)]
        {
            let request = request.checked()?;
            native::on_window(&app, move |app| native::apply(app, request)).await
        }
        #[cfg(not(windows))]
        {
            let _ = (app, request);
            Err(UNSUPPORTED.into())
        }
    })
    .await
}

/// Closes the panes of every account but `keep`, the accounts whose artifacts chats still show.
#[tauri::command]
pub async fn close_claude_pages(
    app: tauri::AppHandle,
    call: crate::calls::Call,
    keep: Vec<String>,
) -> Result<(), String> {
    call.once(async move {
        let keep = keep
            .iter()
            .map(|id| account_id(id))
            .collect::<Result<Vec<_>, _>>()?;
        #[cfg(windows)]
        {
            native::on_window(&app, move |_| {
                native::close_except(&keep);
                Ok(())
            })
            .await
        }
        #[cfg(not(windows))]
        {
            let _ = (app, keep);
            Ok(())
        }
    })
    .await
}

/// A new document in the window shows no panes, and numbers its requests from the start.
pub fn page_loaded(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        let _ = app.run_on_main_thread(native::reset);
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// The window moved, which WebView2 needs to hear to place the pane's own menus and dialogs.
/// Runs on the window thread, as the window's events do.
pub fn window_moved() {
    #[cfg(windows)]
    native::moved();
}

#[cfg(windows)]
mod native {
    use super::{
        answers_its_opener, destination, Bounds, Destination, Request, ENDED_EVENT, FOCUS_EVENT,
    };
    use std::cell::RefCell;
    use tauri::{AppHandle, Manager};
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{DestroyWindow, GetParent},
    };
    use wry::{
        dpi::{LogicalPosition, LogicalSize},
        MemoryUsageLevel, Rect, Theme, WebContext, WebView, WebViewBuilder, WebViewExtWindows,
    };

    struct Pane {
        account: String,
        webview: WebView,
        /// The window wry made to hold it, inside the main window.
        container: isize,
        /// The main window it was made in: one built again (window_recovery.rs) needs new panes.
        window: isize,
        url: String,
        load: String,
        dark: bool,
        _context: WebContext,
    }

    #[derive(Default)]
    struct Panes {
        list: Vec<Pane>,
        /// The view whose request showed a pane last, and that pane's account.
        shown: Option<(String, String)>,
        /// The latest request carried out.
        seq: u64,
    }

    thread_local! {
        static PANES: RefCell<Panes> = RefCell::new(Panes::default());
    }

    /// Runs `work` on the window thread, where WebView2 lives, and waits for its answer.
    pub async fn on_window<T: Send + 'static>(
        app: &AppHandle,
        work: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (done, answer) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = done.send(work(&handle));
        })
        .map_err(|_| "The window is not answering")?;
        answer.await.map_err(|_| "The window is not answering")?
    }

    fn rect(bounds: Bounds) -> Rect {
        Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        }
    }

    /// The window's own background (`--bg`) while claude.ai loads, so a pane never flashes.
    fn background(dark: bool) -> (u8, u8, u8, u8) {
        if dark {
            (17, 17, 19, 255)
        } else {
            (255, 255, 255, 255)
        }
    }

    pub fn apply(app: &AppHandle, request: Request) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .ok_or("The window is not open")?;
        let hwnd = window.hwnd().map_err(|_| "The window is not open")?.0 as isize;
        let Some(bounds) = request.bounds else {
            PANES.with_borrow_mut(|panes| {
                if newer(panes, request.seq)
                    && panes
                        .shown
                        .as_ref()
                        .is_some_and(|(view, _)| *view == request.view)
                {
                    panes.shown = None;
                    for pane in &panes.list {
                        hide(pane);
                    }
                }
            });
            return Ok(());
        };
        let shown = PANES.with_borrow_mut(|panes| {
            if !newer(panes, request.seq) {
                return Some(Ok(()));
            }
            // Panes of a window that is gone went with it.
            let (kept, gone): (Vec<_>, Vec<_>) = std::mem::take(&mut panes.list)
                .into_iter()
                .partition(|pane| pane.window == hwnd);
            panes.list = kept;
            gone.into_iter().for_each(close);
            panes.shown = Some((request.view.clone(), request.account.clone()));
            for pane in panes.list.iter().filter(|p| p.account != request.account) {
                hide(pane);
            }
            let pane = panes
                .list
                .iter_mut()
                .find(|pane| pane.account == request.account)?;
            Some(show(pane, &request, bounds))
        });
        if let Some(result) = shown {
            return result;
        }
        // WebView2 starts while the window thread keeps taking messages, so nothing is borrowed
        // meanwhile, and a request carried out meanwhile still decides what shows.
        let pane = build(app, &window, hwnd, &request, bounds)?;
        PANES.with_borrow_mut(|panes| {
            if panes.list.iter().any(|p| p.account == request.account) {
                close(pane);
                return;
            }
            let wanted = panes
                .shown
                .as_ref()
                .is_some_and(|(_, account)| *account == pane.account);
            if !wanted {
                hide(&pane);
            }
            panes.list.push(pane);
        });
        Ok(())
    }

    /// Whether a request is later than every one carried out, which it then becomes.
    fn newer(panes: &mut Panes, seq: u64) -> bool {
        if seq <= panes.seq {
            return false;
        }
        panes.seq = seq;
        true
    }

    fn show(pane: &mut Pane, request: &Request, bounds: Bounds) -> Result<(), String> {
        let failed = |e: wry::Error| format!("Cannot show claude.ai here: {e}");
        if pane.dark != request.dark {
            pane.dark = request.dark;
            let _ = pane.webview.set_theme(theme(request.dark));
            let _ = pane.webview.set_background_color(background(request.dark));
        }
        if pane.url != request.url || pane.load != request.load {
            pane.webview.load_url(&request.url).map_err(failed)?;
            pane.url = request.url.clone();
            pane.load = request.load.clone();
        }
        pane.webview.set_bounds(rect(bounds)).map_err(failed)?;
        let _ = pane
            .webview
            .set_memory_usage_level(MemoryUsageLevel::Normal);
        pane.webview.set_visible(true).map_err(failed)
    }

    fn hide(pane: &Pane) {
        let _ = pane.webview.set_visible(false);
        // A hidden pane gives back what memory it can until it shows again.
        let _ = pane.webview.set_memory_usage_level(MemoryUsageLevel::Low);
    }

    fn theme(dark: bool) -> Theme {
        if dark {
            Theme::Dark
        } else {
            Theme::Light
        }
    }

    fn build(
        app: &AppHandle,
        window: &tauri::WebviewWindow,
        hwnd: isize,
        request: &Request,
        bounds: Bounds,
    ) -> Result<Pane, String> {
        let folder = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate app data")?
            .join("claude-ai")
            .join(&request.account);
        std::fs::create_dir_all(&folder).map_err(|e| format!("Cannot keep claude.ai here: {e}"))?;
        let mut context = WebContext::new(Some(folder));
        let opener = app.clone();
        let webview = WebViewBuilder::new_with_web_context(&mut context)
            .with_url(&request.url)
            .with_bounds(rect(bounds))
            .with_focused(false)
            .with_background_color(background(request.dark))
            .with_devtools(cfg!(debug_assertions))
            .with_hotkeys_zoom(true)
            .with_clipboard(true)
            .with_navigation_handler(move |url| match destination(&url) {
                Destination::Pane => true,
                Destination::Outside => {
                    open_outside(&opener, &url);
                    false
                }
                Destination::Nowhere => false,
            })
            .build_as_child(window)
            .map_err(|e| format!("Cannot show claude.ai here: {e}"))?;
        let _ = webview.set_theme(theme(request.dark));
        let controller = webview.controller();
        let mut container = HWND::default();
        // SAFETY: the pane's live WebView2 controller, on the window thread.
        let _ = unsafe { controller.ParentWindow(&mut container) };
        let container = container.0 as isize;
        watch(app, &webview, &request.account, container);
        Ok(Pane {
            account: request.account.clone(),
            webview,
            container,
            window: hwnd,
            url: request.url.clone(),
            load: request.load.clone(),
            dark: request.dark,
            _context: context,
        })
    }

    /// Tells the page when the pane takes or leaves keyboard focus, opens the windows its pages
    /// ask for in the browser, as a click did, but for a sign-in window that answers the page
    /// that opened it, which WebView2 opens itself, and closes the pane once its browser process
    /// ends, which leaves it empty for good: Reload then builds it again.
    fn watch(app: &AppHandle, webview: &WebView, account: &str, container: isize) {
        use webview2_com::{
            FocusChangedEventHandler,
            Microsoft::Web::WebView2::Win32::{
                COREWEBVIEW2_PROCESS_FAILED_KIND,
                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
            },
            NewWindowRequestedEventHandler, ProcessFailedEventHandler,
        };
        use windows::core::{BOOL, PWSTR};
        let focus = |focused: bool| {
            let app = app.clone();
            FocusChangedEventHandler::create(Box::new(move |_, _| {
                let _ = tauri::Emitter::emit_to(&app, "main", FOCUS_EVENT, focused);
                Ok(())
            }))
        };
        let opener = app.clone();
        let windows = NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            // SAFETY: WebView2 calls this on the window thread with live event arguments, and
            // the address it returns is freed by `take_pwstr`.
            unsafe {
                let mut clicked = BOOL(0);
                args.IsUserInitiated(&mut clicked)?;
                let clicked = clicked.as_bool();
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = webview2_com::take_pwstr(uri);
                // Not handled, which undoes wry's own handler before this one, WebView2 opens
                // the window itself in this session, with its address shown and no way into the
                // app, and it closes with the app.
                let opens_here = clicked && answers_its_opener(&uri);
                args.SetHandled(!opens_here)?;
                if clicked && !opens_here && destination(&uri) != Destination::Nowhere {
                    open_outside(&opener, &uri);
                }
            }
            Ok(())
        }));
        let (handle, account) = (app.clone(), account.to_owned());
        let failed = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            // SAFETY: WebView2 calls this on the window thread with live event arguments.
            unsafe { args.ProcessFailedKind(&mut kind)? };
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                let (app, account) = (handle.clone(), account.clone());
                let _ = handle.run_on_main_thread(move || ended(&app, &account, container));
            }
            Ok(())
        }));
        let controller = webview.controller();
        let mut token = 0;
        // SAFETY: the pane's live WebView2, on the window thread.
        unsafe {
            let _ = controller.add_GotFocus(&focus(true), &mut token);
            let _ = controller.add_LostFocus(&focus(false), &mut token);
            if let Ok(webview) = controller.CoreWebView2() {
                let _ = webview.add_NewWindowRequested(&windows, &mut token);
                let _ = webview.add_ProcessFailed(&failed, &mut token);
            }
        }
    }

    /// The pane of `account` held in `container` lost its browser process: it closes, and the
    /// page hears so.
    fn ended(app: &AppHandle, account: &str, container: isize) {
        let gone = PANES.with_borrow_mut(|panes| {
            let index = panes
                .list
                .iter()
                .position(|p| p.account == account && p.container == container)?;
            Some(panes.list.remove(index))
        });
        if let Some(pane) = gone {
            close(pane);
            let _ = tauri::Emitter::emit_to(app, "main", ENDED_EVENT, account);
        }
    }

    /// Opens a link in the browser off the window thread, which WebView2's events run on.
    fn open_outside(app: &AppHandle, url: &str) {
        use tauri_plugin_opener::OpenerExt;
        let (app, url) = (app.clone(), url.to_owned());
        tauri::async_runtime::spawn_blocking(move || {
            let _ = app.opener().open_url(url, None::<&str>);
        });
    }

    /// Closes a pane. wry's own drop would also remove the main window's hook that keeps Tauri's
    /// webview the size of the window (`dettach_parent_subclass`, which it runs for a child
    /// webview too), so the pane closes its WebView2 and its holder itself and leaves wry's
    /// handle unused.
    fn close(pane: Pane) {
        let Pane {
            webview,
            container,
            window,
            ..
        } = pane;
        // SAFETY: the pane's controller, on the window thread; its holder is destroyed only
        // while it is still the window wry made inside this pane's main window.
        unsafe {
            let _ = webview.controller().Close();
            let holder = HWND(container as _);
            if GetParent(holder).is_ok_and(|parent| parent.0 as isize == window) {
                let _ = DestroyWindow(holder);
            }
        }
        std::mem::forget(webview);
    }

    pub fn close_except(keep: &[String]) {
        PANES.with_borrow_mut(|panes| {
            let (kept, gone): (Vec<_>, Vec<_>) = std::mem::take(&mut panes.list)
                .into_iter()
                .partition(|pane| keep.contains(&pane.account));
            panes.list = kept;
            gone.into_iter().for_each(close);
        });
    }

    pub fn reset() {
        PANES.with_borrow_mut(|panes| {
            std::mem::take(&mut panes.list).into_iter().for_each(close);
            panes.shown = None;
            panes.seq = 0;
        });
    }

    pub fn moved() {
        let _ = PANES.try_with(|cell| {
            if let Ok(panes) = cell.try_borrow() {
                for pane in &panes.list {
                    // SAFETY: the pane's live controller, on the window thread.
                    let _ = unsafe {
                        pane.webview
                            .controller()
                            .NotifyParentWindowPositionChanged()
                    };
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(bounds: Option<Bounds>) -> Request {
        Request {
            seq: 1,
            view: "8d7cf1b4-6a0f-4b8e-9a52-2f8c7c3d1e90".into(),
            account: "6C3F1E2A-8B9D-4E7F-A1B2-C3D4E5F60718".into(),
            url: "https://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3ax".into(),
            load: "1".into(),
            bounds,
            dark: true,
        }
    }
    const SLOT: Bounds = Bounds {
        x: 760.0,
        y: 48.0,
        width: 520.5,
        height: 700.0,
    };

    #[test]
    fn only_a_claude_ai_artifact_opens_in_a_pane_inside_the_window() {
        let checked = request(Some(SLOT)).checked().unwrap();
        // The account names its profile folder in one form.
        assert_eq!(checked.account, "6c3f1e2a-8b9d-4e7f-a1b2-c3d4e5f60718");
        assert_eq!(checked.bounds, Some(SLOT));
        for url in [
            "https://claude.ai/",
            "https://claude.ai/login",
            "https://example.com/artifact/D6UUK2MDNtEQ65Mn61b3ax",
            "file:///C:/Windows/win.ini",
        ] {
            let mut asked = request(Some(SLOT));
            asked.url = url.into();
            assert!(asked.checked().is_err(), "{url}");
        }
        let mut asked = request(Some(SLOT));
        asked.account = "../../profiles".into();
        assert!(asked.checked().is_err());
        let mut asked = request(Some(SLOT));
        asked.view = "a b".into();
        assert!(asked.checked().is_err());
    }

    #[test]
    fn a_slot_without_room_hides_the_pane_and_a_broken_one_is_refused() {
        let flat = Bounds {
            height: 0.0,
            ..SLOT
        };
        assert_eq!(request(Some(flat)).checked().unwrap().bounds, None);
        assert_eq!(request(None).checked().unwrap().bounds, None);
        let broken = Bounds {
            x: f64::NAN,
            ..SLOT
        };
        assert!(request(Some(broken)).checked().is_err());
    }

    #[test]
    fn only_google_s_sign_in_window_keeps_its_opener() {
        for url in [
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&display=popup",
            "https://accounts.google.com/gsi/select",
            "HTTPS://ACCOUNTS.GOOGLE.COM/",
        ] {
            assert!(answers_its_opener(url), "{url}");
        }
        for url in [
            "http://accounts.google.com/",
            "https://accounts.google.com.example.com/",
            "https://accounts.google.com@example.com/",
            "https://example.com/accounts.google.com",
            "https://example.com/?u=https://accounts.google.com/",
            "https://google.com/",
            "https://claude.ai/",
            "https://appleid.apple.com/auth/authorize",
            "javascript:alert(1)",
            "about:blank",
            "",
        ] {
            assert!(!answers_its_opener(url), "{url}");
        }
    }

    #[test]
    fn claude_ai_and_its_sign_in_pages_stay_in_the_pane_and_other_links_leave_it() {
        assert_eq!(
            destination("https://claude.ai/code/artifact/x"),
            Destination::Pane
        );
        assert_eq!(
            destination("https://accounts.google.com/o/oauth2"),
            Destination::Pane
        );
        assert_eq!(destination("HTTP://example.com"), Destination::Outside);
        assert_eq!(destination("mailto:a@example.com"), Destination::Outside);
        for url in [
            "file:///C:/",
            "javascript:alert(1)",
            "data:text/html,hi",
            "about:blank",
            "edge://settings",
            "",
        ] {
            assert_eq!(destination(url), Destination::Nowhere, "{url}");
        }
    }
}
