use anyhow::{Context, Result, bail};
use async_tungstenite::{tokio::connect_async, tungstenite::Message};
use chromiumoxide::cdp::browser_protocol::accessibility::{
    EnableParams as AxEnableParams, GetFullAxTreeParams,
};
use chromiumoxide::page::ScreenshotParams;
use chromiumoxide::{Browser, Page};
use clap::{Parser, Subcommand};
use futures::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};

#[derive(Parser)]
#[command(
    name = "brave-cli",
    version,
    about = "Safe Brave control and no-screenshot page inspection"
)]
struct Cli {
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long = "allow-domain")]
    allow: Vec<String>,
    #[arg(long)]
    dry_run: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Clone)]
enum Command {
    Doctor,
    Start {
        #[arg(long, default_value_t = 9222)]
        port: u16,
        #[arg(long)]
        user_data_dir: Option<PathBuf>,
    },
    Tabs,
    Navigate {
        url: String,
    },
    Tab {
        #[command(subcommand)]
        command: TabCommand,
    },
    Inspect {
        #[arg(long, default_value = "text", value_parser = ["text", "json", "dom"])]
        format: String,
        #[arg(long, default_value_t = 500)]
        max_nodes: usize,
    },
    Click {
        selector: String,
        #[arg(long)]
        confirm: bool,
    },
    Fill {
        selector: String,
        value: String,
        #[arg(long)]
        confirm: bool,
    },
    Evaluate {
        javascript: String,
        #[arg(long)]
        confirm: bool,
    },
    Run {
        workflow: PathBuf,
        #[arg(long)]
        confirm: bool,
    },
    Page {
        #[command(subcommand)]
        command: PageCommand,
    },
}

#[derive(Subcommand, Clone)]
enum TabCommand {
    Open { url: String },
}

#[derive(Subcommand, Clone)]
enum PageCommand {
    Screenshot { filename: PathBuf },
}

#[derive(Deserialize, Default)]
struct FileConfig {
    brave_cli: Option<Config>,
}

#[derive(Deserialize)]
struct Config {
    cdp_url: Option<String>,
    allowed_domains: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    url: String,
    title: String,
    viewport: ViewportInfo,
    scroll: ScrollInfo,
    focused: Option<String>,
    page_text: String,
    visible_elements: Vec<ElementInfo>,
    accessibility_tree: Vec<AxInfo>,
    limits: String,
}

#[derive(Serialize, Deserialize)]
struct ViewportInfo {
    width: f64,
    height: f64,
    device_pixel_ratio: f64,
}
#[derive(Serialize, Deserialize)]
struct ScrollInfo {
    x: f64,
    y: f64,
    document_width: f64,
    document_height: f64,
}
#[derive(Serialize, Deserialize)]
struct ElementInfo {
    tag: String,
    role: String,
    name: String,
    text: String,
    selector: String,
    rect: Rect,
    disabled: bool,
}
#[derive(Serialize, Deserialize)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
#[derive(Serialize, Deserialize)]
struct AxInfo {
    role: String,
    name: String,
    description: String,
}

