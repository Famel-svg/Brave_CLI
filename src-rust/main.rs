use anyhow::{Context, Result, bail};
use chromiumoxide::cdp::browser_protocol::accessibility::{
    EnableParams as AxEnableParams, GetFullAxTreeParams,
};
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

#[derive(Subcommand)]
enum Command {
    Doctor,
    Tabs,
    Navigate {
        url: String,
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
  const sensitive = /password|passwd|secret|token|cookie|authorization|api[_-]?key/i;
  const clean = (s) => (s || '').replace(/\b(password|passwd|secret|token|cookie|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]').slice(0, 1200);
  const visible = (e) => { const r=e.getBoundingClientRect(),s=getComputedStyle(e); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity)>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth; };
  const name = (e) => clean(e.getAttribute('aria-label') || e.getAttribute('alt') || e.getAttribute('title') || e.innerText || e.textContent || '');
  const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role],iframe,video,canvas,img,summary')].filter(visible).slice(0, 1200).map((e,i) => {
    const r=e.getBoundingClientRect(), tag=e.tagName.toLowerCase(), type=(e.getAttribute('type')||'').toLowerCase();
    const secret=sensitive.test([e.name,e.id,e.getAttribute('autocomplete'),type].join(' '));
    const label=secret ? '[REDACTED FIELD]' : name(e);
    return {tag, role:e.getAttribute('role')||({a:'link',button:'button',input:'textbox',textarea:'textbox',select:'combobox'}[tag]||tag), name:label, text:secret?'[REDACTED]':clean(e.value||e.innerText||e.textContent||''), selector:e.id?'#'+CSS.escape(e.id):`${tag}:nth-of-type(${[...e.parentElement.children].filter(x=>x.tagName===e.tagName).indexOf(e)+1})`, rect:{x:r.x,y:r.y,width:r.width,height:r.height},disabled:!!e.disabled};
  });
  const active=document.activeElement;
  let pageText=clean(document.body?.innerText||'');
  for (const e of document.querySelectorAll('input,textarea,[contenteditable="true"]')) if (sensitive.test([e.name,e.id,e.getAttribute('autocomplete'),e.type].join(' ')) && e.value) pageText=pageText.replaceAll(e.value,'[REDACTED]');
  return {viewport:{width:innerWidth,height:innerHeight,device_pixel_ratio:devicePixelRatio},scroll:{x:scrollX,y:scrollY,document_width:document.documentElement.scrollWidth,document_height:document.documentElement.scrollHeight},focused:active&&active!==document.body?name(active):null,page_text:pageText,visible_elements:elements};
}"#;

fn redact(input: &str) -> String {
    Regex::new(
        r"(?i)(password|passwd|secret|token|cookie|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+",
    )
    .expect("constant regex")
    .replace_all(input, "$1=[REDACTED]")
    .into_owned()
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
    browser
        .fetch_targets()
        .await
        .context("cannot discover open browser tabs")?;
    let page = browser
        .pages()
        .await?
        .into_iter()
        .next()
        .context("no open browser tabs")?;
    Ok((browser, page))
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
            name: redact(
                n.pointer("/name/value")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
            ),
            description: redact(
                n.pointer("/description/value")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
            ),
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
    match cli.command {
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
            if !confirm {
                bail!("click can trigger submission or account changes; pass --confirm");
            }
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
            if !confirm {
                bail!("fill can modify account data; pass --confirm");
            }
            if cli.dry_run {
                println!("dry-run: fill not executed");
            } else {
                let (_b, p) = connect(&cdp).await?;
                p.find_element(&selector).await?.click().await?;
                p.find_element(&selector).await?.type_str(value).await?;
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
            viewport: ViewportInfo { width: 1280.0, height: 720.0, device_pixel_ratio: 1.0 },
            scroll: ScrollInfo { x: 0.0, y: 0.0, document_width: 1280.0, document_height: 2000.0 },
            focused: None,
            page_text: "hello".into(),
            visible_elements: vec![],
            accessibility_tree: vec![AxInfo { role: "button".into(), name: "Save".into(), description: "".into() }],
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
}