const INSPECT_JS: &str = r#"() => {
  const sensitive = /password|passwd|secret|token|cookie|authorization|api[_-]?key|credential|private|cvv|card/i;
  const clean = (s) => (s || '').replace(/\b(password|passwd|secret|token|cookie|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]').slice(0, 1200);
  const visible = (e) => { const r=e.getBoundingClientRect(),s=getComputedStyle(e); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity)>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth; };
  const name = (e) => clean(e.getAttribute('aria-label') || e.getAttribute('alt') || e.getAttribute('title') || e.innerText || e.textContent || '');
  const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role],iframe,video,canvas,img,summary')].filter(visible).slice(0, 1200).map((e,i) => {
    const r=e.getBoundingClientRect(), tag=e.tagName.toLowerCase(), type=(e.getAttribute('type')||'').toLowerCase();
    const secret=e.matches('input,textarea,[contenteditable="true"]') && (type==='password' || sensitive.test([e.name,e.id,e.getAttribute('autocomplete'),e.getAttribute('aria-label'),e.getAttribute('placeholder'),e.labels?[...e.labels].map(l=>l.innerText).join(' '):''].join(' ')));
    const label=secret ? '[REDACTED FIELD]' : name(e);
    return {tag, role:e.getAttribute('role')||({a:'link',button:'button',input:'textbox',textarea:'textbox',select:'combobox'}[tag]||tag), name:label, text:secret?'[REDACTED]':clean(e.value||e.innerText||e.textContent||''), selector:e.id?'#'+CSS.escape(e.id):`${tag}:nth-of-type(${[...e.parentElement.children].filter(x=>x.tagName===e.tagName).indexOf(e)+1})`, rect:{x:r.x,y:r.y,width:r.width,height:r.height},disabled:!!e.disabled};
  });
  const active=document.activeElement;
  let pageText=clean(document.body?.innerText||'');
  for (const e of document.querySelectorAll('input,textarea,[contenteditable="true"]')) if (e.type==='password' || sensitive.test([e.name,e.id,e.getAttribute('autocomplete'),e.getAttribute('aria-label'),e.getAttribute('placeholder'),e.labels?[...e.labels].map(l=>l.innerText).join(' '):''].join(' '))) { if(e.value) pageText=pageText.replaceAll(e.value,'[REDACTED]'); }
  const activeSecret=active && active.matches('input,textarea,[contenteditable="true"]') && (active.type==='password' || sensitive.test([active.name,active.id,active.getAttribute('autocomplete'),active.getAttribute('aria-label'),active.getAttribute('placeholder'),active.labels?[...active.labels].map(l=>l.innerText).join(' '):''].join(' ')));
  return {viewport:{width:innerWidth,height:innerHeight,device_pixel_ratio:devicePixelRatio},scroll:{x:scrollX,y:scrollY,document_width:document.documentElement.scrollWidth,document_height:document.documentElement.scrollHeight},focused:active&&active!==document.body?(activeSecret?'[REDACTED FIELD]':name(active)):null,page_text:pageText,visible_elements:elements};
}"#;

fn redact(input: &str) -> String {
    Regex::new(
        r"(?i)(password|passwd|secret|token|cookie|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+",
    )
    .expect("constant regex")
    .replace_all(input, "$1=[REDACTED]")
    .into_owned()
}

fn require_confirmation(operation: &str, confirmed: bool) -> Result<()> {
    let risky = Regex::new(
        r"(?i)\b(send|publish|purchase|buy|delete|remove|upload|download|account|password|credential|submit)\b",
    )?;
    if risky.is_match(operation) && !confirmed {
        bail!("confirmation required for risky operation; pass --confirm");
    }
    Ok(())
}

fn validate_javascript(script: &str, confirmed: bool) -> Result<()> {
    let blocked = Regex::new(
        r"(?i)(cookie|local\s*storage|session\s*storage|indexed\s*db|credentials|service\s*worker|document\s*\.\s*(?:forms|location)\s*\.\s*(?:submit|assign|replace)|window\s*\.\s*open)",
    )?;
    if blocked.is_match(script) {
        bail!("JavaScript access to cookies, storage, and credentials is blocked");
    }
    if !confirmed {
        bail!("page-context JavaScript requires --confirm; it can act with the page's permissions");
    }
    Ok(())
}

fn brave_executable() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let candidates = [
            std::env::var("PROGRAMFILES").ok().map(|p| {
                PathBuf::from(p).join("BraveSoftware/Brave-Browser/Application/brave.exe")
            }),
            std::env::var("LOCALAPPDATA").ok().map(|p| {
                PathBuf::from(p).join("BraveSoftware/Brave-Browser/Application/brave.exe")
            }),
        ];
        return candidates.into_iter().flatten().find(|p| p.is_file());
    }
    #[cfg(not(windows))]
    {
        ["brave", "brave-browser"].iter().find_map(|name| {
            std::env::var_os("PATH")
                .into_iter()
                .flat_map(|path| std::env::split_paths(&path))
                .map(|dir| dir.join(name))
                .find(|path| path.is_file())
        })
    }
}

async fn run_workflow(
    path: &std::path::Path,
    cdp: &str,
    domains: &[String],
    confirmed: bool,
    dry_run: bool,
) -> Result<()> {
    let input = std::fs::read_to_string(path)
        .with_context(|| format!("cannot read workflow {}", path.display()))?;
    let yaml: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(&input).context("invalid workflow YAML")?;
    let steps = yaml
        .get("steps")
        .and_then(serde_yaml_ng::Value::as_sequence)
        .context("workflow must contain a steps list")?;
    for step in steps {
        let mapping = step
            .as_mapping()
            .context("each workflow step must be a mapping")?;
        if mapping.len() != 1 {
            bail!("each workflow step must contain exactly one action");
        }
        let (action, args) = mapping.iter().next().unwrap();
        let action = action
            .as_str()
            .context("workflow action name must be text")?;
        let args = args
            .as_mapping()
            .context("workflow action arguments must be a mapping")?;
        if args.contains_key(serde_yaml_ng::Value::String("dry_run".into())) {
            bail!("per-step dry_run is unsupported; use --dry-run for the entire workflow");
        }
        let get = |key: &str| {
            args.get(serde_yaml_ng::Value::String(key.to_owned()))
                .and_then(serde_yaml_ng::Value::as_str)
                .map(str::to_owned)
        };
        let step_dry_run = dry_run;
        match action {
            "navigate" | "open" => {
                let url = get("url").context("workflow navigation needs url")?;
                if !allowed(&url, domains) {
                    bail!("domain not in allowlist");
                }
                if !step_dry_run {
                    let (browser, page) = connect(cdp).await?;
                    if action == "navigate" {
                        page.goto(url).await?;
                    } else {
                        browser.new_page(url).await?;
                    }
                }
            }
            "click" => {
                let selector = get("selector").context("workflow click needs selector")?;
                require_confirmation(&format!("click {selector} submit"), confirmed)?;
                if !step_dry_run {
                    let (_browser, page) = connect(cdp).await?;
                    page.find_element(selector).await?.click().await?;
                }
            }
            "fill" => {
                let selector = get("selector").context("workflow fill needs selector")?;
                let value = get("value").context("workflow fill needs value")?;
                require_confirmation(&format!("fill {selector} account"), confirmed)?;
                if !step_dry_run {
                    fill_element(cdp, &selector, &value).await?;
                }
            }
            "evaluate" => {
                let script = get("javascript").context("workflow evaluate needs javascript")?;
                validate_javascript(&script, confirmed)?;
                if !step_dry_run {
                    let (_browser, page) = connect(cdp).await?;
                    let value = page
                        .evaluate(script)
                        .await?
                        .into_value::<serde_json::Value>()?;
                    println!("{}", redact(&value.to_string()));
                }
            }
            "screenshot" => {
                let file = get("file").context("workflow screenshot needs file")?;
                if !step_dry_run {
                    let (_browser, page) = connect(cdp).await?;
                    page.save_screenshot(ScreenshotParams::default(), file)
                        .await?;
                }
            }
            _ => bail!("unsupported workflow action: {action}"),
        }
    }
    Ok(())
}

async fn fill_element(cdp: &str, selector: &str, value: &str) -> Result<()> {
    let (_browser, page) = connect(cdp).await?;
    let selector = serde_json::to_string(selector)?;
    let value = serde_json::to_string(value)?;
    let script = format!(
        "(() => {{ const e=document.querySelector({selector}); if (!e) throw new Error('selector not found'); e.focus(); if ('value' in e) {{ e.value={value}; e.dispatchEvent(new Event('input',{{bubbles:true}})); e.dispatchEvent(new Event('change',{{bubbles:true}})); }} else {{ e.textContent={value}; e.dispatchEvent(new InputEvent('input',{{bubbles:true,data:{value},inputType:'insertText'}})); }} return true; }})() "
    );
    page.evaluate(script).await?;
    Ok(())
}

fn allowed(url: &str, domains: &[String]) -> bool {
    let host = url
        .split_once("://")
        .map(|(_, rest)| {
            rest.split(['/', '?', '#'])
                .next()
                .unwrap_or("")
                .rsplit('@')
                .next()
                .unwrap_or("")
                .split(':')
                .next()
                .unwrap_or("")
        })
        .unwrap_or("")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    !host.is_empty()
        && domains.iter().any(|d| {
            let domain = d
                .trim_start_matches('.')
                .trim_end_matches('.')
                .to_ascii_lowercase();
            host == domain
                || host
                    .strip_suffix(&domain)
                    .is_some_and(|prefix| prefix.ends_with('.'))
        })
}

async fn connect(cdp: &str) -> Result<(Browser, Page)> {
    let (mut browser, mut handler) = Browser::connect(cdp)
        .await
        .context("cannot connect to Brave CDP endpoint")?;
    tokio::spawn(async move { while handler.next().await.is_some() {} });
    let targets = browser
        .fetch_targets()
        .await
        .context("cannot discover open browser tabs")?;
    let pages: Vec<_> = targets
        .into_iter()
        .filter(|target| target.r#type == "page")
        .collect();
    if pages.is_empty() {
        bail!("CDP endpoint has no inspectable page targets");
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let page = if let Some(active) = active_tab(&browser).await? {
        let exact: Vec<_> = pages
            .iter()
            .filter(|target| target.url == active.url && target.title == active.title)
            .map(|target| target.target_id.clone())
            .collect();
        let matching_id = if exact.len() == 1 {
            exact.first().cloned()
        } else {
            let same_url: Vec<_> = pages
                .iter()
                .filter(|target| target.url == active.url)
                .map(|target| target.target_id.clone())
                .collect();
            (same_url.len() == 1).then(|| same_url[0].clone())
        }
        .context("cannot map selected tab to a page target; choose unique page URL")?;
        browser.get_page(matching_id).await?
    } else if pages.len() == 1 {
        browser.get_page(pages[0].target_id.clone()).await?
    } else {
        bail!(
            "browser does not expose selected-tab metadata; multiple pages found, upgrade Brave or specify a tab"
        )
    };
    Ok((browser, page))
}

#[derive(Deserialize)]
struct ActiveTab {
    title: String,
    url: String,
}

async fn active_tab(browser: &Browser) -> Result<Option<ActiveTab>> {
    let (mut socket, _) = connect_async(browser.websocket_address())
        .await
        .context("cannot open CDP browser session for selected-tab metadata")?;
    socket
        .send(Message::Text(
            serde_json::json!({
                "id": 1,
                "method": "Target.getTargets",
                "params": {"filter": [{"type":"tab","exclude":false},{"exclude":true}]}
            })
            .to_string()
            .into(),
        ))
        .await?;
    let response = tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(message) = socket.next().await {
            let message = message?;
            if let Message::Text(text) = message {
                let value: serde_json::Value = serde_json::from_str(&text)?;
                if value["id"] == 1 {
                    if let Some(error) = value.get("error") {
                        bail!(
                            "CDP selected-tab query failed: {}",
                            error["message"].as_str().unwrap_or("unknown error")
                        );
                    }
                    let target = value["result"]["targetInfos"]
                        .as_array()
                        .and_then(|targets| {
                            targets
                                .iter()
                                .find(|target| target["embedderData"]["tabActive"] == true)
                        });
                    return Ok(target.map(|target| ActiveTab {
                        title: target["title"].as_str().unwrap_or_default().to_owned(),
                        url: target["url"].as_str().unwrap_or_default().to_owned(),
                    }));
                }
            }
        }
        bail!("CDP browser closed before returning selected-tab metadata")
    })
    .await
    .context("timed out reading selected-tab metadata")??;
    let _ = socket.close(None).await;
    Ok(response)
}

async fn inspect(page: &Page, max_nodes: usize) -> Result<Snapshot> {
    let title = page.get_title().await?.unwrap_or_default();
    let url = page.url().await?.unwrap_or_default();
    let value = page
        .evaluate(INSPECT_JS)
        .await?
        .into_value::<serde_json::Value>()?;
    page.execute(AxEnableParams {})
        .await
        .context("cannot enable accessibility tree")?;
    let ax = page
        .execute(GetFullAxTreeParams::default())
        .await
        .context("cannot read accessibility tree")?;
    let ax_nodes = serde_json::to_value(ax.nodes.clone())?;
    let accessibility_tree: Vec<AxInfo> = ax_nodes
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| n["ignored"] != true)
        .take(max_nodes.clamp(1, 1200))
        .map(|n| AxInfo {
            role: redact(
                n.pointer("/role/value")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
            ),
            name: if matches!(
                n.pointer("/role/value").and_then(|v| v.as_str()),
                Some("textbox" | "searchbox" | "combobox")
            ) {
                "[REDACTED FIELD]".into()
            } else {
                redact(
                    n.pointer("/name/value")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                )
            },
            description: if matches!(
                n.pointer("/role/value").and_then(|v| v.as_str()),
                Some("textbox" | "searchbox" | "combobox")
            ) {
                String::new()
            } else {
                redact(
                    n.pointer("/description/value")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                )
            },
        })
        .collect();
    let snapshot: Snapshot = serde_json::from_value(serde_json::json!({
        "url":redact(&url),"title":redact(&title),"viewport":value["viewport"].clone(),"scroll":value["scroll"].clone(),
        "focused":value["focused"].clone(),"page_text":value["page_text"].clone(),"visible_elements":value["visible_elements"].clone(),
        "accessibility_tree":accessibility_tree,"limits":"DOM view only: canvas pixels, video frames, browser chrome, other desktop windows, and offscreen content are not transcribed.".to_string()
    }))?;
    let mut snapshot = snapshot;
    snapshot.visible_elements.truncate(max_nodes.clamp(1, 1200));
    snapshot.page_text = snapshot.page_text.chars().take(60_000).collect();
    Ok(snapshot)
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let file = cli
        .config
        .as_ref()
        .map(std::fs::read_to_string)
        .transpose()?
        .map(|s| toml::from_str::<FileConfig>(&s))
        .transpose()?
        .unwrap_or_default();
    let cfg = file.brave_cli.unwrap_or(Config {
        cdp_url: None,
        allowed_domains: None,
    });
    let cdp = std::env::var("BRAVE_CLI_CDP_URL")
        .ok()
        .or(cfg.cdp_url)
        .unwrap_or_else(|| "http://127.0.0.1:9222".into());
    let mut domains = cfg.allowed_domains.unwrap_or_default();
    domains.extend(cli.allow);
    domains.extend(
        std::env::var("BRAVE_CLI_ALLOWED_DOMAINS")
            .unwrap_or_default()
            .split(',')
            .map(str::to_owned),
    );
    match cli.command.clone() {
        Command::Start {
            port,
            user_data_dir,
        } => {
            let executable = brave_executable().context("Brave executable not found")?;
            let profile = user_data_dir
                .or_else(|| {
                    std::env::var("LOCALAPPDATA")
                        .ok()
                        .map(|p| PathBuf::from(p).join("brave-cli-control/profile"))
                })
                .context("user_data_dir is required when LOCALAPPDATA is unavailable")?;
            std::fs::create_dir_all(&profile)?;
            let child = std::process::Command::new(executable)
                .arg(format!("--remote-debugging-port={port}"))
                .arg(format!("--user-data-dir={}", profile.display()))
                .arg("about:blank")
                .spawn()
                .context("cannot start Brave")?;
            let endpoint = format!("http://127.0.0.1:{port}");
            let mut connected = false;
            for _ in 0..50 {
                if connect(&endpoint).await.is_ok() {
                    connected = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            if !connected {
                bail!(
                    "Brave started (pid {}), but CDP did not become ready at {endpoint}",
                    child.id()
                );
            }
            println!(
                "Brave CDP ready at {endpoint}; profile {}",
                profile.display()
            );
        }
        Command::Doctor => {
            println!(
                "brave-cli-control {}\nCDP: {}",
                env!("CARGO_PKG_VERSION"),
                cdp
            );
        }
        Command::Tabs => {
            let (browser, _) = connect(&cdp).await?;
            for p in browser.pages().await? {
                let u = p.url().await?.unwrap_or_default();
                println!(
                    "{}\t{}",
                    redact(&p.get_title().await?.unwrap_or_default()),
                    redact(&u)
                );
            }
        }
        Command::Navigate { url } => {
            if !allowed(&url, &domains) {
                bail!("domain not in allowlist");
            }
            if cli.dry_run {
                println!("dry-run: navigation allowed, not executed");
            } else {
                let (_b, p) = connect(&cdp).await?;
                p.goto(url).await?;
            }
        }
        Command::Tab {
            command: TabCommand::Open { url },
        } => {
            if !allowed(&url, &domains) {
                bail!("domain not in allowlist");
            }
            if cli.dry_run {
                println!("dry-run: tab open allowed, not executed");
            } else {
                let (browser, _) = connect(&cdp).await?;
                browser.new_page(url).await?;
            }
        }
        Command::Inspect { format, max_nodes } => {
            if cli.dry_run {
                println!("dry-run: inspection requires CDP read access; not connected");
            } else {
                let (_b, p) = connect(&cdp).await?;
                let s = inspect(&p, max_nodes).await?;
                match format.as_str() {
                    "json" => println!("{}", serde_json::to_string_pretty(&s)?),
                    "dom" => println!("{}", s.page_text),
                    _ => {
                        println!(
                            "{} — {}\nViewport {}×{}, scroll ({:.0},{:.0}) / document {:.0}×{:.0}\nFocused: {}\n\n{}",
                            s.title,
                            s.url,
                            s.viewport.width,
                            s.viewport.height,
                            s.scroll.x,
                            s.scroll.y,
                            s.scroll.document_width,
                            s.scroll.document_height,
                            s.focused.as_deref().unwrap_or("none"),
                            s.page_text
                        );
                        for e in &s.visible_elements {
                            println!("[{}] {} {}", e.role, e.name, e.selector);
                        }
                        println!("\n{}", s.limits);
                    }
                }
            }
        }
        Command::Click { selector, confirm } => {
            require_confirmation(&format!("click {selector} submit"), confirm)?;
            if cli.dry_run {
                println!("dry-run: click not executed");
            } else {
                let (_b, p) = connect(&cdp).await?;
                p.find_element(&selector).await?.click().await?;
            }
        }
        Command::Fill {
            selector,
            value,
            confirm,
        } => {
            require_confirmation(&format!("fill {selector} account"), confirm)?;
            if cli.dry_run {
                println!("dry-run: fill not executed");
            } else {
                fill_element(&cdp, &selector, &value).await?;
            }
        }
        Command::Evaluate {
            javascript,
            confirm,
        } => {
            validate_javascript(&javascript, confirm)?;
            if cli.dry_run {
                println!("dry-run: JavaScript not executed");
            } else {
                let (_browser, page) = connect(&cdp).await?;
                let value = page
                    .evaluate(javascript)
                    .await?
                    .into_value::<serde_json::Value>()?;
                println!("{}", redact(&value.to_string()));
            }
        }
        Command::Run { workflow, confirm } => {
            run_workflow(&workflow, &cdp, &domains, confirm, cli.dry_run).await?
        }
        Command::Page {
            command: PageCommand::Screenshot { filename },
        } => {
            if cli.dry_run {
                println!("dry-run: screenshot not captured");
            } else {
                let (_browser, page) = connect(&cdp).await?;
                page.save_screenshot(ScreenshotParams::default(), filename)
                    .await?;
            }
        }
    }
    tokio::time::sleep(Duration::from_millis(25)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspect_reports_semantic_state_limits() {
        let snapshot = Snapshot {
            url: "https://example.com".into(),
            title: "Example".into(),
            viewport: ViewportInfo {
                width: 1280.0,
                height: 720.0,
                device_pixel_ratio: 1.0,
            },
            scroll: ScrollInfo {
                x: 0.0,
                y: 0.0,
                document_width: 1280.0,
                document_height: 2000.0,
            },
            focused: None,
            page_text: "hello".into(),
            visible_elements: vec![],
            accessibility_tree: vec![AxInfo {
                role: "button".into(),
                name: "Save".into(),
                description: "".into(),
            }],
            limits: "DOM only".into(),
        };
        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["accessibility_tree"][0]["role"], "button");
        assert_eq!(json["viewport"]["width"], 1280.0);
        assert_eq!(json["limits"], "DOM only");
    }

    #[test]
    fn allows_exact_and_subdomain_only() {
        let d = vec!["example.com".to_string()];
        assert!(allowed("https://example.com/a", &d));
        assert!(allowed("https://sub.example.com", &d));
        assert!(!allowed("https://notexample.com", &d));
        assert!(!allowed("javascript:alert(1)", &d));
        assert!(!allowed("https://example.com.evil.test", &d));
        assert!(allowed("https://user:pass@example.com:443/a", &d));
    }
    #[test]
    fn redacts_secrets() {
        let s = redact("password=hunter2 token:abc");
        assert!(!s.contains("hunter2"));
        assert!(!s.contains("abc"));
    }

    #[test]
    fn javascript_blocks_private_storage_and_gates_network() {
        assert!(validate_javascript("document.cookie", true).is_err());
        assert!(validate_javascript("localStorage.getItem('x')", true).is_err());
        assert!(validate_javascript("fetch('https://example.com')", false).is_err());
        assert!(validate_javascript("fetch('https://example.com')", true).is_ok());
        assert!(validate_javascript("document.title", false).is_err());
        assert!(validate_javascript("document.title", true).is_ok());
    }

    #[test]
    fn confirmation_tracks_risky_actions() {
        assert!(require_confirmation("click submit", false).is_err());
        assert!(require_confirmation("navigate page", false).is_ok());
        assert!(require_confirmation("click submit", true).is_ok());
    }
}
