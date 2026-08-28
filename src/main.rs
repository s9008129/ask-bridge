use base64::{Engine as _, engine::general_purpose};
use clap::{ArgAction, CommandFactory, Parser, Subcommand, ValueEnum};
use fs2::FileExt;
use mcp_cli::{McpClient, McpConnection, ServerConfig, StdioClient};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::io::{self, IsTerminal, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const ASK_BRIDGE_CHROME_MARKER: &str = "--ask-bridge-instance";
const ISOLATED_NEW_TAB_CAPABILITY: &str = "isolated_new_tab_v1";
const VERIFIED_FILE_UPLOAD_CAPABILITY: &str = "verified_file_upload_v1";
const VERIFIED_MIXED_ATTACHMENT_CAPABILITY: &str = "verified_mixed_attachment_upload_v1";
const VERIFIED_IMAGE_RESPONSE_COMPLETION_CAPABILITY: &str = "verified_image_response_completion_v1";
const VERIFIED_MODEL_SELECTION_CAPABILITY: &str = "verified_model_selection_v1";
const VERIFIED_MODEL_SELECTION_V2_CAPABILITY: &str = "verified_model_selection_v2";
const VERIFIED_MODEL_SELECTION_V3_CAPABILITY: &str = "verified_model_selection_v3";
const BACKGROUND_ISOLATED_TAB_CAPABILITY: &str = "background_isolated_tab_v1";
const SESSION_RECEIPT_SCHEMA_VERSION: u8 = 2;
const ATTACHMENT_VERIFICATION_FAILURE_CODE: &str = "ATTACHMENT_VERIFICATION_FAILED";
const MODEL_SELECTION_FAILURE_CODE: &str = "CHATGPT_MODEL_SELECTION_FAILED";
const MODEL_SELECTION_FAILURE_STAGE: &str = "model_selection";
const ATTACHMENT_VERIFY_TIMEOUT: Duration = Duration::from_secs(60);
/// Dynamic attachment verification timeout scaled by the number of files.
/// ChatGPT renders file tiles progressively; with 4 files (e.g. repair
/// requests) the 60-second base is not enough for all tiles to appear and
/// stabilise.  Each file gets an additional 15 seconds of headroom.
fn attachment_verify_timeout_for_count(count: usize) -> Duration {
    Duration::from_secs(ATTACHMENT_VERIFY_TIMEOUT.as_secs() + (count as u64 * 15))
}
const ATTACHMENT_VERIFY_POLL_INTERVAL: Duration = Duration::from_millis(500);
const ATTACHMENT_REQUIRED_STABLE_PROBES: usize = 2;
const RESPONSE_POLL_INTERVAL: Duration = Duration::from_millis(500);
const RESPONSE_REQUIRED_STABLE_PROBES: usize = 3;
/// Minimum text content length (in bytes of trimmed textContent) for a text
/// response to be considered complete.  ChatGPT sometimes shows short
/// processing-status text (e.g. "Reading Schema For JSON Deck Plan
/// Validation", ~44 bytes) while the Stop button briefly disappears during
/// attachment processing.  Without this gate the stability tracker would
/// declare the response complete and copy the status text instead of the
/// real response.
const MINIMUM_TEXT_RESPONSE_BYTES: usize = 200;
const GENERATED_IMAGE_MIN_DIMENSION: u32 = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LoginState {
    LoggedIn,
    LoggedOut,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize)]
struct LoginSignals {
    account: bool,
    auth_control: bool,
    auth_path: bool,
    composer: bool,
    stable: bool,
}

impl LoginSignals {
    fn state(self, provider: Provider) -> LoginState {
        if self.auth_path {
            LoginState::LoggedOut
        } else if self.account {
            LoginState::LoggedIn
        } else if !self.stable {
            LoginState::Unknown
        } else if self.auth_control {
            LoginState::LoggedOut
        } else if self.composer && provider == Provider::ChatGpt {
            LoginState::LoggedIn
        } else {
            LoginState::Unknown
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Provider {
    #[value(name = "chatgpt")]
    ChatGpt,
    #[value(name = "gemini")]
    Gemini,
    #[value(name = "claude")]
    Claude,
}

impl Provider {
    fn from_config_value(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "chatgpt" | "chat-gpt" | "chat_gpt" => Some(Provider::ChatGpt),
            "gemini" => Some(Provider::Gemini),
            "claude" | "claude-ai" | "claude_ai" | "claudeai" => Some(Provider::Claude),
            _ => None,
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Provider::ChatGpt => "ChatGPT",
            Provider::Gemini => "Gemini",
            Provider::Claude => "Claude",
        }
    }

    fn home_url(self) -> &'static str {
        match self {
            Provider::ChatGpt => "https://chatgpt.com/",
            Provider::Gemini => "https://gemini.google.com/app",
            Provider::Claude => "https://claude.ai/new",
        }
    }

    fn owns_url(self, url: &str) -> bool {
        match self {
            Provider::ChatGpt => url.contains("chatgpt.com"),
            Provider::Gemini => url.contains("gemini.google.com"),
            Provider::Claude => url.contains("claude.ai"),
        }
    }

    fn from_url(url: &str) -> Option<Self> {
        [Provider::ChatGpt, Provider::Gemini, Provider::Claude]
            .into_iter()
            .find(|provider| provider.owns_url(url))
    }

    fn ready_check_js(self) -> &'static str {
        match self {
            Provider::ChatGpt => r#"() => document.getElementById('prompt-textarea') !== null"#,
            Provider::Gemini => {
                r#"() => {
                    return document.querySelector('div[role="textbox"][aria-label*="Gemini"]') !== null ||
                           document.querySelector('rich-textarea [contenteditable="true"]') !== null ||
                           document.querySelector('.ql-editor[contenteditable="true"]') !== null ||
                           document.querySelector('a[href*="accounts.google.com"]') !== null ||
                           /Sign in|登入/.test(document.body.innerText || '');
                }"#
            }
            Provider::Claude => {
                r#"() => {
                    return document.querySelector('div[contenteditable="true"][data-testid="chat-input"]') !== null ||
                           document.querySelector('div[contenteditable="true"].ProseMirror') !== null ||
                           document.querySelector('[data-testid="login-with-google"]') !== null ||
                           window.location.pathname.startsWith('/login') ||
                           /Sign in|登入/.test(document.body.innerText || '');
                }"#
            }
        }
    }

    fn login_signals_js(self) -> &'static str {
        match self {
            Provider::ChatGpt => {
                r#"async () => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const style = window.getComputedStyle(el);
                        const rect = el.getBoundingClientRect();
                        return style.display !== 'none' &&
                            style.visibility !== 'hidden' &&
                            style.opacity !== '0' &&
                            rect.width > 0 &&
                            rect.height > 0;
                    };

                    const textFor = (el) => [
                        el.getAttribute('aria-label'),
                        el.getAttribute('title'),
                        el.textContent
                    ].filter(Boolean).join(' ').trim();

                    const readSignals = () => {
                        const visibleAuthButton = Array.from(document.querySelectorAll('a, button'))
                            .some((el) => {
                                if (!isVisible(el)) return false;
                                const text = textFor(el);
                                return /^(log in|login|sign in|sign up|登入|登錄|登录|註冊|注册)$/i.test(text);
                            });

                        const composer = document.querySelector('#prompt-textarea') ||
                            document.querySelector('[data-testid="composer-text-input"]') ||
                            document.querySelector('textarea[placeholder*="Message"]') ||
                            document.querySelector('textarea[placeholder*="訊息"]') ||
                            document.querySelector('[contenteditable="true"]');

                        const accountMenu = document.querySelector('[data-testid="profile-button"]') ||
                            document.querySelector('[data-testid="account-menu-button"]') ||
                            document.querySelector('[data-testid="user-menu-button"]') ||
                            document.querySelector('button[aria-label*="Profile"]') ||
                            document.querySelector('button[aria-label*="profile"]') ||
                            document.querySelector('button[aria-label*="Account"]') ||
                            document.querySelector('button[aria-label*="account"]') ||
                            document.querySelector('button[aria-label*="User"]') ||
                            document.querySelector('button[aria-label*="user"]') ||
                            document.querySelector('button[aria-label*="帳戶"]') ||
                            document.querySelector('button[aria-label*="使用者"]') ||
                            document.querySelector('button[aria-label*="設定檔"]');

                        return {
                            account: isVisible(accountMenu),
                            auth_control: Boolean(visibleAuthButton),
                            auth_path: /\/(auth|login|signup)(\/|$)/i.test(window.location.pathname),
                            composer: isVisible(composer)
                        };
                    };

                    let signals = readSignals();
                    let signature = JSON.stringify(signals);
                    const startedAt = Date.now();
                    let stableSince = startedAt;
                    let stable = false;
                    const earliestDecision = startedAt + 2000;
                    const deadline = Date.now() + 5000;
                    while (!signals.account && !signals.auth_path && Date.now() < deadline) {
                        await new Promise((resolve) => setTimeout(resolve, 250));
                        const nextSignals = readSignals();
                        const nextSignature = JSON.stringify(nextSignals);
                        if (nextSignature !== signature) {
                            signature = nextSignature;
                            stableSince = Date.now();
                        }
                        signals = nextSignals;
                        if (Date.now() >= earliestDecision && Date.now() - stableSince >= 750) {
                            stable = true;
                            break;
                        }
                    }

                    return { ...signals, stable };
                }"#
            }
            Provider::Gemini => {
                r#"() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const style = window.getComputedStyle(el);
                        const rect = el.getBoundingClientRect();
                        return style.display !== 'none' &&
                            style.visibility !== 'hidden' &&
                            style.opacity !== '0' &&
                            rect.width > 0 &&
                            rect.height > 0;
                    };
                    const composer = document.querySelector('div[role="textbox"][aria-label*="Gemini"]') ||
                        document.querySelector('rich-textarea [contenteditable="true"]') ||
                        document.querySelector('.ql-editor[contenteditable="true"]');
                    const account = document.querySelector('a[href*="accounts.google.com/SignOutOptions"]') ||
                        document.querySelector('[aria-label*="Google 帳戶"]') ||
                        document.querySelector('[aria-label*="Google Account"]');
                    const signIn = Array.from(document.querySelectorAll('a, button'))
                        .some((el) => isVisible(el) && /Sign in|登入/.test([
                                el.getAttribute('aria-label'),
                                el.textContent
                            ].filter(Boolean).join(' ')));
                    const authPath = /\/(auth|login|signin|signup)(\/|$)/i.test(window.location.pathname);
                    return {
                        account: isVisible(account),
                        auth_control: Boolean(signIn),
                        auth_path: authPath,
                        composer: Boolean(composer),
                        stable: true
                    };
                }"#
            }
            Provider::Claude => {
                r#"() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const style = window.getComputedStyle(el);
                        const rect = el.getBoundingClientRect();
                        return style.display !== 'none' &&
                            style.visibility !== 'hidden' &&
                            style.opacity !== '0' &&
                            rect.width > 0 &&
                            rect.height > 0;
                    };
                    const composer = document.querySelector('div[contenteditable="true"][data-testid="chat-input"]') ||
                        document.querySelector('div[contenteditable="true"].ProseMirror');
                    const account = document.querySelector('[data-testid="user-menu-button"]') ||
                        document.querySelector('button[aria-label*="User menu"]') ||
                        document.querySelector('button[aria-label*="Account"]');
                    const signIn = document.querySelector('[data-testid="login-with-google"]') ||
                        Array.from(document.querySelectorAll('a, button'))
                            .find((el) => isVisible(el) && /^(log in|login|sign in|sign up|登入|註冊)$/i.test([
                                    el.getAttribute('aria-label'),
                                    el.textContent
                                ].filter(Boolean).join(' ').trim()));
                    const authPath = /^\/(login|signup|magic-link)(\/|$)/i.test(window.location.pathname);
                    return {
                        account: isVisible(account),
                        auth_control: Boolean(signIn),
                        auth_path: authPath,
                        composer: Boolean(composer)
                    };
                }"#
            }
        }
    }

    fn assistant_selector(self) -> &'static str {
        match self {
            // ChatGPT currently renders a semantic assistant node inside an
            // `.agent-turn` wrapper.  Selecting both naively counts the same
            // turn twice and makes the response identity gate fail closed.
            // Keep the wrapper as the canonical turn and only use the role
            // marker when it is not nested in one.
            Provider::ChatGpt => {
                ".agent-turn, [data-message-author-role=\"assistant\"]:not(.agent-turn *)"
            }
            Provider::Gemini => "model-response",
            Provider::Claude => ".font-claude-response",
        }
    }

    fn user_selector(self) -> &'static str {
        match self {
            Provider::ChatGpt => "[data-message-author-role=\"user\"]",
            Provider::Gemini => "user-query",
            Provider::Claude => "[data-testid=\"user-message\"], .font-user-message",
        }
    }

    fn latest_response_selector(self) -> &'static str {
        match self {
            Provider::ChatGpt => {
                "[data-message-author-role=\"assistant\"], .agent-turn, model-response, .model-response, [data-test-id*=\"response\"], [data-testid*=\"response\"]"
            }
            Provider::Gemini => "model-response",
            Provider::Claude => ".font-claude-response",
        }
    }

    fn response_content_selector(self) -> &'static str {
        match self {
            Provider::ChatGpt => "",
            Provider::Gemini => {
                "message-content, .markdown, structured-content-container.model-response-text"
            }
            Provider::Claude => ".standard-markdown, .font-claude-response-body",
        }
    }

    fn composer_selectors_json(self) -> &'static str {
        match self {
            Provider::ChatGpt => r##"["#prompt-textarea"]"##,
            Provider::Gemini => {
                r#"[
                    "div[role=\"textbox\"][aria-label*=\"Gemini\"]",
                    "rich-textarea [contenteditable=\"true\"]",
                    ".ql-editor[contenteditable=\"true\"]"
                ]"#
            }
            Provider::Claude => {
                r#"[
                    "div[contenteditable=\"true\"][data-testid=\"chat-input\"]",
                    "div[contenteditable=\"true\"].ProseMirror",
                    "div[aria-label*=\"Claude\"][contenteditable=\"true\"]"
                ]"#
            }
        }
    }

    fn send_button_selectors_json(self) -> &'static str {
        match self {
            Provider::ChatGpt => {
                r##"[
                    "[data-testid=\"send-button\"]",
                    "#composer-submit-button",
                    "button[aria-label*=\"Send\"]",
                    "button[aria-label*=\"傳送\"]",
                    "button[aria-label*=\"发送\"]"
                ]"##
            }
            Provider::Gemini => {
                r#"[
                    "button[aria-label=\"傳送訊息\"]",
                    "button[aria-label=\"Submit\"]",
                    "button[aria-label*=\"Send\"]",
                    "button[aria-label*=\"傳送\"]",
                    "button[aria-label*=\"提交\"]"
                ]"#
            }
            Provider::Claude => {
                r#"[
                    "button[aria-label=\"Send message\"]",
                    "button[aria-label*=\"Send\"]",
                    "button[aria-label*=\"傳送\"]"
                ]"#
            }
        }
    }

    fn stop_button_selectors_json(self) -> &'static str {
        match self {
            Provider::ChatGpt => {
                r##"[
                    "[data-testid=\"stop-button\"]",
                    "#composer-stop-button",
                    "button[aria-label=\"Stop generating\"]"
                ]"##
            }
            Provider::Gemini => {
                r#"[
                    "button[aria-label=\"停止回覆\"]",
                    "button[aria-label*=\"Stop\"]",
                    "button[aria-label*=\"停止\"]"
                ]"#
            }
            Provider::Claude => {
                r#"[
                    "button[aria-label=\"Stop response\"]",
                    "button[aria-label*=\"Stop\"]",
                    "button[aria-label*=\"停止\"]"
                ]"#
            }
        }
    }
}

impl fmt::Display for Provider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Provider::ChatGpt => write!(f, "chatgpt"),
            Provider::Gemini => write!(f, "gemini"),
            Provider::Claude => write!(f, "claude"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ChatGptAgentPrompt<'a> {
    agent_mention: &'a str,
    body: &'a str,
}

fn parse_chatgpt_agent_prompt(prompt: &str) -> Option<ChatGptAgentPrompt<'_>> {
    let rest = prompt.strip_prefix('@')?;
    let mut agent_chars = 0usize;

    for (idx, ch) in rest.char_indices() {
        if ch.is_whitespace() {
            if agent_chars == 0 || agent_chars > 10 {
                return None;
            }

            let body = rest[idx + ch.len_utf8()..].trim_start_matches(char::is_whitespace);
            if body.is_empty() {
                return None;
            }

            return Some(ChatGptAgentPrompt {
                agent_mention: &prompt[..idx + 1],
                body,
            });
        }

        agent_chars += 1;
        if agent_chars > 10 {
            return None;
        }
    }

    None
}

#[derive(Parser)]
#[command(name = "ask-bridge")]
#[command(version = env!("CARGO_PKG_VERSION"))]
#[command(disable_version_flag = true)]
#[command(about = "AI browser CLI - Ask ChatGPT, Gemini or Claude from your Terminal with your subscription", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// The prompt to send to the selected provider.
    /// If standard input is piped and this value is present, they are combined as:
    /// `prompt + "\\n\\n" + stdin`.
    prompt: Option<String>,

    /// AI provider to automate. Overrides ~/.config/ask-bridge/config.json.
    #[arg(long, short = 'p', value_enum, global = true)]
    provider: Option<Provider>,

    /// Run Chrome in headless mode. Defaults to true.
    #[arg(long, require_equals = true, num_args = 0..=1, default_value = "true", default_missing_value = "true")]
    headless: bool,

    /// Create a brand new provider session by opening a new tab and closing old ones.
    /// This is retained for backwards compatibility and is destructive.
    #[arg(long, default_value_t = false)]
    new: bool,

    /// Create an isolated provider tab while preserving every tab that existed
    /// before this invocation. Requires a UUID session id for ownership and
    /// receipt verification.
    #[arg(long, conflicts_with = "new")]
    new_tab_preserve_existing: bool,

    /// UUID used to name and verify the isolated session receipt.
    #[arg(long, value_name = "UUID", requires = "new_tab_preserve_existing")]
    session_id: Option<String>,

    /// Print version information.
    #[arg(
        long = "version",
        short = 'v',
        short_alias = 'V',
        action = ArgAction::Version
    )]
    _version: (),

    /// Print verbose debugging status messages.
    #[arg(long, default_value_t = false)]
    verbose: bool,

    /// Write the final response in Markdown format to the specified file.
    #[arg(long, short, value_name = "FILE")]
    output: Option<String>,

    /// Write the downloaded images to the specified folder or file path.
    #[arg(long, short = 'i', value_name = "IMAGE_PATH")]
    image_output: Option<String>,

    /// Attach one or more local image files to the prompt (can be specified multiple times).
    #[arg(long = "image", value_name = "IMAGE_FILE", num_args = 1)]
    images: Vec<String>,

    /// Attach one or more local document files (PDF, Word, Excel, text, etc.) to the prompt
    /// (can be specified multiple times).
    #[arg(long = "file", value_name = "FILE", num_args = 1)]
    files: Vec<String>,

    /// Maximum time in seconds to wait for the provider response.
    #[arg(long, default_value_t = 300, value_parser = clap::value_parser!(u64).range(1..))]
    timeout: u64,

    /// Switch the provider model before sending the prompt.  Can be specified
    /// multiple times to set both the model and the reasoning level, e.g.
    /// `--model "GPT-5.5" --model "中等"`.
    /// ChatGPT examples: "GPT-5.5", "GPT-5.4", "GPT-5.3", "o3", or thinking levels such as
    /// "即時", "中等", "高", "超高", "專業", "智慧". Gemini examples: "3.5 Flash",
    /// "3.1 Flash-Lite", or "3.1 Pro". Claude examples: "Sonnet", "Opus", "Haiku".
    /// Matching is case- and punctuation-insensitive.
    #[arg(long = "model", value_name = "MODEL", action = clap::ArgAction::Append)]
    model: Vec<String>,

    /// Upload and verify attachments in an isolated tab without typing or
    /// submitting a prompt.  Exits 0 on verified, non-zero on attachment
    /// failure.  Receipt prompt_submission stays not_started.
    #[arg(long = "verify-attachments-only", default_value_t = false)]
    verify_attachments_only: bool,
}

#[derive(Subcommand, Clone)]
enum Commands {
    /// Print the machine-readable capabilities of this binary.
    Capabilities {
        /// Emit a JSON capability document.
        #[arg(long)]
        json: bool,
    },
    /// Open Chrome browser, optionally navigate to a URL, and copy the latest response
    #[command(hide = true)]
    Open {
        /// Optional conversation URL to open before copying the latest response.
        url: Option<String>,
    },
    /// Retrieve the latest response from the selected provider (defaults to headless)
    #[command(hide = true)]
    Get {
        /// Optional conversation URL to fetch before copying the latest response.
        url: Option<String>,
        /// Print verbose debugging status messages.
        #[arg(long, default_value_t = false)]
        verbose: bool,
    },
    /// Open Chrome browser and wait for manual login
    Login,
    /// Verify the current provider session without sending a prompt.
    #[command(name = "session-probe")]
    SessionProbe {
        /// Emit a machine-readable authentication result.
        #[arg(long)]
        json: bool,
    },
    /// Close the managed Chrome browser instance
    Close,
    /// Set or show the global default provider used when --provider is not specified.
    Config,
    /// Reinstall ask-bridge using the recommended README installation command
    Update,
    /// Dump the current browser tab HTML for debugging
    #[command(hide = true)]
    Dump,
    /// Take a screenshot of the current browser tab for debugging
    #[command(hide = true)]
    Screenshot,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct AppConfig {
    provider: Option<String>,
}

fn config_file_path() -> Result<PathBuf, String> {
    let mut config_path = home::home_dir().ok_or("Could not locate home directory")?;
    config_path.push(".config/ask-bridge/config.json");
    Ok(config_path)
}

fn ask_bridge_state_dir() -> Result<PathBuf, String> {
    let mut path = home::home_dir().ok_or("Could not locate home directory")?;
    path.push(".config/ask-bridge");
    Ok(path)
}

fn session_receipts_dir() -> Result<PathBuf, String> {
    Ok(ask_bridge_state_dir()?.join("sessions"))
}

fn session_receipt_path(session_id: &str) -> Result<PathBuf, String> {
    let session_id = validate_session_id(session_id)?;
    Ok(session_receipts_dir()?.join(format!("{}.json", session_id)))
}

fn provider_lease_path(provider: Provider) -> Result<PathBuf, String> {
    Ok(ask_bridge_state_dir()?.join(format!("{}.lease", provider)))
}

fn validate_session_id(value: &str) -> Result<String, String> {
    Uuid::parse_str(value)
        .map(|uuid| uuid.to_string())
        .map_err(|_| "session id 必須是有效 UUID".to_string())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum AttachmentVerification {
    Pending,
    Verified,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PromptSubmission {
    NotStarted,
    IntentRecorded,
    Submitted,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ModelSelection {
    #[default]
    NotRequested,
    Verified,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ModelSelectionContract {
    LegacyMenuV1,
    ReasoningSliderV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReasoningEffort {
    Instant,
    Medium,
    High,
}

impl ReasoningEffort {
    fn target_index(self) -> i64 {
        match self {
            Self::Instant => 0,
            Self::Medium => 1,
            Self::High => 2,
        }
    }

    fn from_label(value: &str) -> Option<Self> {
        let normalized = normalize_model_selection_label(value);
        match normalized.as_str() {
            "即時" | "即時推理" | "instant" | "fast" | "light" | "low" => Some(Self::Instant),
            "中" | "中等" | "中等推理" | "medium" | "standard" | "thinking" => {
                Some(Self::Medium)
            }
            "高" | "高推理" | "high" | "heavy" | "extended" => Some(Self::High),
            _ => None,
        }
    }

    fn from_ordinal_index(index: i64) -> Option<Self> {
        match index {
            0 => Some(Self::Instant),
            1 => Some(Self::Medium),
            2 => Some(Self::High),
            _ => None,
        }
    }
}

fn normalize_model_selection_label(value: &str) -> String {
    let mut normalized = value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect::<String>();
    for marker in ["currentlyselected", "已選取", "selected", "已選"] {
        if let Some(stripped) = normalized.strip_prefix(marker) {
            normalized = stripped.to_string();
        }
        if let Some(stripped) = normalized.strip_suffix(marker) {
            normalized = stripped.to_string();
        }
    }
    normalized
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ModelSelectionEvidence {
    CheckedStateV1,
    AccessibleLabelV1,
    BoundedOrdinalV1,
    ResolvedBoundedOrdinalV2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ModelSelectionOutcome {
    contract: ModelSelectionContract,
    evidence: ModelSelectionEvidence,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExpectedOutputType {
    #[default]
    Text,
    Image,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ResponseCompletion {
    #[default]
    Pending,
    Completed,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ResponseFailureCode {
    AssistantCountChanged,
    PageOwnershipChanged,
    PageUrlChanged,
    ResponseIdentityChanged,
    ProviderRejected,
    ResponseProbeFailed,
    ResponseTimeout,
    ImageDownloadEmpty,
    ImageDownloadFailed,
}

impl fmt::Display for ResponseFailureCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            ResponseFailureCode::AssistantCountChanged => "assistant_count_changed",
            ResponseFailureCode::PageOwnershipChanged => "page_ownership_changed",
            ResponseFailureCode::PageUrlChanged => "page_url_changed",
            ResponseFailureCode::ResponseIdentityChanged => "response_identity_changed",
            ResponseFailureCode::ProviderRejected => "provider_rejected",
            ResponseFailureCode::ResponseProbeFailed => "response_probe_failed",
            ResponseFailureCode::ResponseTimeout => "response_timeout",
            ResponseFailureCode::ImageDownloadEmpty => "image_download_empty",
            ResponseFailureCode::ImageDownloadFailed => "image_download_failed",
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ImageDownloadError {
    ResponseIdentityChanged,
    DownloadFailed(String),
}

impl fmt::Display for ImageDownloadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ImageDownloadError::ResponseIdentityChanged => {
                formatter.write_str("verified response identity changed before image download")
            }
            ImageDownloadError::DownloadFailed(message) => formatter.write_str(message),
        }
    }
}

impl From<String> for ImageDownloadError {
    fn from(message: String) -> Self {
        Self::DownloadFailed(message)
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
struct ResponseDomProbe {
    ownership_token_matches: bool,
    provider_url_owned: bool,
    url: String,
    conversation_id: String,
    turn_id: String,
    artifact_ids: Vec<String>,
    user_count: usize,
    assistant_count: usize,
    generation_control_visible: bool,
    content_present: bool,
    content_text_length: usize,
    provider_failure_visible: bool,
    loaded_large_image_count: usize,
    dom_signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct VerifiedResponseIdentity {
    conversation_id: String,
    turn_id: String,
    artifact_ids: Vec<String>,
    user_count: usize,
    assistant_count: usize,
    dom_signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ResponseTrackerDecision {
    Pending,
    Completed(VerifiedResponseIdentity),
    Unknown(ResponseFailureCode),
}

#[derive(Debug)]
struct ResponseCompletionTracker {
    expected_output_type: ExpectedOutputType,
    initial_user_count: usize,
    initial_assistant_count: usize,
    response_conversation_id: Option<String>,
    response_turn_id: Option<String>,
    response_artifact_ids: Option<Vec<String>>,
    stable_signature: Option<String>,
    stable_probes: usize,
    provider_failure_signature: Option<String>,
    provider_failure_probes: usize,
    was_generating: bool,
    terminal: Option<ResponseTrackerDecision>,
}

impl ResponseCompletionTracker {
    fn new(
        expected_output_type: ExpectedOutputType,
        initial_user_count: usize,
        initial_assistant_count: usize,
    ) -> Self {
        Self {
            expected_output_type,
            initial_user_count,
            initial_assistant_count,
            response_conversation_id: None,
            response_turn_id: None,
            response_artifact_ids: None,
            stable_signature: None,
            stable_probes: 0,
            provider_failure_signature: None,
            provider_failure_probes: 0,
            was_generating: false,
            terminal: None,
        }
    }

    fn observe(&mut self, probe: ResponseDomProbe) -> ResponseTrackerDecision {
        if let Some(decision) = &self.terminal {
            return decision.clone();
        }

        if !probe.ownership_token_matches {
            return self.finish_unknown(ResponseFailureCode::PageOwnershipChanged);
        }
        if !probe.provider_url_owned {
            return self.finish_unknown(ResponseFailureCode::PageUrlChanged);
        }
        if probe.user_count < self.initial_user_count
            || probe.user_count > self.initial_user_count.saturating_add(1)
        {
            return self.finish_unknown(ResponseFailureCode::ResponseIdentityChanged);
        }
        if probe.assistant_count < self.initial_assistant_count
            || probe.assistant_count > self.initial_assistant_count.saturating_add(1)
        {
            return self.finish_unknown(ResponseFailureCode::AssistantCountChanged);
        }
        if probe.user_count == self.initial_user_count {
            if self.response_conversation_id.is_some() {
                return self.finish_unknown(ResponseFailureCode::ResponseIdentityChanged);
            }
            self.reset_stability();
            return ResponseTrackerDecision::Pending;
        }
        if probe.assistant_count == self.initial_assistant_count {
            if self.response_conversation_id.is_some() {
                return self.finish_unknown(ResponseFailureCode::AssistantCountChanged);
            }
            self.reset_stability();
            return ResponseTrackerDecision::Pending;
        }

        match (
            &self.response_conversation_id,
            probe.conversation_id.as_str(),
        ) {
            (None, "") => {}
            (None, conversation_id) => {
                self.response_conversation_id = Some(conversation_id.to_string());
            }
            (Some(current), next) if current == next => {}
            (Some(current), next)
                if current.starts_with("home:") && next.starts_with("conversation:") =>
            {
                // ChatGPT creates a conversation with history.pushState after
                // the first assistant shell appears.  The home page is not a
                // response identity; lock only once the canonical /c/<id>
                // route exists.  A later conversation-id change remains an
                // ownership failure.
                self.response_conversation_id = Some(next.to_string());
            }
            (Some(current), next)
                if current.starts_with("conversation:WEB:")
                    && next.starts_with("conversation:")
                    && !next.starts_with("conversation:WEB:") =>
            {
                // The isolated ChatGPT tab can expose a temporary WEB
                // conversation id before the server assigns the canonical
                // UUID.  Treat that one SPA replacement like the home-page
                // transition; once a real id is locked, A -> B is unknown.
                self.response_conversation_id = Some(next.to_string());
            }
            (Some(_), _) => {
                return self.finish_unknown(ResponseFailureCode::PageUrlChanged);
            }
        }

        if probe.generation_control_visible {
            // Provider UIs can briefly hide and remount Stop while the same
            // image response is transitioning from an assistant shell to its
            // loaded artifact.  It is a readiness signal, not an identity
            // signal; counts, route, ownership token and semantic anchors
            // above remain the fail-closed identity gates.
            //
            // During active generation the DOM legitimately evolves: turn_id
            // and artifact_ids change as the image artifact is created and
            // loaded.  Update the stored identity to the latest probe values
            // rather than treating the drift as a terminal identity violation.
            // The strict identity gates below only run once generation has
            // stopped, so a post-generation identity change is still caught.
            if !probe.turn_id.is_empty() {
                self.response_turn_id = Some(probe.turn_id.clone());
            }
            if !probe.artifact_ids.is_empty() {
                self.response_artifact_ids = Some(probe.artifact_ids.clone());
            }
            self.was_generating = true;
            self.reset_stability();
            return ResponseTrackerDecision::Pending;
        }

        // When transitioning from generating to not-generating, ChatGPT
        // re-renders the response DOM (turn_id / artifact_ids may change as
        // the image artifact is finalised).  Update the stored identity once
        // to absorb this post-generation evolution, then proceed to the
        // normal stability + identity checks for subsequent probes.
        if self.was_generating {
            if !probe.turn_id.is_empty() {
                self.response_turn_id = Some(probe.turn_id.clone());
            }
            if !probe.artifact_ids.is_empty() {
                self.response_artifact_ids = Some(probe.artifact_ids.clone());
            }
            self.was_generating = false;
        }

        if !probe.turn_id.is_empty() {
            match &self.response_turn_id {
                Some(current) if current != &probe.turn_id => {
                    return self.finish_unknown(ResponseFailureCode::ResponseIdentityChanged);
                }
                None => self.response_turn_id = Some(probe.turn_id.clone()),
                Some(_) => {}
            }
        }
        if !probe.artifact_ids.is_empty() {
            match &self.response_artifact_ids {
                Some(current) if current != &probe.artifact_ids => {
                    return self.finish_unknown(ResponseFailureCode::ResponseIdentityChanged);
                }
                None => self.response_artifact_ids = Some(probe.artifact_ids.clone()),
                Some(_) => {}
            }
        }

        if self.expected_output_type == ExpectedOutputType::Image
            && probe.provider_failure_visible
            && probe.content_present
            && probe.loaded_large_image_count == 0
            && !probe.dom_signature.is_empty()
            && probe.conversation_id.starts_with("conversation:")
            && !probe.turn_id.is_empty()
            && probe.artifact_ids.is_empty()
        {
            // A provider refusal is a terminal response, but it does not
            // satisfy the image artifact contract.  Require the same
            // provider marker and DOM signature to persist for the normal
            // stability window so a transient error label cannot terminate a
            // still-streaming response.  Once stable, fail closed instead of
            // waiting for the full provider timeout; the submitted receipt
            // remains ambiguous for the caller.
            if self.provider_failure_signature.as_deref() == Some(probe.dom_signature.as_str()) {
                self.provider_failure_probes = self.provider_failure_probes.saturating_add(1);
            } else {
                self.provider_failure_signature = Some(probe.dom_signature.clone());
                self.provider_failure_probes = 1;
            }
            if self.provider_failure_probes >= RESPONSE_REQUIRED_STABLE_PROBES {
                return self.finish_unknown(ResponseFailureCode::ProviderRejected);
            }
            return ResponseTrackerDecision::Pending;
        }

        let artifact_ready = match self.expected_output_type {
            ExpectedOutputType::Text => {
                probe.content_present && probe.content_text_length >= MINIMUM_TEXT_RESPONSE_BYTES
            }
            ExpectedOutputType::Image => probe.loaded_large_image_count > 0,
        };
        if !artifact_ready || probe.dom_signature.is_empty() {
            self.reset_stability();
            return ResponseTrackerDecision::Pending;
        }

        if self.stable_signature.as_deref() == Some(probe.dom_signature.as_str()) {
            self.stable_probes = self.stable_probes.saturating_add(1);
        } else {
            self.stable_signature = Some(probe.dom_signature.clone());
            self.stable_probes = 1;
        }

        if self.stable_probes < RESPONSE_REQUIRED_STABLE_PROBES {
            return ResponseTrackerDecision::Pending;
        }

        let decision = ResponseTrackerDecision::Completed(VerifiedResponseIdentity {
            conversation_id: self.response_conversation_id.clone().unwrap_or_default(),
            turn_id: self.response_turn_id.clone().unwrap_or_default(),
            artifact_ids: self.response_artifact_ids.clone().unwrap_or_default(),
            user_count: probe.user_count,
            assistant_count: probe.assistant_count,
            dom_signature: probe.dom_signature,
        });
        self.terminal = Some(decision.clone());
        decision
    }

    fn timeout(&mut self) -> ResponseTrackerDecision {
        if let Some(decision) = &self.terminal {
            return decision.clone();
        }
        self.finish_unknown(ResponseFailureCode::ResponseTimeout)
    }

    fn finish_unknown(&mut self, code: ResponseFailureCode) -> ResponseTrackerDecision {
        let decision = ResponseTrackerDecision::Unknown(code);
        self.terminal = Some(decision.clone());
        decision
    }

    fn reset_stability(&mut self) {
        self.stable_signature = None;
        self.stable_probes = 0;
        self.provider_failure_signature = None;
        self.provider_failure_probes = 0;
    }
}

fn enforce_download_contract(
    expected_output_type: ExpectedOutputType,
    download_result: Result<usize, ImageDownloadError>,
) -> Result<usize, ResponseFailureCode> {
    match download_result {
        Err(ImageDownloadError::ResponseIdentityChanged) => {
            Err(ResponseFailureCode::ResponseIdentityChanged)
        }
        Err(ImageDownloadError::DownloadFailed(_)) => Err(ResponseFailureCode::ImageDownloadFailed),
        Ok(0) if expected_output_type == ExpectedOutputType::Image => {
            Err(ResponseFailureCode::ImageDownloadEmpty)
        }
        Ok(downloaded) => Ok(downloaded),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
struct SessionReceipt {
    schema_version: u8,
    capability: String,
    capabilities: Vec<String>,
    attachment_verification: AttachmentVerification,
    attachment_count: usize,
    attachment_total_bytes: u64,
    prompt_submission: PromptSubmission,
    failure_code: Option<String>,
    #[serde(default)]
    model_selection: ModelSelection,
    #[serde(default)]
    model_selection_contract: Option<ModelSelectionContract>,
    #[serde(default)]
    model_selection_evidence: Option<ModelSelectionEvidence>,
    #[serde(default)]
    failure_stage: Option<String>,
    #[serde(default)]
    expected_output_type: ExpectedOutputType,
    #[serde(default)]
    response_completion: ResponseCompletion,
    #[serde(default)]
    downloaded_image_count: usize,
    #[serde(default)]
    response_failure_code: Option<ResponseFailureCode>,
}

impl SessionReceipt {
    #[cfg(test)]
    fn new(attachment_count: usize, attachment_total_bytes: u64) -> Self {
        Self::new_for_output(
            attachment_count,
            attachment_total_bytes,
            ExpectedOutputType::Text,
        )
    }

    fn new_for_output(
        attachment_count: usize,
        attachment_total_bytes: u64,
        expected_output_type: ExpectedOutputType,
    ) -> Self {
        Self {
            schema_version: SESSION_RECEIPT_SCHEMA_VERSION,
            capability: ISOLATED_NEW_TAB_CAPABILITY.to_string(),
            capabilities: vec![
                ISOLATED_NEW_TAB_CAPABILITY.to_string(),
                BACKGROUND_ISOLATED_TAB_CAPABILITY.to_string(),
                VERIFIED_FILE_UPLOAD_CAPABILITY.to_string(),
                VERIFIED_MIXED_ATTACHMENT_CAPABILITY.to_string(),
                VERIFIED_IMAGE_RESPONSE_COMPLETION_CAPABILITY.to_string(),
                VERIFIED_MODEL_SELECTION_CAPABILITY.to_string(),
                VERIFIED_MODEL_SELECTION_V2_CAPABILITY.to_string(),
                VERIFIED_MODEL_SELECTION_V3_CAPABILITY.to_string(),
            ],
            attachment_verification: AttachmentVerification::Pending,
            attachment_count,
            attachment_total_bytes,
            prompt_submission: PromptSubmission::NotStarted,
            failure_code: None,
            model_selection: ModelSelection::NotRequested,
            model_selection_contract: None,
            model_selection_evidence: None,
            failure_stage: None,
            expected_output_type,
            response_completion: ResponseCompletion::Pending,
            downloaded_image_count: 0,
            response_failure_code: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionReceiptEvent {
    AttachmentsVerified,
    AttachmentsFailed,
    PromptIntentRecorded,
    PromptSubmitted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AttachmentSummary {
    file_names: Vec<String>,
    total_bytes: u64,
}

impl AttachmentSummary {
    fn count(&self) -> usize {
        self.file_names.len()
    }
}

struct ProviderLease {
    file: std::fs::File,
    _path: PathBuf,
}

impl Drop for ProviderLease {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn acquire_provider_lease(provider: Provider, session_id: &str) -> Result<ProviderLease, String> {
    let path = provider_lease_path(provider)?;
    acquire_provider_lease_at(&path, provider, session_id)
}

fn acquire_provider_lease_at(
    path: &Path,
    provider: Provider,
    session_id: &str,
) -> Result<ProviderLease, String> {
    if let Some(parent) = path.parent() {
        ensure_private_directory(parent)?;
    }
    if let Ok(metadata) = std::fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err("ask-bridge lease 路徑不是受信任的 regular file".to_string());
    }

    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).truncate(false).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("無法開啟 {}：{}", path.display(), error))?;
    file.try_lock_exclusive().map_err(|_| {
        format!(
            "{} 目前已有另一個 ask-bridge 工作；請等待該工作完成後再試",
            provider.display_name()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("無法設定 ask-bridge lease 權限：{}", error))?;
    }

    let record = serde_json::json!({
        "pid": std::process::id(),
        "provider": provider.to_string(),
        "session_id": validate_session_id(session_id)?,
    });
    let content = serde_json::to_vec(&record)
        .map_err(|error| format!("無法序列化 ask-bridge lease：{}", error))?;
    file.set_len(0)
        .map_err(|error| format!("無法清理 ask-bridge lease：{}", error))?;
    (&file)
        .write_all(&content)
        .map_err(|error| format!("無法寫入 ask-bridge lease：{}", error))?;
    file.sync_all()
        .map_err(|error| format!("無法同步 ask-bridge lease：{}", error))?;

    Ok(ProviderLease {
        file,
        _path: path.to_path_buf(),
    })
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("受保護狀態目錄不是可信任的 directory".to_string());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(path)
                .map_err(|error| format!("無法建立受保護狀態目錄：{}", error))?;
            let metadata = std::fs::symlink_metadata(path)
                .map_err(|error| format!("無法驗證受保護狀態目錄：{}", error))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("受保護狀態目錄建立後不是可信任的 directory".to_string());
            }
        }
        Err(error) => return Err(format!("無法檢查受保護狀態目錄：{}", error)),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("無法設定受保護狀態目錄權限：{}", error))?;
    }
    Ok(())
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("無法判定 receipt 目錄：{}", path.display()))?;
    ensure_private_directory(parent)?;
    if let Ok(metadata) = std::fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err("受保護 JSON 目標不是可信任的 regular file".to_string());
    }

    let temp_path = parent.join(format!(
        ".{}.tmp-{}-{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        Uuid::new_v4()
    ));
    let content = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("無法序列化 session receipt：{}", error))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temp_path)
            .map_err(|error| format!("無法建立暫存 receipt：{}", error))?;
        file.write_all(&content)
            .map_err(|error| format!("無法寫入 session receipt：{}", error))?;
        file.sync_all()
            .map_err(|error| format!("無法同步 session receipt：{}", error))?;
        std::fs::rename(&temp_path, path)
            .map_err(|error| format!("無法原子發布 session receipt：{}", error))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("無法設定 session receipt 權限：{}", error))?;
            let parent_directory = std::fs::File::open(parent)
                .map_err(|error| format!("無法開啟 receipt 目錄以同步：{}", error))?;
            parent_directory
                .sync_all()
                .map_err(|error| format!("無法同步 receipt 目錄：{}", error))?;
        }
        Ok::<(), String>(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

fn read_session_receipt(path: &Path) -> Result<SessionReceipt, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("無法讀取 session receipt metadata：{}", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("session receipt 不是可信任的 regular file".to_string());
    }
    let receipt: SessionReceipt = serde_json::from_slice(
        &std::fs::read(path).map_err(|error| format!("無法讀取 session receipt：{}", error))?,
    )
    .map_err(|error| format!("session receipt 格式無效：{}", error))?;
    if receipt.schema_version != SESSION_RECEIPT_SCHEMA_VERSION {
        return Err("session receipt schema version 不相容".to_string());
    }
    Ok(receipt)
}

fn write_attachment_probe_receipt(
    path: &Path,
    probe: &AttachmentProbeSummary,
) -> Result<(), String> {
    let receipt = read_session_receipt(path)?;
    // attachment_probe is an additive field; prompt_submission stays
    // not_started for the verify-attachments-only mode.
    let mut json =
        serde_json::to_value(&receipt).map_err(|error| format!("無法序列化 receipt：{}", error))?;
    if let Some(obj) = json.as_object_mut() {
        obj.insert(
            "attachment_probe".to_string(),
            serde_json::to_value(probe).unwrap_or_default(),
        );
    }
    write_private_json(path, &json)?;
    Ok(())
}

fn write_session_receipt_preserving_attachment_probe(
    path: &Path,
    receipt: &SessionReceipt,
) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("無法讀取 session receipt metadata：{}", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("session receipt 不是可信任的 regular file".to_string());
    }
    let existing = serde_json::from_slice::<Value>(
        &std::fs::read(path).map_err(|error| format!("無法讀取 session receipt：{}", error))?,
    )
    .map_err(|error| format!("session receipt 格式無效：{}", error))?;
    let attachment_probe = existing.get("attachment_probe").cloned();
    let mut updated = serde_json::to_value(receipt)
        .map_err(|error| format!("無法序列化 session receipt：{}", error))?;
    if let (Some(probe), Some(object)) = (attachment_probe, updated.as_object_mut()) {
        object.insert("attachment_probe".to_string(), probe);
    }
    write_private_json(path, &updated)
}

fn record_model_selection_verified(
    path: &Path,
    outcome: ModelSelectionOutcome,
) -> Result<(), String> {
    let mut receipt = read_session_receipt(path)?;
    if receipt.prompt_submission != PromptSubmission::NotStarted {
        return Err("prompt 已開始後不得回寫模型選擇 verified".to_string());
    }
    if receipt.model_selection == ModelSelection::Failed {
        return Err("模型選擇已失敗後不得回寫 verified".to_string());
    }
    receipt.model_selection = ModelSelection::Verified;
    receipt.model_selection_contract = Some(outcome.contract);
    receipt.model_selection_evidence = Some(outcome.evidence);
    receipt.failure_stage = None;
    receipt.failure_code = None;
    write_session_receipt_preserving_attachment_probe(path, &receipt)?;
    let persisted = read_session_receipt(path)?;
    if persisted != receipt {
        return Err("模型選擇 verified receipt 原子更新後驗證失敗".to_string());
    }
    Ok(())
}

fn record_model_selection_failed(path: &Path) -> Result<(), String> {
    let mut receipt = read_session_receipt(path)?;
    if receipt.prompt_submission != PromptSubmission::NotStarted {
        return Err("prompt 已開始後不得標記模型選擇安全失敗".to_string());
    }
    receipt.model_selection = ModelSelection::Failed;
    receipt.model_selection_contract = None;
    receipt.model_selection_evidence = None;
    receipt.failure_stage = Some(MODEL_SELECTION_FAILURE_STAGE.to_string());
    receipt.failure_code = Some(MODEL_SELECTION_FAILURE_CODE.to_string());
    write_session_receipt_preserving_attachment_probe(path, &receipt)?;
    let persisted = read_session_receipt(path)?;
    if persisted != receipt {
        return Err("模型選擇 failed receipt 原子更新後驗證失敗".to_string());
    }
    Ok(())
}

fn record_session_receipt_event(path: &Path, event: SessionReceiptEvent) -> Result<(), String> {
    let mut receipt = read_session_receipt(path)?;
    match event {
        SessionReceiptEvent::AttachmentsVerified => {
            if receipt.attachment_verification != AttachmentVerification::Pending
                || receipt.prompt_submission != PromptSubmission::NotStarted
            {
                return Err("附件驗證狀態轉移不合法".to_string());
            }
            receipt.attachment_verification = AttachmentVerification::Verified;
            receipt.failure_code = None;
        }
        SessionReceiptEvent::AttachmentsFailed => {
            if receipt.attachment_verification != AttachmentVerification::Pending
                || receipt.prompt_submission != PromptSubmission::NotStarted
            {
                return Err("prompt intent 後不得標記附件為安全失敗".to_string());
            }
            receipt.attachment_verification = AttachmentVerification::Failed;
            receipt.failure_code = Some(ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string());
        }
        SessionReceiptEvent::PromptIntentRecorded => {
            if receipt.attachment_verification != AttachmentVerification::Verified
                || receipt.prompt_submission != PromptSubmission::NotStarted
            {
                return Err("附件尚未驗證或 prompt 已開始，拒絕記錄新的 submit intent".to_string());
            }
            receipt.prompt_submission = PromptSubmission::IntentRecorded;
        }
        SessionReceiptEvent::PromptSubmitted => {
            if receipt.prompt_submission != PromptSubmission::IntentRecorded {
                return Err("沒有 durable intent，拒絕標記 prompt submitted".to_string());
            }
            receipt.prompt_submission = PromptSubmission::Submitted;
        }
    }
    write_session_receipt_preserving_attachment_probe(path, &receipt)?;
    let persisted = read_session_receipt(path)?;
    if persisted != receipt {
        return Err("session receipt 原子更新後驗證失敗".to_string());
    }
    Ok(())
}

fn record_session_response_outcome(
    path: &Path,
    completion: ResponseCompletion,
    downloaded_image_count: usize,
    failure_code: Option<ResponseFailureCode>,
) -> Result<(), String> {
    let mut receipt = read_session_receipt(path)?;
    if receipt.prompt_submission == PromptSubmission::NotStarted {
        return Err("prompt 尚未開始，不得記錄 response terminal outcome".to_string());
    }
    if completion == ResponseCompletion::Pending {
        return Err("response outcome 不得回寫 pending".to_string());
    }
    if receipt.response_completion == ResponseCompletion::Unknown
        && completion != ResponseCompletion::Unknown
    {
        return Err("unknown response outcome 不得改寫為其他終態".to_string());
    }
    if receipt.response_completion == ResponseCompletion::Completed
        && completion != ResponseCompletion::Completed
    {
        return Err("completed response outcome 不得倒退".to_string());
    }
    if downloaded_image_count < receipt.downloaded_image_count {
        return Err("下載圖片計數不得倒退".to_string());
    }
    if completion == ResponseCompletion::Unknown && failure_code.is_none() {
        return Err("unknown response outcome 必須包含固定 failure code".to_string());
    }

    receipt.response_completion = completion;
    receipt.downloaded_image_count = downloaded_image_count;
    receipt.response_failure_code = failure_code;
    write_session_receipt_preserving_attachment_probe(path, &receipt)?;
    let persisted = read_session_receipt(path)?;
    if persisted != receipt {
        return Err("response outcome 原子更新後驗證失敗".to_string());
    }
    Ok(())
}

fn write_session_receipt(
    session_id: &str,
    attachment_count: usize,
    attachment_total_bytes: u64,
    expected_output_type: ExpectedOutputType,
) -> Result<PathBuf, String> {
    let session_id = validate_session_id(session_id)?;
    let path = session_receipt_path(&session_id)?;
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {
            return Err(
                "session receipt 已存在；請使用新的 UUID，避免重用舊分頁 ownership".to_string(),
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("無法檢查 session receipt：{}", error)),
    }
    let receipt = SessionReceipt::new_for_output(
        attachment_count,
        attachment_total_bytes,
        expected_output_type,
    );
    write_private_json(&path, &receipt)?;
    let persisted = read_session_receipt(&path)?;
    if persisted != receipt {
        return Err("session receipt 驗證失敗：內容與本次工作不一致".to_string());
    }
    Ok(path)
}

fn capabilities_value() -> Value {
    serde_json::json!({
        "schema_version": 2,
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": [
            ISOLATED_NEW_TAB_CAPABILITY,
            BACKGROUND_ISOLATED_TAB_CAPABILITY,
            VERIFIED_FILE_UPLOAD_CAPABILITY,
            VERIFIED_MIXED_ATTACHMENT_CAPABILITY,
            VERIFIED_IMAGE_RESPONSE_COMPLETION_CAPABILITY,
            VERIFIED_MODEL_SELECTION_CAPABILITY,
            VERIFIED_MODEL_SELECTION_V2_CAPABILITY,
            VERIFIED_MODEL_SELECTION_V3_CAPABILITY
        ],
        "isolated_new_tab_v1": {
            "flag": "--new-tab-preserve-existing",
            "session_id_flag": "--session-id",
            "receipt": "0600-json",
            "ownership": "exact-page-id",
            "lease": "provider-scoped-cross-process"
        },
        "background_isolated_tab_v1": {
            "new_page_background": "headless",
            "foreground": "visible",
            "scope": "isolated-new-tab-only"
        },
        "verified_file_upload_v1": {
            "verification": "filename-multiset-stable-dom-probe",
            "stable_probes": ATTACHMENT_REQUIRED_STABLE_PROBES,
            "probe_interval_ms": ATTACHMENT_VERIFY_POLL_INTERVAL.as_millis(),
            "timeout_seconds": ATTACHMENT_VERIFY_TIMEOUT.as_secs(),
            "timeout_per_file_seconds": 15,
            "submit_before_verified": false
        },
        "verified_mixed_attachment_upload_v1": {
            "verification": "typed-document-image-stable-dom-probe",
            "document_evidence": "filename-multiset",
            "image_evidence": "preview-delta-natural-dimensions",
            "upload_sequence": "documents-first-then-images",
            "stable_probes": ATTACHMENT_REQUIRED_STABLE_PROBES,
            "probe_interval_ms": ATTACHMENT_VERIFY_POLL_INTERVAL.as_millis(),
            "timeout_seconds": ATTACHMENT_VERIFY_TIMEOUT.as_secs(),
            "timeout_per_file_seconds": 15,
            "submit_before_verified": false,
            "receipt_fields": ["attachment_probe"]
        },
        "verified_image_response_completion_v1": {
            "expected_output_flag": "--image-output",
            "verification": "new-assistant-no-generation-control-loaded-large-image-stable-dom",
            "user_delta": 1,
            "assistant_delta": 1,
            "minimum_image_dimension": GENERATED_IMAGE_MIN_DIMENSION,
            "stable_probes": RESPONSE_REQUIRED_STABLE_PROBES,
            "probe_interval_ms": RESPONSE_POLL_INTERVAL.as_millis(),
            "zero_images_exit_success": false,
            "download_error_exit_success": false,
            "interference_result": "unknown",
            "receipt_fields": [
                "expected_output_type",
                "response_completion",
                "downloaded_image_count",
                "response_failure_code"
            ]
        },
        "verified_model_selection_v1": {
            "selection_contracts": ["legacy_menu_v1", "reasoning_slider_v1"],
            "verified_after_selection": true,
            "pre_submit_fail_closed": true,
            "receipt_fields": [
                "model_selection",
                "model_selection_contract",
                "failure_stage",
                "failure_code"
            ]
        },
        "verified_model_selection_v2": {
            "selection_contracts": ["legacy_menu_v1", "reasoning_slider_v1"],
            "evidence": ["checked_state_v1", "accessible_label_v1", "bounded_ordinal_v1"],
            "verified_after_selection": true,
            "pre_submit_fail_closed": true,
            "trusted_input": "mcp_press_key",
            "post_selection_persistence": "close_reopen_state",
            "ordinal_profile": {
                "marker": "data-model-reasoning-effort-slider",
                "role": "slider",
                "min": 0,
                "max": 2,
                "total": 3,
                "mapping": {"instant": 0, "medium": 1, "high": 2},
                "transition": "exact_single_step"
            },
            "receipt_fields": [
                "model_selection",
                "model_selection_contract",
                "model_selection_evidence",
                "failure_stage",
                "failure_code"
            ]
        },
        "verified_model_selection_v3": {
            "selection_contracts": ["legacy_menu_v1", "reasoning_slider_v1"],
            "evidence": ["checked_state_v1", "accessible_label_v1", "bounded_ordinal_v1", "resolved_bounded_ordinal_v2"],
            "verified_after_selection": true,
            "pre_submit_fail_closed": true,
            "trusted_input": "mcp_press_key",
            "post_selection_persistence": "close_reopen_state",
            "control_bundle": {
                "marker": "data-model-reasoning-effort-slider",
                "state_owner_relation": ["marker", "descendant"],
                "focus_owner_relation": ["state_owner", "descendant"],
                "role_evidence": ["slider", "native_range", "missing", "conflict"]
            },
            "ordinal_profile": {
                "min": 0,
                "max": 2,
                "total": 3,
                "mapping": {"instant": 0, "medium": 1, "high": 2},
                "transition": "exact_single_step"
            },
            "receipt_fields": [
                "model_selection",
                "model_selection_contract",
                "model_selection_evidence",
                "failure_stage",
                "failure_code"
            ]
        }
    })
}

fn print_capabilities(json_output: bool) -> Result<(), String> {
    let value = capabilities_value();
    if json_output {
        println!(
            "{}",
            serde_json::to_string(&value)
                .map_err(|error| format!("無法輸出 capabilities：{}", error))?
        );
    } else {
        println!("ask-bridge capabilities");
        println!("  {}", ISOLATED_NEW_TAB_CAPABILITY);
        println!("  {}", BACKGROUND_ISOLATED_TAB_CAPABILITY);
        println!("  {}", VERIFIED_FILE_UPLOAD_CAPABILITY);
        println!("  {}", VERIFIED_MIXED_ATTACHMENT_CAPABILITY);
        println!("  {}", VERIFIED_IMAGE_RESPONSE_COMPLETION_CAPABILITY);
        println!("  {}", VERIFIED_MODEL_SELECTION_CAPABILITY);
        println!("  {}", VERIFIED_MODEL_SELECTION_V2_CAPABILITY);
        println!("  {}", VERIFIED_MODEL_SELECTION_V3_CAPABILITY);
        println!("  safe flag: --new-tab-preserve-existing");
    }
    Ok(())
}

fn parse_configured_provider(content: &str) -> Result<Option<Provider>, String> {
    let config: AppConfig =
        serde_json::from_str(content).map_err(|e| format!("Failed to parse config.json: {}", e))?;

    match config.provider {
        Some(provider) => Provider::from_config_value(&provider)
            .map(Some)
            .ok_or_else(|| format!("Invalid provider in config.json: {}", provider)),
        None => Ok(None),
    }
}

fn load_configured_provider() -> Result<Option<Provider>, String> {
    let config_path = config_file_path()?;
    if !config_path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&config_path).map_err(|e| {
        format!(
            "Failed to read config file {}: {}",
            config_path.to_string_lossy(),
            e
        )
    })?;

    parse_configured_provider(&content).map_err(|e| {
        format!(
            "{}. Expected format: {{\"provider\":\"chatgpt\"}} or {{\"provider\":\"gemini\"}}",
            e
        )
    })
}

fn effective_provider(
    cli_provider: Option<Provider>,
    configured_provider: Option<Provider>,
) -> Provider {
    cli_provider
        .or(configured_provider)
        .unwrap_or(Provider::ChatGpt)
}

fn resolve_provider_with<F>(
    cli_provider: Option<Provider>,
    load_provider: F,
) -> Result<Provider, String>
where
    F: FnOnce() -> Result<Option<Provider>, String>,
{
    if let Some(provider) = cli_provider {
        return Ok(provider);
    }

    Ok(effective_provider(None, load_provider()?))
}

fn resolve_provider(cli_provider: Option<Provider>) -> Result<Provider, String> {
    resolve_provider_with(cli_provider, load_configured_provider)
}

fn write_global_provider_config(provider: Provider) -> Result<(), String> {
    let config_path = config_file_path()?;
    write_private_json(
        &config_path,
        &serde_json::json!({"provider": provider.to_string()}),
    )
    .map_err(|error| format!("Failed to write private provider config: {}", error))?;

    println!(
        "Set default provider to '{}' in {}",
        provider,
        config_path.to_string_lossy()
    );

    Ok(())
}

fn run_config_command(cli_provider: Option<Provider>) -> Result<(), String> {
    match cli_provider {
        Some(provider) => write_global_provider_config(provider),
        None => {
            let config_path = config_file_path()?;
            let configured_provider = load_configured_provider()?;
            match configured_provider {
                Some(provider) => {
                    println!("Current default provider: {}", provider);
                }
                None => {
                    println!("No default provider configured.");
                    println!("The effective provider is ChatGPT.");
                }
            }
            if config_path.exists() {
                println!("Config file: {}", config_path.to_string_lossy());
            } else {
                println!(
                    "Config file not created yet: {}",
                    config_path.to_string_lossy()
                );
            }
            println!(
                "Set default provider with: ask-bridge config --provider <chatgpt|gemini|claude>"
            );
            println!("This is a one-time override example: ask-bridge --provider gemini <prompt>");
            Ok(())
        }
    }
}

fn run_update_command() -> Result<(), String> {
    println!("Running ask-bridge update via official installer...");
    println!("Progress: downloading installer and updating binary.");

    #[cfg(target_os = "windows")]
    let status = {
        let current_exe = std::env::current_exe()
            .map_err(|e| format!("Failed to locate current executable path: {}", e))?;
        let update_exe = current_exe
            .parent()
            .ok_or_else(|| "Failed to determine ask-bridge executable directory".to_string())?
            .join("ask-bridge-update.exe");

        if update_exe.exists() {
            let child = Command::new(update_exe)
                .arg(format!("--parent-pid={}", std::process::id()))
                .arg("--wait-seconds=30")
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("Failed to launch ask-bridge-update.exe: {}", e))?;
            println!("Progress: updater started with PID {}.", child.id());
            println!("Progress: update command is running in background.");
            return Ok(());
        }

        println!("ask-bridge-update.exe not found. Falling back to inline installer.");
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "irm https://raw.githubusercontent.com/doggy8088/ask-bridge/main/install.ps1 | iex",
            ])
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|e| format!("Failed to run Windows update command: {}", e))?
    };

    #[cfg(not(target_os = "windows"))]
    let status = Command::new("sh")
        .args([
            "-c",
            "curl -fsSL https://raw.githubusercontent.com/doggy8088/ask-bridge/main/install.sh | bash",
        ])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|e| format!("Failed to run macOS/Linux update command: {}", e))?;

    if status.success() {
        println!("Progress: update command completed.");
        Ok(())
    } else {
        Err(format!("Update command failed with exit status {}", status))
    }
}

struct Page {
    id: usize,
    url: String,
    selected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnedPageBinding {
    session_id: String,
    page_id: usize,
}

/// A safe invocation has exactly one browser page that it may mutate. The
/// binding is process-local and is enforced again before every page-bound MCP
/// call, so a manually selected tab or a second legacy invocation cannot turn
/// a request into a different-tab mutation.
static OWNED_PAGE_BINDING: std::sync::Mutex<Option<OwnedPageBinding>> = std::sync::Mutex::new(None);

#[derive(Clone, Copy, Debug)]
struct PageLoginState {
    id: usize,
    selected: bool,
    login_state: LoginState,
}

fn preferred_provider_page_id(pages: &[PageLoginState]) -> Option<usize> {
    pages
        .iter()
        .find(|page| page.login_state == LoginState::LoggedIn)
        .or_else(|| pages.iter().find(|page| page.selected))
        .or_else(|| pages.first())
        .map(|page| page.id)
}

fn parse_node_version(output: &str) -> Option<(u64, u64, u64)> {
    let version = output.trim().strip_prefix('v').unwrap_or(output.trim());
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;

    if parts.next().is_some() {
        return None;
    }

    Some((major, minor, patch))
}

fn validate_node_version_output(output: &str) -> Result<(), String> {
    let version = parse_node_version(output).ok_or_else(|| {
        format!(
            "Could not parse Node.js version from '{}'. Install a current Node.js LTS release and retry.",
            output.trim()
        )
    })?;
    let (major, minor, patch) = version;
    let supported = (major == 20 && (minor, patch) >= (19, 0))
        || (major == 22 && (minor, patch) >= (12, 0))
        || major >= 23;

    if supported {
        return Ok(());
    }

    Err(format!(
        "Node.js v{major}.{minor}.{patch} is not supported by {MCP_PACKAGE_SPEC}. Supported versions are ^20.19.0, ^22.12.0, or >=23.0.0. Install a current Node.js LTS release, reopen the terminal, and retry."
    ))
}

fn check_node_runtime() -> Result<(), String> {
    let output = Command::new("node")
        .arg("--version")
        .output()
        .map_err(|e| {
            format!(
                "Failed to run 'node --version': {e}. Install Node.js and ensure it is available in PATH."
            )
        })?;

    if !output.status.success() {
        return Err(format!(
            "'node --version' exited with status {}. Install a current Node.js LTS release and retry.",
            output.status
        ));
    }

    validate_node_version_output(&String::from_utf8_lossy(&output.stdout))
}

/// Pinned chrome-devtools-mcp package spec. `@latest` would make every npx
/// spawn re-resolve the dist-tag against the npm registry, which was observed
/// stalling; with mcp-cli's timeout-less request wait that hung whole runs
/// (2026-07-11). Bump this version deliberately and re-run the e2e check.
const MCP_PACKAGE_SPEC: &str = "chrome-devtools-mcp@1.5.0";

fn build_chrome_devtools_server_config(quiet_mcp: bool, headless: bool, is_windows: bool) -> Value {
    let mut mcp_args = vec![
        "-y".to_string(),
        MCP_PACKAGE_SPEC.to_string(),
        "--browser-url=http://127.0.0.1:9223".to_string(),
    ];
    if quiet_mcp {
        mcp_args.push("--no-usage-statistics".to_string());
        mcp_args.push("--no-performance-crux".to_string());
    }
    if headless {
        mcp_args.push("--headless".to_string());
    }

    let mut chrome_devtools_server = serde_json::json!({
        "command": if is_windows { "npx.cmd" } else { "npx" },
        "args": mcp_args
    });

    if quiet_mcp {
        chrome_devtools_server["env"] = serde_json::json!({
            "NPM_CONFIG_LOGLEVEL": "error",
            "NPM_CONFIG_PROGRESS": "false",
            "NPM_CONFIG_FUND": "false",
            "NPM_CONFIG_AUDIT": "false",
            "NPM_CONFIG_FUNDING": "0",
            "NPM_CONFIG_UPDATE_NOTIFIER": "false",
            "NO_COLOR": "1",
            "CI": "1",
            "NODE_NO_WARNINGS": "1"
        });
    }

    chrome_devtools_server
}

fn write_mcp_config(quiet_mcp: bool, headless: bool) -> Result<String, String> {
    let config_dir = ask_bridge_state_dir()?;
    let config_path = write_mcp_config_at(
        &config_dir,
        quiet_mcp,
        headless,
        cfg!(target_os = "windows"),
    )?;
    Ok(config_path.to_string_lossy().to_string())
}

fn write_mcp_config_at(
    config_dir: &Path,
    quiet_mcp: bool,
    headless: bool,
    is_windows: bool,
) -> Result<PathBuf, String> {
    ensure_private_directory(config_dir)?;
    let config_path = config_dir.join("mcp_servers.json");

    let chrome_devtools_server =
        build_chrome_devtools_server_config(quiet_mcp, headless, is_windows);

    let config_content = serde_json::json!({
        "mcpServers": {
            "chrome-devtools": chrome_devtools_server
        }
    });

    write_private_json(&config_path, &config_content)
        .map_err(|e| format!("Failed to write private mcp_servers.json: {}", e))?;

    Ok(config_path)
}

fn chrome_profile_path() -> Result<String, String> {
    let mut profile_dir = home::home_dir().ok_or("Could not locate home directory")?;
    profile_dir.push(".config/ask-bridge/chrome-profile");
    std::fs::create_dir_all(&profile_dir)
        .map_err(|e| format!("Failed to create chrome profile directory: {}", e))?;

    Ok(profile_dir.to_string_lossy().to_string())
}

fn chrome_pid_path() -> Result<PathBuf, String> {
    let mut path = home::home_dir().ok_or("Could not locate home directory")?;
    path.push(".config/ask-bridge/chrome.pid");
    Ok(path)
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
struct ChromeProcessRecord {
    pid: u32,
    #[serde(default)]
    browser_id: Option<String>,
}

fn parse_chrome_process_record(content: &str) -> Option<ChromeProcessRecord> {
    serde_json::from_str(content).ok().or_else(|| {
        content
            .trim()
            .parse::<u32>()
            .ok()
            .map(|pid| ChromeProcessRecord {
                pid,
                browser_id: None,
            })
    })
}

fn write_chrome_process_record(record: &ChromeProcessRecord) -> Result<(), String> {
    let path = chrome_pid_path()?;
    let content = serde_json::to_string(record)
        .map_err(|e| format!("Failed to serialize Chrome process record: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

fn read_chrome_process_record() -> Option<ChromeProcessRecord> {
    let path = chrome_pid_path().ok()?;
    let content = std::fs::read_to_string(path).ok()?;
    parse_chrome_process_record(&content)
}

fn read_chrome_pid() -> Option<String> {
    read_chrome_process_record().map(|record| record.pid.to_string())
}

fn remove_chrome_pid_file() -> Result<(), String> {
    let path = chrome_pid_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to remove {}: {}", path.display(), e)),
    }
}

fn browser_id_from_websocket_url(url: &str) -> Option<String> {
    const LOOPBACK_PREFIXES: &[&str] = &[
        "ws://127.0.0.1:9223/devtools/browser/",
        "ws://localhost:9223/devtools/browser/",
        "ws://[::1]:9223/devtools/browser/",
    ];
    let id = LOOPBACK_PREFIXES
        .iter()
        .find_map(|prefix| url.strip_prefix(prefix))?
        .trim();
    (!id.is_empty() && !id.contains(['/', '?', '#'])).then(|| id.to_string())
}

fn browser_id_from_version_response(response: &str) -> Option<String> {
    if !http_response_is_complete(response.as_bytes()) {
        return None;
    }
    let (headers, body) = response.split_once("\r\n\r\n")?;
    let status = headers.lines().next()?;
    let mut status_parts = status.split_whitespace();
    if !status_parts.next()?.starts_with("HTTP/") || status_parts.next()? != "200" {
        return None;
    }
    let body = body.trim();
    let version: Value = serde_json::from_str(body).ok()?;
    let websocket_url = version.get("webSocketDebuggerUrl")?.as_str()?;
    browser_id_from_websocket_url(websocket_url)
}

fn http_response_is_complete(response: &[u8]) -> bool {
    let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let body_start = header_end + 4;
    let Ok(headers) = std::str::from_utf8(&response[..header_end]) else {
        return false;
    };
    let content_length = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    });

    content_length
        .and_then(|content_length| body_start.checked_add(content_length))
        .map(|response_length| response.len() >= response_length)
        .unwrap_or(false)
}

fn debug_browser_id() -> Option<String> {
    const MAX_RESPONSE_SIZE: usize = 64 * 1024;
    const TOTAL_TIMEOUT: Duration = Duration::from_secs(5);

    let mut stream = TcpStream::connect("127.0.0.1:9223").ok()?;
    let timeout = Some(Duration::from_millis(500));
    stream.set_read_timeout(timeout).ok()?;
    stream.set_write_timeout(timeout).ok()?;
    stream
        .write_all(
            b"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:9223\r\nConnection: close\r\n\r\n",
        )
        .ok()?;

    let mut response = Vec::new();
    let mut buffer = [0_u8; 4096];
    let deadline = Instant::now() + TOTAL_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            break;
        }
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(bytes_read) => {
                response
                    .len()
                    .checked_add(bytes_read)
                    .filter(|length| *length <= MAX_RESPONSE_SIZE)
                    .map(|_| ())?;
                response.extend_from_slice(&buffer[..bytes_read]);
                if http_response_is_complete(&response) {
                    break;
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) => {}
            Err(_) => return None,
        }
    }

    if !http_response_is_complete(&response) {
        return None;
    }
    let response = String::from_utf8(response).ok()?;
    browser_id_from_version_response(&response)
}

fn build_chrome_process_record(
    listener_pids: &[String],
    browser_id: Option<&str>,
) -> Option<ChromeProcessRecord> {
    if listener_pids.len() != 1 {
        return None;
    }
    Some(ChromeProcessRecord {
        pid: listener_pids.first()?.parse::<u32>().ok()?,
        browser_id: Some(browser_id?.to_string()),
    })
}

#[cfg(any(target_os = "linux", test))]
const LINUX_CHROME_COMMANDS: &[&str] = &["google-chrome", "google-chrome-stable"];

#[cfg(any(target_os = "linux", test))]
fn first_existing_path(paths: &[&str]) -> Option<String> {
    paths
        .iter()
        .find(|path| Path::new(path).exists())
        .map(|path| (*path).to_string())
}

#[cfg(any(target_os = "linux", test))]
fn find_command_in_path(command: &str, path_env: Option<&std::ffi::OsStr>) -> Option<String> {
    let path_env = path_env?;

    std::env::split_paths(path_env)
        .map(|dir| dir.join(command))
        .find(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
}

#[cfg(any(target_os = "linux", test))]
fn find_chrome_command_in_path(path_env: Option<&std::ffi::OsStr>) -> Option<String> {
    LINUX_CHROME_COMMANDS
        .iter()
        .find_map(|command| find_command_in_path(command, path_env))
}

#[cfg(any(target_os = "linux", test))]
fn find_linux_chrome_path(
    path_env: Option<&std::ffi::OsStr>,
    path_candidates: &[&str],
) -> Option<String> {
    find_chrome_command_in_path(path_env).or_else(|| first_existing_path(path_candidates))
}

fn find_chrome_path() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // 1. Program Files
        if let Ok(pf) = std::env::var("ProgramFiles") {
            let path = format!(r"{}\Google\Chrome\Application\chrome.exe", pf);
            if std::path::Path::new(&path).exists() {
                return Ok(path);
            }
        } else {
            let path = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
            if std::path::Path::new(path).exists() {
                return Ok(path.to_string());
            }
        }

        // 2. Program Files (x86)
        if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
            let path = format!(r"{}\Google\Chrome\Application\chrome.exe", pf86);
            if std::path::Path::new(&path).exists() {
                return Ok(path);
            }
        } else {
            let path = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe";
            if std::path::Path::new(path).exists() {
                return Ok(path.to_string());
            }
        }

        // 3. LocalAppData
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let path = format!(r"{}\Google\Chrome\Application\chrome.exe", local_app_data);
            if std::path::Path::new(&path).exists() {
                return Ok(path);
            }
        }

        Err("Google Chrome was not found in standard Windows installation paths. Please install Google Chrome.".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        let path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        if std::path::Path::new(path).exists() {
            Ok(path.to_string())
        } else {
            Err("Google Chrome not found at /Applications/Google Chrome.app".to_string())
        }
    }

    #[cfg(target_os = "linux")]
    {
        const LINUX_CHROME_PATHS: &[&str] = &[
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/local/bin/google-chrome",
            "/usr/local/bin/google-chrome-stable",
            "/opt/google/chrome/google-chrome",
        ];

        let path_env = std::env::var_os("PATH");
        find_linux_chrome_path(path_env.as_deref(), LINUX_CHROME_PATHS).ok_or_else(|| {
            "Google Chrome was not found in PATH or standard Linux installation paths. Please install Google Chrome or add google-chrome to PATH.".to_string()
        })
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("Google Chrome auto-detection is not supported on this operating system. Please use macOS, Windows, or Linux.".to_string())
    }
}

fn start_chrome_if_needed(headless: bool, verbose: bool) -> Result<(), String> {
    let profile_path = chrome_profile_path()?;

    if TcpStream::connect("127.0.0.1:9223").is_ok() {
        let snapshot = inspect_chrome_debug_port(&profile_path);
        if debug_listener_scope_is_unambiguous(&snapshot.listener_pids)
            && chrome_record_matches_current(
                snapshot.record.as_ref(),
                snapshot.browser_id.as_deref(),
                &snapshot.listener_pids,
            )
        {
            if headless {
                // Force hide any existing background Chrome PIDs asynchronously just in case they are currently visible
                #[cfg(target_os = "macos")]
                {
                    let pids = snapshot.ask_pids.clone();
                    thread::spawn(move || {
                        for pid_str in pids {
                            if let Ok(pid) = pid_str.parse::<u32>() {
                                let script = format!(
                                    "tell application \"System Events\" to set visible of first application process whose unix id is {} to false",
                                    pid
                                );
                                let _ = Command::new("osascript").arg("-e").arg(&script).status();
                            }
                        }
                    });
                }
            }
            if verbose && headless && !is_debug_chrome_background(&profile_path) {
                println!(
                    "Reusing existing ask-bridge Chrome on port 9223. Run `ask-bridge close` if you want to restart it in background mode."
                );
            }
            return Ok(());
        }

        if debug_listener_scope_is_unambiguous(&snapshot.listener_pids)
            && !snapshot.ask_pids.is_empty()
            && build_chrome_process_record(&snapshot.listener_pids, snapshot.browser_id.as_deref())
                .is_some()
        {
            if let Some(record) =
                build_chrome_process_record(&snapshot.listener_pids, snapshot.browser_id.as_deref())
            {
                write_chrome_process_record(&record).map_err(|error| {
                    format!("Failed to update Chrome process record: {}", error)
                })?;
            }
            if verbose {
                println!("Reusing the existing ask-bridge Chrome on port 9223.");
            }
            return Ok(());
        }

        return Err(
            "Port 9223 is already used by a non-ask Chrome process. Stop it or use a different debugging port."
                .to_string(),
        );
    }

    if verbose {
        println!(
            "Chrome is not running on port 9223. Starting Chrome with remote debugging (headless: {})...",
            headless
        );
    }

    let chrome_path = find_chrome_path()?;
    let _ = remove_chrome_pid_file();

    let mut cmd = Command::new(&chrome_path);
    cmd.arg("--remote-debugging-port=9223")
        .arg(format!("--user-data-dir={}", profile_path))
        .arg(ASK_BRIDGE_CHROME_MARKER)
        .arg("--no-first-run")
        .arg("--no-default-browser-check");

    #[cfg(target_os = "windows")]
    {
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    if headless {
        cmd.arg("--ask-bridge-background")
            .arg("--disable-blink-features=AutomationControlled")
            .arg("--window-size=1440,1200")
            .arg("--window-position=-2000,-2000");
    }

    let child = cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start Google Chrome: {}", e))?;

    let child_pid = child.id();

    if verbose {
        println!(
            "Started ask-bridge Chrome PID {} with profile {}.",
            child_pid, profile_path
        );
    }

    if headless {
        #[cfg(target_os = "macos")]
        {
            let pid = child.id();
            thread::spawn(move || {
                // Rapidly set visibility to false during startup to prevent window from flashing or drawing
                for _ in 0..40 {
                    let script = format!(
                        "tell application \"System Events\" to try\nset visible of first application process whose unix id is {} to false\nend try",
                        pid
                    );
                    let _ = Command::new("osascript").arg("-e").arg(&script).status();
                    thread::sleep(Duration::from_millis(50));
                }
            });
        }
    }

    let _ = child; // Avoid unused variable warning on non-macOS platforms

    // Wait for Chrome to listen and prove that the listener belongs to this launch.
    let startup_deadline = Instant::now() + Duration::from_secs(15);
    let mut last_identity_error = None;
    while Instant::now() < startup_deadline {
        if TcpStream::connect("127.0.0.1:9223").is_ok() {
            let snapshot = inspect_chrome_debug_port(&profile_path);
            if let Some(record) =
                build_chrome_process_record(&snapshot.listener_pids, snapshot.browser_id.as_deref())
            {
                if let Err(error) = write_chrome_process_record(&record) {
                    return Err(format!(
                        "Failed to record Chrome process identity: {}",
                        error
                    ));
                }
                if verbose && record.pid != child_pid {
                    println!(
                        "Recorded actual Chrome listener PID {} (launcher PID {}).",
                        record.pid, child_pid
                    );
                }
                if verbose {
                    println!("Chrome started and listening on port 9223.");
                }
                return Ok(());
            }
            last_identity_error = Some(
                "Chrome did not expose a valid CDP browser identity on port 9223.".to_string(),
            );
        }
        thread::sleep(Duration::from_millis(100));
    }

    let _ = remove_chrome_pid_file();
    match last_identity_error {
        Some(error) => Err(format!(
            "Failed to identify active Chrome listener: {}",
            error
        )),
        None => Err("Timed out waiting for Chrome to start on port 9223".to_string()),
    }
}

fn normalize_profile_match_text(value: &str) -> String {
    let normalized = value.replace('\\', "/").replace(['"', '\''], "");

    #[cfg(target_os = "windows")]
    {
        normalized.to_ascii_lowercase()
    }

    #[cfg(not(target_os = "windows"))]
    {
        normalized
    }
}

fn command_has_argument(command: &str, argument: &str) -> bool {
    command.match_indices(argument).any(|(start, matched)| {
        let before_is_boundary = start == 0
            || command[..start]
                .chars()
                .next_back()
                .map(char::is_whitespace)
                .unwrap_or(false);
        let end = start + matched.len();
        let after_is_boundary = end == command.len()
            || command[end..]
                .chars()
                .next()
                .map(char::is_whitespace)
                .unwrap_or(false);
        before_is_boundary && after_is_boundary
    })
}

fn command_uses_profile(command: &str, profile_path: &str) -> bool {
    let command = normalize_profile_match_text(command);
    let profile_path = normalize_profile_match_text(profile_path);

    command_has_argument(&command, &format!("--user-data-dir={}", profile_path))
        || command_has_argument(&command, &format!("--user-data-dir {}", profile_path))
}

fn command_identifies_ask_chrome(command: &str, profile_path: &str) -> bool {
    command_uses_profile(command, profile_path)
        || command_has_argument(command, ASK_BRIDGE_CHROME_MARKER)
}

fn find_ask_chrome_owner_pid_with<C, P>(
    listener_pid: &str,
    profile_path: &str,
    mut command_for: C,
    mut parent_for: P,
) -> Option<String>
where
    C: FnMut(&str) -> Option<String>,
    P: FnMut(&str) -> Option<String>,
{
    let mut current_pid = listener_pid.to_string();

    for _ in 0..16 {
        if command_for(&current_pid)
            .map(|command| command_identifies_ask_chrome(&command, profile_path))
            .unwrap_or(false)
        {
            return Some(current_pid);
        }

        let parent_pid = parent_for(&current_pid)?;
        if parent_pid.is_empty() || parent_pid == "0" || parent_pid == current_pid {
            return None;
        }
        current_pid = parent_pid;
    }

    None
}

fn chrome_record_matches_browser(record: &ChromeProcessRecord, browser_id: Option<&str>) -> bool {
    matches!(
        (record.browser_id.as_deref(), browser_id),
        (Some(recorded_id), Some(current_id)) if recorded_id == current_id
    )
}

fn chrome_record_matches_current(
    record: Option<&ChromeProcessRecord>,
    browser_id: Option<&str>,
    listener_pids: &[String],
) -> bool {
    record.is_some_and(|record| chrome_record_matches_browser(record, browser_id))
        && listener_pids.len() == 1
}

fn find_ask_chrome_owner_pids_with<C, P>(
    listener_pids: &[String],
    profile_path: &str,
    mut command_for: C,
    mut parent_for: P,
) -> Vec<String>
where
    C: FnMut(&str) -> Option<String>,
    P: FnMut(&str) -> Option<String>,
{
    let mut ask_pids = Vec::new();
    for listener_pid in listener_pids {
        let ask_pid = find_ask_chrome_owner_pid_with(
            listener_pid,
            profile_path,
            &mut command_for,
            &mut parent_for,
        );

        if let Some(ask_pid) = ask_pid
            && !ask_pids.contains(&ask_pid)
        {
            ask_pids.push(ask_pid);
        }
    }
    ask_pids
}

struct ChromeDebugSnapshot {
    listener_pids: Vec<String>,
    record: Option<ChromeProcessRecord>,
    browser_id: Option<String>,
    ask_pids: Vec<String>,
}

fn debug_listener_scope_is_unambiguous(listener_pids: &[String]) -> bool {
    listener_pids.len() <= 1
}

fn inspect_chrome_debug_port(profile_path: &str) -> ChromeDebugSnapshot {
    let listener_pids = debug_port_listener_pids();
    let record = read_chrome_process_record();
    let browser_id = debug_browser_id();
    let ask_pids = find_ask_chrome_owner_pids_with(
        &listener_pids,
        profile_path,
        process_command,
        process_parent_pid,
    );
    ChromeDebugSnapshot {
        listener_pids,
        record,
        browser_id,
        ask_pids,
    }
}

fn ask_chrome_pids_on_debug_port(profile_path: &str) -> Vec<String> {
    inspect_chrome_debug_port(profile_path).ask_pids
}

#[cfg(target_os = "windows")]
fn parse_windows_netstat_listener_pids(output: &str, port: u16) -> Vec<String> {
    let mut pids = Vec::new();
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5
            || !fields[0].eq_ignore_ascii_case("TCP")
            || !fields[3].eq_ignore_ascii_case("LISTENING")
            || fields[1]
                .rsplit_once(':')
                .and_then(|(_, port)| port.parse::<u16>().ok())
                != Some(port)
        {
            continue;
        }

        let pid = fields[4];
        if pid.chars().all(|character| character.is_ascii_digit())
            && !pids.iter().any(|existing| existing == pid)
        {
            pids.push(pid.to_string());
        }
    }
    pids
}

fn debug_port_listener_pids() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("netstat").args(["-ano", "-p", "tcp"]).output();

        match output {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                parse_windows_netstat_listener_pids(&stdout, 9223)
            }
            _ => Vec::new(),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("lsof")
            .args(["-tiTCP:9223", "-sTCP:LISTEN"])
            .output();

        match output {
            Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect(),
            _ => Vec::new(),
        }
    }
}

#[cfg(target_os = "windows")]
fn parse_wmic_column_value(output: &str) -> Option<String> {
    let mut non_empty_lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    non_empty_lines.next()?;
    non_empty_lines.next().map(str::to_string)
}

fn process_command(pid: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("wmic")
            .args([
                "process",
                "where",
                &format!("processid={}", pid),
                "get",
                "commandline",
            ])
            .output();

        if let Ok(out) = output
            && out.status.success()
        {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if let Some(command) = parse_wmic_column_value(&stdout) {
                return Some(command);
            }
        }

        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "(Get-CimInstance Win32_Process -Filter 'ProcessId = {}').CommandLine",
                    pid
                ),
            ])
            .output();

        if let Ok(out) = output
            && out.status.success()
        {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !stdout.is_empty() {
                return Some(stdout);
            }
        }

        None
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("ps")
            .args(["-p", pid, "-o", "command="])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
}

fn process_parent_pid(pid: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("wmic")
            .args([
                "process",
                "where",
                &format!("processid={}", pid),
                "get",
                "parentprocessid",
            ])
            .output();

        if let Ok(out) = output
            && out.status.success()
            && let Some(parent_pid) = parse_wmic_column_value(&String::from_utf8_lossy(&out.stdout))
        {
            return Some(parent_pid);
        }

        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "(Get-CimInstance Win32_Process -Filter 'ProcessId = {}').ParentProcessId",
                    pid
                ),
            ])
            .output();

        if let Ok(out) = output
            && out.status.success()
        {
            let parent_pid = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !parent_pid.is_empty() {
                return Some(parent_pid);
            }
        }

        None
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("ps")
            .args(["-p", pid, "-o", "ppid="])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let parent_pid = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if parent_pid.is_empty() {
            None
        } else {
            Some(parent_pid)
        }
    }
}

fn is_debug_chrome_background(profile_path: &str) -> bool {
    ask_chrome_pids_on_debug_port(profile_path)
        .iter()
        .any(|pid| {
            process_command(pid)
                .map(|cmd| cmd.contains("--ask-bridge-background"))
                .unwrap_or(false)
        })
}

fn close_ask_chrome_on_debug_port(profile_path: &str) -> Result<bool, String> {
    let snapshot = inspect_chrome_debug_port(profile_path);
    if snapshot.listener_pids.is_empty() {
        if TcpStream::connect("127.0.0.1:9223").is_ok() {
            return Err(
                "Port 9223 is active, but ask-bridge could not identify its listener process. No process was closed."
                    .to_string(),
            );
        }
        if let Err(_error) = remove_chrome_pid_file() {
            // ignore cleanup failure when port is already closed
        }
        return Ok(false);
    }
    if !debug_listener_scope_is_unambiguous(&snapshot.listener_pids) {
        return Err(
            "Multiple processes are listening on port 9223, so ask-bridge cannot safely determine which process to close. No process was closed."
                .to_string(),
        );
    }

    if snapshot.ask_pids.is_empty() {
        return Err(
            "Port 9223 is already used by a non-ask Chrome process. Stop it or use a different debugging port."
                .to_string(),
        );
    }

    for pid in &snapshot.ask_pids {
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill").args(["/PID", pid, "/T"]).status();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = Command::new("kill").args(["-TERM", pid]).status();
        }
    }

    for _ in 0..50 {
        if TcpStream::connect("127.0.0.1:9223").is_err() {
            let _ = remove_chrome_pid_file();
            return Ok(true);
        }
        thread::sleep(Duration::from_millis(100));
    }

    Err("Timed out waiting for existing ask-bridge Chrome to stop".to_string())
}

static FORWARD_MCP_STDERR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// One MCP session per run: a single long-lived chrome-devtools-mcp child plus
/// the tokio runtime that drives its background reader tasks.
///
/// Upstream called `McpClient::call_tool` per browser action, which spawns a
/// fresh `npx chrome-devtools-mcp` child for every single action (~50 per
/// query) and waits on its response without any timeout — one stalled npx
/// spawn hung the whole run forever (2026-07-11). Reusing one connection
/// removes the re-spawn churn; `MCP_CALL_TIMEOUT` turns any remaining stall
/// into a loud, bounded error (see `mcp_error_is_transport` for why the failed
/// call is not replayed).
struct McpSession {
    connection: McpConnection,
    runtime: tokio::runtime::Runtime,
    config_path: String,
}

static MCP_SESSION: std::sync::Mutex<Option<McpSession>> = std::sync::Mutex::new(None);

const MCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(120);
const MCP_CALL_TIMEOUT: Duration = Duration::from_secs(90);
const MCP_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug)]
struct McpOperationDeadline {
    expires_at: Instant,
}

impl McpOperationDeadline {
    fn from_timeout(timeout: Duration) -> Result<Self, String> {
        Self::from_start(Instant::now(), timeout)
    }

    fn from_start(started_at: Instant, timeout: Duration) -> Result<Self, String> {
        let expires_at = started_at
            .checked_add(timeout)
            .ok_or_else(|| "MCP operation deadline overflow".to_string())?;
        Ok(Self { expires_at })
    }

    fn phase_timeout(self, cap: Duration, phase: &str) -> Result<Duration, String> {
        self.phase_timeout_at(Instant::now(), cap, phase)
    }

    fn phase_timeout_at(
        self,
        now: Instant,
        cap: Duration,
        phase: &str,
    ) -> Result<Duration, String> {
        let remaining = self.expires_at.saturating_duration_since(now);
        if remaining.is_zero() {
            return Err(format!("MCP operation deadline exhausted before {}", phase));
        }
        Ok(remaining.min(cap))
    }
}

fn mcp_session_connect(
    config_path: &str,
    deadline: Option<McpOperationDeadline>,
) -> Result<McpSession, String> {
    if let Some(deadline) = deadline {
        deadline.phase_timeout(MCP_CONNECT_TIMEOUT, "MCP config load")?;
    }
    let client = McpClient::load(Some(config_path))
        .map_err(|e| format!("Failed to load MCP config: {}", e))?;
    let server_config = client
        .server_config("chrome-devtools")
        .map_err(|e| format!("Missing chrome-devtools MCP server config: {}", e))?;
    // A multi-thread runtime with one worker keeps the connection's background
    // stdout/stderr reader tasks running between calls (a current-thread
    // runtime only makes progress inside block_on).
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .map_err(|e| format!("Failed to create async runtime for MCP session: {}", e))?;
    let connection = runtime.block_on(async {
        // Connect the stdio transport directly: mcp-cli's default path first
        // tries its persistent daemon, which re-execs this binary with
        // `--daemon` — an entrypoint ask-bridge does not implement — so that
        // path can only ever fail and fall back.
        let connect_future = async {
            match &server_config {
                ServerConfig::Stdio(stdio_config) => {
                    StdioClient::connect("chrome-devtools", stdio_config)
                        .await
                        .map(McpConnection::Stdio)
                }
                _ => client.connect("chrome-devtools").await,
            }
        };
        let connect_timeout = match deadline {
            Some(deadline) => deadline.phase_timeout(MCP_CONNECT_TIMEOUT, "MCP session connect")?,
            None => MCP_CONNECT_TIMEOUT,
        };
        match tokio::time::timeout(connect_timeout, connect_future).await {
            Err(_) => Err(format!(
                "Failed to start chrome-devtools MCP server: timed out after {}s",
                connect_timeout.as_secs()
            )),
            Ok(result) => {
                result.map_err(|e| format!("Failed to start chrome-devtools MCP server: {}", e))
            }
        }
    })?;
    Ok(McpSession {
        connection,
        runtime,
        config_path: config_path.to_string(),
    })
}

fn mcp_session_reset(
    slot: &mut Option<McpSession>,
    deadline: Option<McpOperationDeadline>,
) -> Result<(), String> {
    if let Some(session) = slot.take() {
        let McpSession {
            connection,
            runtime,
            ..
        } = session;
        // Best-effort close (kills the child); if even that stalls, dropping
        // the runtime stops the background tasks and the orphaned child exits
        // on stdin EOF.
        let close_timeout = match deadline {
            Some(deadline) => {
                match deadline.phase_timeout(MCP_CLOSE_TIMEOUT, "MCP session reset") {
                    Ok(timeout) => timeout,
                    Err(error) => {
                        drop(connection);
                        drop(runtime);
                        return Err(error);
                    }
                }
            }
            None => MCP_CLOSE_TIMEOUT,
        };
        let _ = runtime
            .block_on(async { tokio::time::timeout(close_timeout, connection.close()).await });
    }
    Ok(())
}

fn mcp_session_call(
    slot: &mut Option<McpSession>,
    config_path: &str,
    tool: &str,
    args: Value,
    call_timeout: Duration,
    deadline: Option<McpOperationDeadline>,
) -> Result<Value, String> {
    let needs_connect = slot
        .as_ref()
        .map(|session| session.config_path != config_path)
        .unwrap_or(true);
    if needs_connect {
        mcp_session_reset(slot, deadline)?;
        *slot = Some(mcp_session_connect(config_path, deadline)?);
    }
    let session = slot.as_ref().expect("session connected above");
    let tool_timeout = match deadline {
        Some(deadline) => deadline.phase_timeout(call_timeout, "MCP tool call")?,
        None => call_timeout,
    };
    session.runtime.block_on(async {
        match tokio::time::timeout(tool_timeout, session.connection.call_tool(tool, args)).await {
            Err(_) => Err(format!(
                "MCP tool '{}' timed out after {}s",
                tool,
                tool_timeout.as_secs()
            )),
            Ok(result) => result.map_err(|e| format!("mcp-cli library call failed: {}", e)),
        }
    })
}

/// Errors that mean the MCP transport itself is dead or wedged: our own
/// timeouts, or transport-level failures (dead child / closed pipes — exact
/// phrases from mcp-cli's StdioClient). These earn a session reset so the next
/// command starts clean. The failed call is deliberately NOT replayed: a
/// timed-out request may already have executed in the browser (replaying a
/// submit would double-post), and a fresh chrome-devtools-mcp child forgets
/// the selected page (a replay could act on the wrong tab). Application-level
/// tool errors (e.g. a JS exception from evaluate_script) propagate unchanged.
fn mcp_error_is_transport(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("timed out")
        || lower.contains("deadline exhausted")
        || lower.contains("failed to send request to process stdin")
        || lower.contains("server process exited unexpectedly")
        || lower.contains("stdio response receiver canceled")
        || lower.contains("failed to start chrome-devtools mcp server")
}

fn call_mcp_tool_raw(config_path: &str, tool: &str, args: Value) -> Result<Value, String> {
    call_mcp_tool_raw_with_deadline(config_path, tool, args, None)
}

fn call_mcp_tool_raw_with_deadline(
    config_path: &str,
    tool: &str,
    args: Value,
    deadline: Option<McpOperationDeadline>,
) -> Result<Value, String> {
    let _stderr_guard = if FORWARD_MCP_STDERR.load(std::sync::atomic::Ordering::Relaxed) {
        None
    } else {
        Some(
            gag::Gag::stderr()
                .map_err(|e| format!("Failed to suppress MCP stderr in quiet mode: {}", e))?,
        )
    };

    let mut slot = MCP_SESSION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match mcp_session_call(
        &mut slot,
        config_path,
        tool,
        args,
        MCP_CALL_TIMEOUT,
        deadline,
    ) {
        Ok(value) => Ok(value),
        Err(error) => {
            if mcp_error_is_transport(&error) {
                let _ = mcp_session_reset(&mut slot, deadline);
                return Err(format!(
                    "{} (MCP session was reset; re-run the command)",
                    error
                ));
            }
            Err(error)
        }
    }
}

fn bind_owned_page(session_id: &str, page_id: usize) -> Result<(), String> {
    let session_id = validate_session_id(session_id)?;
    let mut binding = OWNED_PAGE_BINDING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if binding.is_some() {
        return Err("本程序已有 active owned page；不得覆寫分頁 ownership".to_string());
    }
    *binding = Some(OwnedPageBinding {
        session_id,
        page_id,
    });
    Ok(())
}

fn clear_owned_page() {
    let mut binding = OWNED_PAGE_BINDING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *binding = None;
}

fn owned_page_binding() -> Option<OwnedPageBinding> {
    OWNED_PAGE_BINDING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn page_bound_mcp_tool(tool: &str) -> bool {
    !matches!(
        tool,
        "list_pages" | "new_page" | "select_page" | "close_page"
    )
}

fn call_mcp_tool(config_path: &str, tool: &str, args: Value) -> Result<Value, String> {
    call_mcp_tool_with_deadline(config_path, tool, args, None)
}

fn call_mcp_tool_with_deadline(
    config_path: &str,
    tool: &str,
    args: Value,
    deadline: Option<McpOperationDeadline>,
) -> Result<Value, String> {
    if let Some(binding) = owned_page_binding() {
        if tool == "close_page" || tool == "new_page" {
            return Err(format!(
                "isolated session {} 不允許 {}，以免破壞既有或未受管頁籤",
                binding.session_id, tool
            ));
        }
        if tool == "select_page" {
            let requested_page_id = args.get("pageId").and_then(Value::as_u64);
            if requested_page_id != Some(binding.page_id as u64) {
                return Err(format!(
                    "isolated session {} 只能選取 owned page ID {}",
                    binding.session_id, binding.page_id
                ));
            }
        }
        if page_bound_mcp_tool(tool) {
            call_mcp_tool_raw_with_deadline(
                config_path,
                "select_page",
                serde_json::json!({
                    "pageId": binding.page_id,
                    "bringToFront": false
                }),
                deadline,
            )?;
        }
    }
    call_mcp_tool_raw_with_deadline(config_path, tool, args, deadline)
}

/// Decide whether to close the owned tab after a verified success.
///
/// Returns the exact owned page ID to close, or an `Err` with a reason to
/// skip. This is a pure decision: it never performs any MCP call, so it can be
/// tested without a live browser. Cleanup is refused for submitted/unknown
/// outcomes, identity-changed responses, unknown downloads, and unbounded
/// pages.
fn decide_owned_tab_cleanup(
    binding: Option<&OwnedPageBinding>,
    receipt: Option<&SessionReceipt>,
) -> Result<usize, String> {
    let Some(binding) = binding else {
        return Err("no active owned page binding; nothing to clean up".to_string());
    };
    let Some(receipt) = receipt else {
        return Err("no session receipt; cannot verify success outcome".to_string());
    };
    if receipt.response_completion != ResponseCompletion::Completed {
        return Err(format!(
            "response outcome is not Completed ({:?}); skipping cleanup",
            receipt.response_completion
        ));
    }
    if receipt.response_failure_code.is_some() {
        return Err("response failure recorded; skipping cleanup".to_string());
    }
    if receipt.expected_output_type == ExpectedOutputType::Image
        && receipt.downloaded_image_count == 0
    {
        return Err("image download count is unknown/empty; skipping cleanup".to_string());
    }
    Ok(binding.page_id)
}

/// Verify the exact owned page still exists in the live page list before
/// closing it, so cleanup can never close an existing or unowned tab (e.g. a
/// newly-created page that reused the ID after the owned page disappeared).
fn verify_owned_page_present(
    page_id: usize,
    current_page_ids: &std::collections::HashSet<usize>,
) -> Result<(), String> {
    if current_page_ids.contains(&page_id) {
        Ok(())
    } else {
        Err(format!(
            "owned page ID {} is no longer present; skipping cleanup",
            page_id
        ))
    }
}

/// Internal cleanup: after a verified success, raw-close the exact owned page.
///
/// This is a SUPPORTING, non-gating step. It deliberately uses
/// `call_mcp_tool_raw` so it does NOT relax the general isolated mutation
/// guard in `call_mcp_tool` (which still rejects `close_page`/`new_page`).
/// Any failure is surfaced as an `Err` for the caller to sanitise into a
/// warning; it never changes the success receipt, downloaded images, output
/// files, or process exit success.
fn cleanup_owned_page_after_success(
    config_path: &str,
    receipt_path: Option<&Path>,
) -> Result<(), String> {
    let binding = owned_page_binding();
    let receipt = match receipt_path {
        Some(path) => Some(read_session_receipt(path)?),
        None => None,
    };
    let page_id = decide_owned_tab_cleanup(binding.as_ref(), receipt.as_ref())?;
    let current_page_ids: std::collections::HashSet<usize> = list_pages(config_path)?
        .into_iter()
        .map(|page| page.id)
        .collect();
    verify_owned_page_present(page_id, &current_page_ids)?;
    call_mcp_tool_raw(
        config_path,
        "close_page",
        serde_json::json!({ "pageId": page_id }),
    )?;
    clear_owned_page();
    Ok(())
}

/// Run owned-tab cleanup after a verified success, sanitising any failure to a
/// warning string. Returns `None` on success (or when there is nothing to
/// clean up) and `Some(warning)` on failure, so the caller can print the
/// warning without changing the already-verified success result.
fn run_owned_tab_cleanup_warning(config_path: &str, receipt_path: Option<&Path>) -> Option<String> {
    match cleanup_owned_page_after_success(config_path, receipt_path) {
        Ok(()) => None,
        Err(error) => Some(format!(
            "Warning: could not close owned tab after success: {}",
            error
        )),
    }
}

fn parse_pages(text: &str) -> Vec<Page> {
    let mut pages = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("##") {
            continue;
        }
        if let Some((id_str, rest)) = line.split_once(':') {
            let id = match id_str.trim().parse::<usize>() {
                Ok(id) => id,
                Err(_) => continue,
            };
            let rest = rest.trim();
            let (url, selected) = if rest.ends_with("[selected]") {
                let url = rest.strip_suffix("[selected]").unwrap().trim().to_string();
                (url, true)
            } else {
                (rest.to_string(), false)
            };
            pages.push(Page { id, url, selected });
        }
    }
    pages
}

fn parse_script_result(val: &Value) -> Result<Value, String> {
    let text = val
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|obj| obj.get("text"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| "Could not extract text field from evaluate_script result".to_string())?;

    let start_tag = "```json";

    if let Some(start_pos) = text.find(start_tag) {
        let json_start = start_pos + start_tag.len();
        let json_str = text[json_start..].trim_start();
        let mut values = serde_json::Deserializer::from_str(json_str).into_iter::<Value>();
        let parsed = values
            .next()
            .ok_or_else(|| "JSON parsing error: missing JSON value".to_string())?
            .map_err(|e| format!("JSON parsing error: {}", e))?;
        let remainder = json_str[values.byte_offset()..].trim_start();
        let after_fence = remainder
            .strip_prefix("```")
            .ok_or_else(|| "Could not find closing JSON fence in script result".to_string())?;
        if !matches!(after_fence.chars().next(), None | Some('\r') | Some('\n')) {
            return Err("Invalid closing JSON fence in script result".to_string());
        }
        return Ok(parsed);
    }

    Err("Could not find JSON fencing in script result".to_string())
}

fn tool_text(val: &Value) -> Result<String, String> {
    val.get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|obj| obj.get("text"))
        .and_then(|t| t.as_str())
        .map(|text| text.to_string())
        .ok_or_else(|| "Could not extract text field from tool result".to_string())
}

fn take_snapshot_text(config_path: &str) -> Result<String, String> {
    let res = call_mcp_tool(config_path, "take_snapshot", serde_json::json!({}))?;
    tool_text(&res)
}

fn extract_snapshot_uid(line: &str) -> Option<String> {
    let marker_pos = line.find("uid=")?;
    let mut rest = line[marker_pos + 4..].trim_start();
    rest = rest.trim_start_matches(['"', '\'', '[']);
    let uid: String = rest
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'' && *c != ']')
        .collect();
    if uid.is_empty() { None } else { Some(uid) }
}

fn find_snapshot_uid(snapshot: &str, include: &[&str], exclude: &[&str]) -> Option<String> {
    snapshot.lines().find_map(|line| {
        let lower = line.to_lowercase();
        let includes_all = include
            .iter()
            .all(|needle| lower.contains(&needle.to_lowercase()));
        let excludes_all = exclude
            .iter()
            .all(|needle| !lower.contains(&needle.to_lowercase()));
        if includes_all && excludes_all {
            extract_snapshot_uid(line)
        } else {
            None
        }
    })
}

fn is_glow_available() -> bool {
    Command::new("glow")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn render_markdown(markdown: &str, use_glow: bool) -> Result<(), String> {
    if markdown.is_empty() {
        return Ok(());
    }

    if use_glow {
        let glow = Command::new("glow")
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn();

        if let Ok(mut child) = glow {
            let stdin_opt = child.stdin.take();
            if let Some(mut stdin) = stdin_opt {
                let _ = stdin.write_all(markdown.as_bytes()).map_err(|e| {
                    eprintln!("Failed to send Markdown content to glow: {}", e);
                });
            }

            match child.wait() {
                Ok(status) if status.success() => {
                    return Ok(());
                }
                Ok(status) => {
                    eprintln!("glow exited with status: {}", status);
                }
                Err(e) => {
                    eprintln!("Failed to wait for glow process: {}", e);
                }
            }
        }
    }

    print!("{}", markdown);
    io::stdout()
        .flush()
        .map_err(|e| format!("Failed to flush stdout: {}", e))?;

    Ok(())
}

fn validate_provider_feature_support(provider: Provider, cli: &Cli) -> Result<(), String> {
    if provider == Provider::Gemini && !cli.images.is_empty() {
        return Err(
            "Gemini image attachments are not supported yet. Use --file for Gemini document attachments."
                .to_string(),
        );
    }

    Ok(())
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[test]
    fn declares_verified_upload_and_isolated_capabilities() {
        let capabilities = capabilities_value();
        let advertised = capabilities["capabilities"]
            .as_array()
            .expect("capabilities array")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert!(advertised.contains(&ISOLATED_NEW_TAB_CAPABILITY));
        assert!(advertised.contains(&BACKGROUND_ISOLATED_TAB_CAPABILITY));
        assert!(advertised.contains(&VERIFIED_FILE_UPLOAD_CAPABILITY));
        assert!(advertised.contains(&VERIFIED_MIXED_ATTACHMENT_CAPABILITY));
        assert!(advertised.contains(&VERIFIED_IMAGE_RESPONSE_COMPLETION_CAPABILITY));
        assert!(advertised.contains(&VERIFIED_MODEL_SELECTION_CAPABILITY));
        assert!(advertised.contains(&VERIFIED_MODEL_SELECTION_V2_CAPABILITY));
        assert!(advertised.contains(&VERIFIED_MODEL_SELECTION_V3_CAPABILITY));
        assert_eq!(
            capabilities["isolated_new_tab_v1"]["flag"].as_str(),
            Some("--new-tab-preserve-existing")
        );
        assert_eq!(
            capabilities["background_isolated_tab_v1"]["new_page_background"].as_str(),
            Some("headless")
        );
        assert_eq!(
            capabilities["background_isolated_tab_v1"]["foreground"].as_str(),
            Some("visible")
        );
        assert_eq!(
            capabilities["background_isolated_tab_v1"]["scope"].as_str(),
            Some("isolated-new-tab-only")
        );
        assert_eq!(
            capabilities["verified_file_upload_v1"]["verification"].as_str(),
            Some("filename-multiset-stable-dom-probe")
        );
        assert_eq!(
            capabilities["verified_mixed_attachment_upload_v1"]["verification"].as_str(),
            Some("typed-document-image-stable-dom-probe")
        );
        assert_eq!(
            capabilities["verified_image_response_completion_v1"]["verification"].as_str(),
            Some("new-assistant-no-generation-control-loaded-large-image-stable-dom")
        );
        assert_eq!(
            capabilities["verified_image_response_completion_v1"]["zero_images_exit_success"]
                .as_bool(),
            Some(false)
        );
        assert_eq!(
            capabilities["verified_image_response_completion_v1"]["user_delta"].as_u64(),
            Some(1)
        );
        assert_eq!(
            capabilities["verified_model_selection_v1"]["pre_submit_fail_closed"].as_bool(),
            Some(true)
        );
        assert_eq!(
            capabilities["verified_model_selection_v1"]["selection_contracts"],
            serde_json::json!(["legacy_menu_v1", "reasoning_slider_v1"])
        );
        assert_eq!(
            capabilities["verified_model_selection_v2"]["evidence"],
            serde_json::json!([
                "checked_state_v1",
                "accessible_label_v1",
                "bounded_ordinal_v1"
            ])
        );
        assert_eq!(
            capabilities["verified_model_selection_v2"]["ordinal_profile"]["mapping"],
            serde_json::json!({"instant": 0, "medium": 1, "high": 2})
        );
        assert_eq!(
            capabilities["verified_model_selection_v3"]["evidence"],
            serde_json::json!([
                "checked_state_v1",
                "accessible_label_v1",
                "bounded_ordinal_v1",
                "resolved_bounded_ordinal_v2"
            ])
        );
        assert_eq!(
            capabilities["verified_model_selection_v3"]["control_bundle"]["role_evidence"],
            serde_json::json!(["slider", "native_range", "missing", "conflict"])
        );
        assert!(
            capabilities["version"]
                .as_str()
                .unwrap()
                .contains("preserve")
        );

        let cli = Cli::try_parse_from([
            "ask-bridge",
            "--new-tab-preserve-existing",
            "--session-id",
            "00000000-0000-4000-8000-000000000001",
            "prompt",
        ])
        .unwrap();
        assert!(cli.new_tab_preserve_existing);
        assert_eq!(
            cli.session_id.as_deref(),
            Some("00000000-0000-4000-8000-000000000001")
        );
        assert!(
            Cli::try_parse_from([
                "ask-bridge",
                "--session-id",
                "00000000-0000-4000-8000-000000000001",
                "prompt"
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "ask-bridge",
                "--new",
                "--new-tab-preserve-existing",
                "--session-id",
                "00000000-0000-4000-8000-000000000001",
                "prompt",
            ])
            .is_err()
        );
        let probe = Cli::try_parse_from(["ask-bridge", "session-probe", "--json"]).unwrap();
        assert!(matches!(
            probe.command,
            Some(Commands::SessionProbe { json: true })
        ));
    }

    #[test]
    fn isolated_new_page_args_maps_headless_to_background() {
        let headless = isolated_new_page_args("https://chatgpt.com/", true);
        assert_eq!(headless["url"].as_str(), Some("https://chatgpt.com/"));
        assert_eq!(headless["background"].as_bool(), Some(true));

        let visible = isolated_new_page_args("https://chatgpt.com/", false);
        assert_eq!(visible["url"].as_str(), Some("https://chatgpt.com/"));
        assert_eq!(visible["background"].as_bool(), Some(false));
    }

    #[test]
    fn session_receipt_declares_background_isolated_tab_capability() {
        let receipt = SessionReceipt::new(0, 0);
        assert!(
            receipt
                .capabilities
                .contains(&BACKGROUND_ISOLATED_TAB_CAPABILITY.to_string())
        );
        assert!(
            receipt
                .capabilities
                .contains(&VERIFIED_MODEL_SELECTION_V3_CAPABILITY.to_string())
        );
        assert_eq!(receipt.schema_version, SESSION_RECEIPT_SCHEMA_VERSION);
    }

    fn response_probe(
        assistant_count: usize,
        generating: bool,
        loaded_large_image_count: usize,
        signature: &str,
    ) -> ResponseDomProbe {
        ResponseDomProbe {
            ownership_token_matches: true,
            provider_url_owned: true,
            url: "https://chatgpt.com/c/response-contract".to_string(),
            conversation_id: "conversation:response-contract".to_string(),
            turn_id: String::new(),
            artifact_ids: Vec::new(),
            user_count: 1,
            assistant_count,
            generation_control_visible: generating,
            content_present: assistant_count > 0,
            content_text_length: if assistant_count > 0 { 1000 } else { 0 },
            provider_failure_visible: false,
            loaded_large_image_count,
            dom_signature: signature.to_string(),
        }
    }

    #[test]
    fn image_completion_waits_for_loaded_artifact_after_assistant_and_stop_disappear() {
        let mut tracker = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 4);

        // Two seconds of a new assistant node with no Stop control is not a
        // completed image response while the expected artifact is absent.
        for _ in 0..4 {
            assert_eq!(
                tracker.observe(response_probe(5, false, 0, "assistant-only")),
                ResponseTrackerDecision::Pending
            );
        }

        assert_eq!(
            tracker.observe(response_probe(5, false, 1, "image-v1")),
            ResponseTrackerDecision::Pending
        );
        assert_eq!(
            tracker.observe(response_probe(5, false, 1, "image-v1")),
            ResponseTrackerDecision::Pending
        );
        assert!(matches!(
            tracker.observe(response_probe(5, false, 1, "image-v1")),
            ResponseTrackerDecision::Completed(_)
        ));
        assert_eq!(RESPONSE_REQUIRED_STABLE_PROBES, 3);
        assert_eq!(RESPONSE_POLL_INTERVAL, Duration::from_millis(500));
    }

    #[test]
    fn image_completion_resets_stability_when_dom_signature_changes() {
        let mut tracker = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 1);
        assert_eq!(
            tracker.observe(response_probe(2, false, 1, "image-loading")),
            ResponseTrackerDecision::Pending
        );
        assert_eq!(
            tracker.observe(response_probe(2, false, 1, "image-final")),
            ResponseTrackerDecision::Pending
        );
        assert_eq!(
            tracker.observe(response_probe(2, false, 1, "image-final")),
            ResponseTrackerDecision::Pending
        );
        assert!(matches!(
            tracker.observe(response_probe(2, false, 1, "image-final")),
            ResponseTrackerDecision::Completed(_)
        ));
    }

    #[test]
    fn text_completion_uses_content_contract_without_requiring_an_image() {
        let mut tracker = ResponseCompletionTracker::new(ExpectedOutputType::Text, 0, 6);
        for expected in [
            ResponseTrackerDecision::Pending,
            ResponseTrackerDecision::Pending,
        ] {
            assert_eq!(
                tracker.observe(response_probe(7, false, 0, "stable-text")),
                expected
            );
        }
        assert!(matches!(
            tracker.observe(response_probe(7, false, 0, "stable-text")),
            ResponseTrackerDecision::Completed(_)
        ));
    }

    #[test]
    fn text_completion_rejects_short_processing_status_text() {
        // R8: ChatGPT can show a short processing-status text (e.g. "Reading
        // Schema For JSON Deck Plan Validation", ~44 bytes) while the Stop
        // button briefly disappears during attachment processing.  Such a
        // short text must NOT be treated as a completed response.
        let mut tracker = ResponseCompletionTracker::new(ExpectedOutputType::Text, 0, 6);
        let mut short_probe = response_probe(7, false, 0, "short-status");
        short_probe.content_text_length = 44; // simulates "Reading Schema..." status text
        // Even after 5 probes (well beyond the 3-probe stability window) the
        // short text should never reach Completed.
        for _ in 0..5 {
            assert_eq!(
                tracker.observe(short_probe.clone()),
                ResponseTrackerDecision::Pending
            );
        }
    }

    #[test]
    fn text_completion_accepts_response_meeting_minimum_length() {
        let mut tracker = ResponseCompletionTracker::new(ExpectedOutputType::Text, 0, 6);
        // A response at exactly the minimum boundary should complete normally
        // after the stability window.
        let mut min_probe = response_probe(7, false, 0, "min-length-text");
        min_probe.content_text_length = MINIMUM_TEXT_RESPONSE_BYTES;
        for _ in 0..(RESPONSE_REQUIRED_STABLE_PROBES - 1) {
            assert_eq!(
                tracker.observe(min_probe.clone()),
                ResponseTrackerDecision::Pending
            );
        }
        assert!(matches!(
            tracker.observe(min_probe),
            ResponseTrackerDecision::Completed(_)
        ));
    }

    #[test]
    fn attachment_verify_timeout_scales_with_file_count() {
        // R10: 4-file repair requests need more than the 60-second base.
        assert_eq!(
            attachment_verify_timeout_for_count(0),
            Duration::from_secs(60)
        );
        assert_eq!(
            attachment_verify_timeout_for_count(2),
            Duration::from_secs(90)
        );
        assert_eq!(
            attachment_verify_timeout_for_count(4),
            Duration::from_secs(120)
        );
    }

    #[test]
    fn chatgpt_assistant_selector_deduplicates_nested_role_nodes() {
        assert_eq!(
            Provider::ChatGpt.assistant_selector(),
            ".agent-turn, [data-message-author-role=\"assistant\"]:not(.agent-turn *)"
        );
    }

    #[test]
    fn text_completion_fails_closed_on_assistant_count_change() {
        let mut tracker = ResponseCompletionTracker::new(ExpectedOutputType::Text, 0, 6);

        // The DOM probe must canonicalize one visual turn before it reaches
        // this state machine.  A real count delta remains an identity change
        // for text as well as image tasks, so it must fail closed.
        assert_eq!(
            tracker.observe(response_probe(8, false, 0, "text-final-v1")),
            ResponseTrackerDecision::Unknown(ResponseFailureCode::AssistantCountChanged)
        );
    }

    #[test]
    fn image_provider_rejection_fails_closed_without_waiting_for_timeout() {
        let mut tracker = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 0);
        let mut rejected = response_probe(1, false, 0, "provider-rejection");
        rejected.provider_failure_visible = true;
        rejected.turn_id = "request-WEB:refusal-0".to_string();
        assert_eq!(
            tracker.observe(rejected.clone()),
            ResponseTrackerDecision::Pending
        );
        assert_eq!(
            tracker.observe(rejected.clone()),
            ResponseTrackerDecision::Pending
        );
        assert_eq!(
            tracker.observe(rejected),
            ResponseTrackerDecision::Unknown(ResponseFailureCode::ProviderRejected)
        );
    }

    #[test]
    fn response_completion_fails_closed_on_ownership_url_or_assistant_interference() {
        let mut ownership = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);
        let mut lost = response_probe(3, false, 1, "ready");
        lost.ownership_token_matches = false;
        assert_eq!(
            ownership.observe(lost),
            ResponseTrackerDecision::Unknown(ResponseFailureCode::PageOwnershipChanged)
        );

        let mut count = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);
        assert_eq!(
            count.observe(response_probe(4, false, 1, "other-response")),
            ResponseTrackerDecision::Unknown(ResponseFailureCode::AssistantCountChanged)
        );

        let mut extra_user = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);
        let mut manually_submitted = response_probe(3, false, 1, "other-prompt-response");
        manually_submitted.user_count = 2;
        assert_eq!(
            extra_user.observe(manually_submitted),
            ResponseTrackerDecision::Unknown(ResponseFailureCode::ResponseIdentityChanged)
        );

        let mut url = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);
        assert_eq!(
            url.observe(response_probe(3, false, 1, "ready")),
            ResponseTrackerDecision::Pending
        );
        let mut navigated = response_probe(3, false, 1, "ready");
        navigated.url = "https://chatgpt.com/c/different-conversation".to_string();
        navigated.conversation_id = "conversation:different-conversation".to_string();
        assert_eq!(
            url.observe(navigated),
            ResponseTrackerDecision::Unknown(ResponseFailureCode::PageUrlChanged)
        );

        let mut new_chat = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);
        let mut home_shell = response_probe(3, false, 0, "assistant-shell");
        home_shell.url = "https://chatgpt.com/".to_string();
        home_shell.conversation_id = "home:https://chatgpt.com".to_string();
        assert_eq!(
            new_chat.observe(home_shell),
            ResponseTrackerDecision::Pending
        );
        let mut conversation_shell = response_probe(3, false, 0, "assistant-shell");
        conversation_shell.url = "https://chatgpt.com/c/new-conversation".to_string();
        conversation_shell.conversation_id = "conversation:new-conversation".to_string();
        assert_eq!(
            new_chat.observe(conversation_shell),
            ResponseTrackerDecision::Pending
        );

        let mut web_chat = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);
        let mut web_shell = response_probe(3, false, 0, "assistant-shell");
        web_shell.conversation_id = "conversation:WEB:temporary".to_string();
        assert_eq!(
            web_chat.observe(web_shell),
            ResponseTrackerDecision::Pending
        );
        let mut uuid_shell = response_probe(3, false, 0, "assistant-shell");
        uuid_shell.conversation_id = "conversation:canonical-uuid".to_string();
        assert_eq!(
            web_chat.observe(uuid_shell),
            ResponseTrackerDecision::Pending
        );

        let mut regenerated = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);
        assert_eq!(
            regenerated.observe(response_probe(3, false, 0, "assistant-shell")),
            ResponseTrackerDecision::Pending
        );
        assert_eq!(
            regenerated.observe(response_probe(3, true, 0, "manual-regeneration")),
            ResponseTrackerDecision::Pending
        );

        let mut remounted_stop = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);
        assert_eq!(
            remounted_stop.observe(response_probe(3, false, 0, "assistant-shell")),
            ResponseTrackerDecision::Pending
        );
        assert_eq!(
            remounted_stop.observe(response_probe(3, true, 0, "assistant-shell")),
            ResponseTrackerDecision::Pending
        );
        assert_eq!(
            remounted_stop.observe(response_probe(3, false, 1, "image-v1")),
            ResponseTrackerDecision::Pending
        );

        let mut timeout = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);
        assert_eq!(
            timeout.timeout(),
            ResponseTrackerDecision::Unknown(ResponseFailureCode::ResponseTimeout)
        );
    }

    #[test]
    fn response_completion_uses_semantic_turn_and_artifact_identity() {
        let mut tracker = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);
        let mut shell = response_probe(3, false, 0, "shell");
        shell.turn_id = "turn-1".to_string();
        assert_eq!(tracker.observe(shell), ResponseTrackerDecision::Pending);

        let mut remounted_stop = response_probe(3, true, 0, "shell-mutated");
        remounted_stop.turn_id = "turn-1".to_string();
        assert_eq!(
            tracker.observe(remounted_stop),
            ResponseTrackerDecision::Pending
        );

        // During active generation the DOM legitimately evolves: turn_id
        // and artifact_ids change as the image artifact is created.  This
        // must be Pending, not a terminal ResponseIdentityChanged.
        let mut generating_evolved = response_probe(3, true, 0, "shell-mutated-2");
        generating_evolved.turn_id = "turn-2".to_string();
        generating_evolved.artifact_ids = vec!["image-artifact-1".to_string()];
        assert_eq!(
            tracker.observe(generating_evolved),
            ResponseTrackerDecision::Pending
        );

        let mut image = response_probe(3, false, 1, "image-v1");
        image.turn_id = "turn-2".to_string();
        image.artifact_ids = vec!["image-artifact-1".to_string()];
        assert_eq!(
            tracker.observe(image.clone()),
            ResponseTrackerDecision::Pending
        );
        assert_eq!(
            tracker.observe(image.clone()),
            ResponseTrackerDecision::Pending
        );
        assert!(matches!(
            tracker.observe(image),
            ResponseTrackerDecision::Completed(_)
        ));

        let mut changed_turn = response_probe(3, false, 1, "image-v2");
        changed_turn.turn_id = "turn-2".to_string();
        changed_turn.artifact_ids = vec!["image-artifact-2".to_string()];
        let mut identity_tracker = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);
        let mut first = response_probe(3, false, 1, "image-v1");
        first.turn_id = "turn-1".to_string();
        first.artifact_ids = vec!["image-artifact-1".to_string()];
        assert_eq!(
            identity_tracker.observe(first),
            ResponseTrackerDecision::Pending
        );
        assert_eq!(
            identity_tracker.observe(changed_turn),
            ResponseTrackerDecision::Unknown(ResponseFailureCode::ResponseIdentityChanged)
        );
    }

    #[test]
    fn generation_allows_turn_and_artifact_evolution() {
        // Regression: ChatGPT was still generating an image (Stop button
        // visible) when turn_id / artifact_ids evolved.  The tracker must
        // treat this as Pending, not a terminal ResponseIdentityChanged.
        let mut tracker = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);

        // Assistant shell appears with turn-1, no generation yet.
        let mut shell = response_probe(3, false, 0, "shell");
        shell.turn_id = "turn-1".to_string();
        assert_eq!(tracker.observe(shell), ResponseTrackerDecision::Pending);

        // Generation starts; turn_id stays the same.
        let mut generating = response_probe(3, true, 0, "shell-generating");
        generating.turn_id = "turn-1".to_string();
        assert_eq!(
            tracker.observe(generating),
            ResponseTrackerDecision::Pending
        );

        // During generation, turn_id changes to turn-2 and an artifact appears.
        // This is legitimate DOM evolution during image generation.
        let mut evolved = response_probe(3, true, 0, "shell-evolved");
        evolved.turn_id = "turn-2".to_string();
        evolved.artifact_ids = vec!["image-artifact-1".to_string()];
        assert_eq!(tracker.observe(evolved), ResponseTrackerDecision::Pending);

        // Generation continues; artifact_ids grow (second image element).
        let mut more_artifacts = response_probe(3, true, 0, "shell-more-artifacts");
        more_artifacts.turn_id = "turn-2".to_string();
        more_artifacts.artifact_ids = vec![
            "image-artifact-1".to_string(),
            "image-artifact-2".to_string(),
        ];
        assert_eq!(
            tracker.observe(more_artifacts),
            ResponseTrackerDecision::Pending
        );

        // Generation stops; the loaded image is now present with the latest
        // identity.  Stability window must accumulate before Completed.
        let mut image_ready = response_probe(3, false, 1, "image-final");
        image_ready.turn_id = "turn-2".to_string();
        image_ready.artifact_ids = vec![
            "image-artifact-1".to_string(),
            "image-artifact-2".to_string(),
        ];
        assert_eq!(
            tracker.observe(image_ready.clone()),
            ResponseTrackerDecision::Pending
        );
        assert_eq!(
            tracker.observe(image_ready.clone()),
            ResponseTrackerDecision::Pending
        );
        assert!(matches!(
            tracker.observe(image_ready),
            ResponseTrackerDecision::Completed(_)
        ));
    }

    #[test]
    fn post_generation_dom_re_render_does_not_fail_as_identity_change() {
        // Regression (S08): ChatGPT re-renders the response DOM when
        // generation finishes (Stop disappears).  turn_id and/or
        // artifact_ids can change at this transition.  The tracker must
        // absorb the one-time post-generation identity evolution instead
        // of declaring ResponseIdentityChanged, because the image is
        // already present and the response is legitimately complete.
        let mut tracker = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);

        // Assistant shell with no image, no Stop.
        let mut shell = response_probe(3, false, 0, "shell");
        shell.turn_id = "turn-gen-1".to_string();
        assert_eq!(tracker.observe(shell), ResponseTrackerDecision::Pending);

        // Generation starts; Stop visible, image being created.
        let mut generating = response_probe(3, true, 0, "generating");
        generating.turn_id = "turn-gen-1".to_string();
        generating.artifact_ids = vec!["img-partial".to_string()];
        assert_eq!(
            tracker.observe(generating),
            ResponseTrackerDecision::Pending
        );

        // Generation finishes: Stop disappears, DOM re-renders with a new
        // turn_id and finalised artifact_ids, and the image is now loaded.
        let mut done = response_probe(3, false, 1, "image-final");
        done.turn_id = "turn-done-2".to_string();
        done.artifact_ids = vec!["img-final".to_string()];
        // This must NOT be ResponseIdentityChanged — it should be Pending
        // (first stability probe after the post-generation transition).
        assert_eq!(
            tracker.observe(done.clone()),
            ResponseTrackerDecision::Pending
        );
        assert_eq!(
            tracker.observe(done.clone()),
            ResponseTrackerDecision::Pending
        );
        assert!(matches!(
            tracker.observe(done),
            ResponseTrackerDecision::Completed(_)
        ));
    }

    #[test]
    fn post_generation_identity_change_after_stable_is_still_caught() {
        // After the post-generation transition absorbs one identity change,
        // subsequent identity changes must still be caught as
        // ResponseIdentityChanged.
        let mut tracker = ResponseCompletionTracker::new(ExpectedOutputType::Image, 0, 2);

        let mut generating = response_probe(3, true, 0, "generating");
        generating.turn_id = "turn-A".to_string();
        generating.artifact_ids = vec!["img-A".to_string()];
        assert_eq!(
            tracker.observe(generating),
            ResponseTrackerDecision::Pending
        );

        // Post-generation transition: identity changes to turn-B.
        let mut done = response_probe(3, false, 1, "image-final");
        done.turn_id = "turn-B".to_string();
        done.artifact_ids = vec!["img-B".to_string()];
        assert_eq!(
            tracker.observe(done.clone()),
            ResponseTrackerDecision::Pending
        );

        // A further identity change (turn-C) is still caught.
        let mut changed = response_probe(3, false, 1, "image-v2");
        changed.turn_id = "turn-C".to_string();
        changed.artifact_ids = vec!["img-C".to_string()];
        assert_eq!(
            tracker.observe(changed),
            ResponseTrackerDecision::Unknown(ResponseFailureCode::ResponseIdentityChanged)
        );
    }

    #[test]
    fn strict_image_download_rejects_zero_and_download_errors() {
        assert_eq!(
            enforce_download_contract(ExpectedOutputType::Image, Ok(2)).unwrap(),
            2
        );
        assert_eq!(
            enforce_download_contract(ExpectedOutputType::Image, Ok(0)).unwrap_err(),
            ResponseFailureCode::ImageDownloadEmpty
        );
        assert_eq!(
            enforce_download_contract(
                ExpectedOutputType::Image,
                Err(ImageDownloadError::DownloadFailed(
                    "PRIVATE DOWNLOAD DETAILS".to_string()
                ))
            )
            .unwrap_err(),
            ResponseFailureCode::ImageDownloadFailed
        );
    }

    #[test]
    fn response_receipt_fields_are_additive_and_low_sensitivity() {
        let root = make_test_dir("response_receipt_privacy");
        let path = root.join("receipt.json");
        let canary = "PRIVATE-PROMPT-URL-FILENAME-DOM";
        write_private_json(
            &path,
            &SessionReceipt::new_for_output(0, 0, ExpectedOutputType::Image),
        )
        .unwrap();
        record_session_receipt_event(&path, SessionReceiptEvent::AttachmentsVerified).unwrap();
        record_session_receipt_event(&path, SessionReceiptEvent::PromptIntentRecorded).unwrap();
        record_session_receipt_event(&path, SessionReceiptEvent::PromptSubmitted).unwrap();
        record_session_response_outcome(
            &path,
            ResponseCompletion::Unknown,
            0,
            Some(ResponseFailureCode::ResponseTimeout),
        )
        .unwrap();

        let receipt = read_session_receipt(&path).unwrap();
        assert_eq!(receipt.expected_output_type, ExpectedOutputType::Image);
        assert_eq!(receipt.response_completion, ResponseCompletion::Unknown);
        assert_eq!(receipt.downloaded_image_count, 0);
        assert_eq!(
            receipt.response_failure_code,
            Some(ResponseFailureCode::ResponseTimeout)
        );
        let json = std::fs::read_to_string(&path).unwrap();
        assert!(!json.contains(canary));
        for forbidden in ["prompt", "response_content", "url", "file_name", "dom"] {
            assert!(!json.contains(&format!("\"{forbidden}\"")));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pre_submit_interference_stays_safe_but_post_submit_interference_is_unknown() {
        let safe_root = make_test_dir("pre_submit_interference");
        let safe_path = safe_root.join("receipt.json");
        write_private_json(&safe_path, &SessionReceipt::new(0, 0)).unwrap();
        let submit_count = std::cell::Cell::new(0);
        let result = execute_verified_prompt_submission(
            Some(&safe_path),
            || Ok(()),
            || Err::<usize, _>("owned page changed before submit".to_string()),
            || {
                submit_count.set(submit_count.get() + 1);
                Ok("submitted".to_string())
            },
        );
        assert!(result.is_err());
        assert_eq!(submit_count.get(), 0);
        let safe = read_session_receipt(&safe_path).unwrap();
        assert_eq!(safe.prompt_submission, PromptSubmission::NotStarted);
        assert_eq!(safe.response_completion, ResponseCompletion::Pending);

        let unknown_root = make_test_dir("post_submit_interference");
        let unknown_path = unknown_root.join("receipt.json");
        write_private_json(
            &unknown_path,
            &SessionReceipt::new_for_output(0, 0, ExpectedOutputType::Image),
        )
        .unwrap();
        let submitted = execute_verified_prompt_submission(
            Some(&unknown_path),
            || Ok(()),
            || Ok(2usize),
            || Ok("submitted".to_string()),
        )
        .unwrap();
        assert_eq!(submitted.0, 2);
        record_session_response_outcome(
            &unknown_path,
            ResponseCompletion::Unknown,
            0,
            Some(ResponseFailureCode::PageOwnershipChanged),
        )
        .unwrap();
        let unknown = read_session_receipt(&unknown_path).unwrap();
        assert_eq!(unknown.prompt_submission, PromptSubmission::Submitted);
        assert_eq!(unknown.response_completion, ResponseCompletion::Unknown);

        std::fs::remove_dir_all(safe_root).unwrap();
        std::fs::remove_dir_all(unknown_root).unwrap();
    }

    #[test]
    fn response_probe_contract_checks_token_controls_large_images_and_dom_signature() {
        let baseline = ResponseBaseline {
            initial_user_count: 2,
            initial_assistant_count: 3,
            ownership_token: "00000000-0000-4000-8000-000000000003".to_string(),
        };
        let script = build_response_probe_script(Provider::ChatGpt, &baseline).unwrap();
        assert!(script.contains("__ask_bridge_response_owner_v1"));
        assert!(script.contains("generation_control_visible"));
        assert!(script.contains("user_count"));
        assert!(script.contains("img.complete"));
        assert!(script.contains("const minimumImageDimension = 256"));
        assert!(script.contains("naturalWidth < minimumImageDimension"));
        assert!(script.contains("naturalHeight < minimumImageDimension"));
        assert!(script.contains("dom_signature"));
        assert!(script.contains("provider_failure_visible"));
        assert!(script.contains("conversation_id"));
        assert!(script.contains("turn_id"));
        assert!(script.contains("artifact_ids"));
        assert!(script.contains("window.location.origin"));
        assert!(!script.contains("__TOKEN__"));
        assert!(!script.contains("__ASSISTANT_SELECTOR__"));
        assert!(!script.contains("__USER_SELECTOR__"));
    }

    #[test]
    fn legacy_schema_v2_receipt_defaults_new_response_fields() {
        let root = make_test_dir("legacy_response_receipt");
        let path = root.join("receipt.json");
        let legacy = serde_json::json!({
            "schema_version": 2,
            "capability": ISOLATED_NEW_TAB_CAPABILITY,
            "capabilities": [ISOLATED_NEW_TAB_CAPABILITY, VERIFIED_FILE_UPLOAD_CAPABILITY],
            "attachment_verification": "verified",
            "attachment_count": 1,
            "attachment_total_bytes": 123,
            "prompt_submission": "submitted",
            "failure_code": null
        });
        write_private_json(&path, &legacy).unwrap();
        let receipt = read_session_receipt(&path).unwrap();
        assert_eq!(receipt.expected_output_type, ExpectedOutputType::Text);
        assert_eq!(receipt.response_completion, ResponseCompletion::Pending);
        assert_eq!(receipt.downloaded_image_count, 0);
        assert_eq!(receipt.response_failure_code, None);
        assert_eq!(receipt.model_selection, ModelSelection::NotRequested);
        assert_eq!(receipt.model_selection_contract, None);
        assert_eq!(receipt.model_selection_evidence, None);
        assert_eq!(receipt.failure_stage, None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn model_selection_receipt_records_verified_and_failed_states() {
        let verified_root = make_test_dir("model_selection_verified");
        let verified_path = verified_root.join("receipt.json");
        write_private_json(&verified_path, &SessionReceipt::new(0, 0)).unwrap();
        record_model_selection_verified(
            &verified_path,
            ModelSelectionOutcome {
                contract: ModelSelectionContract::ReasoningSliderV1,
                evidence: ModelSelectionEvidence::BoundedOrdinalV1,
            },
        )
        .unwrap();
        let verified = read_session_receipt(&verified_path).unwrap();
        assert_eq!(verified.model_selection, ModelSelection::Verified);
        assert_eq!(
            verified.model_selection_contract,
            Some(ModelSelectionContract::ReasoningSliderV1)
        );
        assert_eq!(
            verified.model_selection_evidence,
            Some(ModelSelectionEvidence::BoundedOrdinalV1)
        );
        assert_eq!(verified.failure_stage, None);
        assert_eq!(verified.failure_code, None);

        let failed_root = make_test_dir("model_selection_failed");
        let failed_path = failed_root.join("receipt.json");
        write_private_json(&failed_path, &SessionReceipt::new(0, 0)).unwrap();
        record_model_selection_failed(&failed_path).unwrap();
        let failed = read_session_receipt(&failed_path).unwrap();
        assert_eq!(failed.model_selection, ModelSelection::Failed);
        assert_eq!(failed.model_selection_contract, None);
        assert_eq!(failed.model_selection_evidence, None);
        assert_eq!(
            failed.failure_stage.as_deref(),
            Some(MODEL_SELECTION_FAILURE_STAGE)
        );
        assert_eq!(
            failed.failure_code.as_deref(),
            Some(MODEL_SELECTION_FAILURE_CODE)
        );
        assert_eq!(failed.prompt_submission, PromptSubmission::NotStarted);

        std::fs::remove_dir_all(verified_root).unwrap();
        std::fs::remove_dir_all(failed_root).unwrap();
    }

    #[test]
    fn chatgpt_model_selection_scripts_declare_both_contracts_without_dom_payloads() {
        let source = include_str!("main.rs");
        let target_json = serde_json::to_string("即時").unwrap();
        let selection_script = build_chatgpt_model_selection_script(&target_json);
        assert!(selection_script.contains("data-model-reasoning-effort-slider"));
        assert!(selection_script.contains("aria-valuemin"));
        assert!(selection_script.contains("model radio selection was not verified"));
        assert!(selection_script.contains("legacy_menu_v1"));
        assert!(selection_script.contains("slider_ready"));
        assert!(selection_script.contains("state_owner_relation"));
        assert!(selection_script.contains("focus_owner_relation"));
        assert!(selection_script.contains("role_evidence"));
        assert!(selection_script.contains("state owner is ambiguous"));
        assert!(selection_script.contains("focus owner is ambiguous"));
        assert!(selection_script.contains("document.activeElement === focusOwner"));
        assert!(!selection_script.contains("outerHTML"));
        assert!(!selection_script.contains("__CONTROL_BUNDLE_RESOLVER__"));
        assert!(source.contains("previous.now - 1"));
        assert!(source.contains("previous.now + 1"));
        assert!(source.contains("reasoning slider reopen status"));

        let state_script = build_chatgpt_slider_state_script(&target_json);
        assert!(state_script.contains("aria-describedby"));
        assert!(state_script.contains("aria-valuenow"));
        assert!(state_script.contains("announcement_present"));
        assert!(state_script.contains("state_owner_relation"));
        assert!(!state_script.contains("__PROMPT__"));

        let reopen_script = build_chatgpt_reopen_slider_script();
        assert!(reopen_script.contains("state_owner_relation"));
        assert!(!reopen_script.contains("__CONTROL_BUNDLE_RESOLVER__"));
    }

    #[test]
    fn reasoning_effort_aliases_use_the_exact_three_position_mapping() {
        assert_eq!(
            ReasoningEffort::from_label("即時"),
            Some(ReasoningEffort::Instant)
        );
        assert_eq!(
            ReasoningEffort::from_label("selected fast"),
            Some(ReasoningEffort::Instant)
        );
        assert_eq!(
            ReasoningEffort::from_label("中等推理"),
            Some(ReasoningEffort::Medium)
        );
        assert_eq!(
            ReasoningEffort::from_label("HIGH"),
            Some(ReasoningEffort::High)
        );
        assert_eq!(ReasoningEffort::Instant.target_index(), 0);
        assert_eq!(ReasoningEffort::Medium.target_index(), 1);
        assert_eq!(ReasoningEffort::High.target_index(), 2);
        assert_eq!(ReasoningEffort::from_ordinal_index(3), None);
    }

    #[test]
    fn bounded_ordinal_state_requires_exact_profile_and_consistent_labels() {
        let valid = serde_json::json!({
            "found": true,
            "marker_present": true,
            "marker_count": 1,
            "role_slider": true,
            "role_evidence": "slider",
            "state_owner_relation": "marker",
            "focus_owner_relation": "state_owner",
            "min": 0,
            "max": 2,
            "now": 0,
            "matched": false,
            "announcement_present": true,
            "ordinal_present": true,
            "ordinal_current": 1,
            "ordinal_total": 3,
            "ordinal_consistent": true,
            "semantic_effort": null,
            "semantic_conflict": false,
            "focused": true
        });
        let state = parse_chatgpt_slider_state(&valid).unwrap();
        state.validate_bounded_ordinal().unwrap();
        assert!(state.requires_bounded_ordinal());

        let mut marked_without_ordinal = valid.clone();
        marked_without_ordinal["ordinal_present"] = serde_json::json!(false);
        marked_without_ordinal["ordinal_current"] = serde_json::Value::Null;
        marked_without_ordinal["ordinal_total"] = serde_json::Value::Null;
        marked_without_ordinal["announcement_present"] = serde_json::json!(false);
        let marked_without_ordinal = parse_chatgpt_slider_state(&marked_without_ordinal).unwrap();
        assert!(marked_without_ordinal.requires_bounded_ordinal());
        assert!(marked_without_ordinal.validate_bounded_ordinal().is_err());

        let mut contradictory = valid.clone();
        contradictory["semantic_effort"] = serde_json::json!("high");
        assert!(
            parse_chatgpt_slider_state(&contradictory)
                .unwrap()
                .validate_bounded_ordinal()
                .is_err()
        );

        let mut semantic_conflict = valid.clone();
        semantic_conflict["semantic_conflict"] = serde_json::json!(true);
        assert!(
            parse_chatgpt_slider_state(&semantic_conflict)
                .unwrap()
                .validate_bounded_ordinal()
                .is_err()
        );

        let mut ordinal_mismatch = valid.clone();
        ordinal_mismatch["ordinal_current"] = serde_json::json!(2);
        assert!(
            parse_chatgpt_slider_state(&ordinal_mismatch)
                .unwrap()
                .validate_bounded_ordinal()
                .is_err()
        );

        let mut focus_failure = valid.clone();
        focus_failure["focused"] = serde_json::json!(false);
        assert!(parse_chatgpt_slider_state(&focus_failure).is_err());

        let mut unknown_cardinality = valid;
        unknown_cardinality["ordinal_total"] = serde_json::json!(4);
        assert!(
            parse_chatgpt_slider_state(&unknown_cardinality)
                .unwrap()
                .validate_bounded_ordinal()
                .is_err()
        );
    }

    #[test]
    fn resolved_bounded_ordinal_accepts_roleless_and_split_owner_profiles() {
        let roleless = serde_json::json!({
            "found": true,
            "marker_present": true,
            "marker_count": 1,
            "role_evidence": "missing",
            "state_owner_relation": "marker",
            "focus_owner_relation": "state_owner",
            "min": 0,
            "max": 2,
            "now": 0,
            "matched": false,
            "announcement_present": true,
            "ordinal_present": true,
            "ordinal_current": 1,
            "ordinal_total": 3,
            "ordinal_consistent": true,
            "semantic_effort": null,
            "semantic_conflict": false,
            "focused": true
        });
        let roleless_state = parse_chatgpt_slider_state(&roleless).unwrap();
        roleless_state.validate_bounded_ordinal().unwrap();
        assert_eq!(
            roleless_state.model_selection_evidence(),
            ModelSelectionEvidence::ResolvedBoundedOrdinalV2
        );

        let mut split_owner = roleless.clone();
        split_owner["state_owner_relation"] = serde_json::json!("descendant");
        split_owner["role_evidence"] = serde_json::json!("native_range");
        let split_state = parse_chatgpt_slider_state(&split_owner).unwrap();
        split_state.validate_bounded_ordinal().unwrap();
        assert_eq!(
            split_state.model_selection_evidence(),
            ModelSelectionEvidence::ResolvedBoundedOrdinalV2
        );
        assert!(!roleless_state.same_observable_state(split_state));

        let mut exact_role = roleless.clone();
        exact_role["role_evidence"] = serde_json::json!("slider");
        let exact_state = parse_chatgpt_slider_state(&exact_role).unwrap();
        exact_state.validate_bounded_ordinal().unwrap();
        assert_eq!(
            exact_state.model_selection_evidence(),
            ModelSelectionEvidence::BoundedOrdinalV1
        );

        let mut conflicting_role = roleless.clone();
        conflicting_role["role_evidence"] = serde_json::json!("conflict");
        assert!(
            parse_chatgpt_slider_state(&conflicting_role)
                .unwrap()
                .validate_bounded_ordinal()
                .is_err()
        );

        let mut ambiguous_marker = roleless.clone();
        ambiguous_marker["marker_count"] = serde_json::json!(2);
        assert!(
            parse_chatgpt_slider_state(&ambiguous_marker)
                .unwrap()
                .validate_bounded_ordinal()
                .is_err()
        );

        let mut invalid_relation = roleless;
        invalid_relation["state_owner_relation"] = serde_json::json!("ancestor");
        assert!(parse_chatgpt_slider_state(&invalid_relation).is_err());
    }

    #[test]
    fn chatgpt_slider_state_parser_rejects_invalid_or_unverified_state() {
        let invalid = serde_json::json!({
            "found": true,
            "min": 0,
            "max": 2,
            "now": 3,
            "matched": true,
            "announcement_present": true
        });
        assert!(parse_chatgpt_slider_state(&invalid).is_err());

        let valid_unmatched = serde_json::json!({
            "found": true,
            "min": 0,
            "max": 2,
            "now": 1,
            "matched": false,
            "announcement_present": true,
            "marker_present": false,
            "marker_count": 0,
            "role_evidence": "missing",
            "state_owner_relation": null,
            "focus_owner_relation": "state_owner",
            "focused": true
        });
        let state = parse_chatgpt_slider_state(&valid_unmatched).unwrap();
        assert_eq!(state.now, 1);
        assert!(!state.matched);
    }

    #[test]
    fn private_session_receipt_is_atomic_and_mode_600_on_unix() {
        let root = std::env::temp_dir().join(format!("ask-bridge-test-{}", Uuid::new_v4()));
        let path = root.join("sessions").join("receipt.json");
        let receipt = SessionReceipt::new(2, 57_081);
        write_private_json(&path, &receipt).unwrap();
        let persisted: SessionReceipt =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted, receipt);
        assert_eq!(persisted.schema_version, 2);
        assert_eq!(
            persisted.attachment_verification,
            AttachmentVerification::Pending
        );
        assert_eq!(persisted.prompt_submission, PromptSubmission::NotStarted);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn receipt_lifecycle_is_auditable_without_sensitive_values() {
        let root = make_test_dir("receipt_lifecycle");
        let path = root.join("receipt.json");
        let canary = "PRIVATE-PROMPT-BASE64-FILENAME-ACCOUNT";
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join(format!("{canary}.md"));
        std::fs::write(&source, canary.as_bytes()).unwrap();
        let summary = summarize_attachments(&[], &[source.to_string_lossy().to_string()]).unwrap();
        write_private_json(
            &path,
            &SessionReceipt::new(summary.count(), summary.total_bytes),
        )
        .unwrap();

        record_session_receipt_event(&path, SessionReceiptEvent::AttachmentsVerified).unwrap();
        record_session_receipt_event(&path, SessionReceiptEvent::PromptIntentRecorded).unwrap();
        let crash_receipt = read_session_receipt(&path).unwrap();
        assert_eq!(
            crash_receipt.prompt_submission,
            PromptSubmission::IntentRecorded
        );
        assert_eq!(
            crash_receipt.attachment_verification,
            AttachmentVerification::Verified
        );

        record_session_receipt_event(&path, SessionReceiptEvent::PromptSubmitted).unwrap();
        let submitted = read_session_receipt(&path).unwrap();
        assert_eq!(submitted.prompt_submission, PromptSubmission::Submitted);
        let serialized = std::fs::read_to_string(&path).unwrap();
        assert!(!serialized.contains(canary));
        let object = serde_json::from_str::<Value>(&serialized)
            .unwrap()
            .as_object()
            .unwrap()
            .clone();
        for forbidden_key in [
            "prompt",
            "content",
            "base64",
            "path",
            "file_name",
            "account",
            "provider",
            "owned_page_id",
            "pid",
        ] {
            assert!(
                !object.contains_key(forbidden_key),
                "receipt leaked forbidden key {forbidden_key}"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn private_json_rejects_symlink_destination_and_parent() {
        use std::os::unix::fs::symlink;

        let root = make_test_dir("private_json_symlink");
        let real = root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let victim = root.join("victim.json");
        std::fs::write(&victim, b"unchanged").unwrap();
        let destination = real.join("receipt.json");
        symlink(&victim, &destination).unwrap();
        assert!(write_private_json(&destination, &SessionReceipt::new(0, 0)).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"unchanged");

        let linked_parent = root.join("linked");
        symlink(&real, &linked_parent).unwrap();
        assert!(
            write_private_json(
                &linked_parent.join("other.json"),
                &SessionReceipt::new(0, 0)
            )
            .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn attachment_probe_requires_two_stable_complete_observations() {
        let pending = AttachmentProbe {
            expected_count: 2,
            observed_count: 1,
            missing_count: 1,
            unexpected_count: 0,
            uploading: true,
            has_error: false,
            complete: false,
        };
        let complete = AttachmentProbe {
            expected_count: 2,
            observed_count: 2,
            missing_count: 0,
            unexpected_count: 0,
            uploading: false,
            has_error: false,
            complete: true,
        };
        let mut tracker = AttachmentVerificationTracker::new(2);
        assert!(!tracker.observe(pending).unwrap());
        assert!(!tracker.observe(complete.clone()).unwrap());
        assert!(tracker.observe(complete).unwrap());
        assert_eq!(ATTACHMENT_VERIFY_POLL_INTERVAL, Duration::from_millis(500));
        assert_eq!(ATTACHMENT_VERIFY_TIMEOUT, Duration::from_secs(60));
        assert_eq!(ATTACHMENT_REQUIRED_STABLE_PROBES, 2);
    }

    #[test]
    fn attachment_probe_fails_closed_on_error_or_wrong_multiset() {
        let mut tracker = AttachmentVerificationTracker::new(2);
        let error = AttachmentProbe {
            expected_count: 2,
            observed_count: 1,
            missing_count: 1,
            unexpected_count: 0,
            uploading: false,
            has_error: true,
            complete: false,
        };
        assert!(tracker.observe(error).is_err());

        let wrong_multiset = AttachmentProbe {
            expected_count: 2,
            observed_count: 3,
            missing_count: 0,
            unexpected_count: 1,
            uploading: false,
            has_error: false,
            complete: false,
        };
        assert!(!tracker.observe(wrong_multiset).unwrap());
    }

    #[test]
    fn mcp_connect_and_tool_share_one_deterministic_deadline() {
        let started_at = Instant::now();
        let deadline =
            McpOperationDeadline::from_start(started_at, Duration::from_millis(100)).unwrap();

        assert_eq!(
            deadline
                .phase_timeout_at(started_at, MCP_CONNECT_TIMEOUT, "connect")
                .unwrap(),
            Duration::from_millis(100)
        );
        assert_eq!(
            deadline
                .phase_timeout_at(
                    started_at + Duration::from_millis(70),
                    MCP_CALL_TIMEOUT,
                    "tool",
                )
                .unwrap(),
            Duration::from_millis(30)
        );
        let exhausted = deadline
            .phase_timeout_at(
                started_at + Duration::from_millis(100),
                MCP_CALL_TIMEOUT,
                "tool",
            )
            .unwrap_err();
        assert!(exhausted.contains("deadline exhausted"));
    }

    #[test]
    fn attachment_dom_probe_uses_filename_multiset_and_structured_states() {
        let script =
            build_attachment_probe_script(Provider::ChatGpt, &["same.md".into(), "same.md".into()])
                .unwrap();
        assert!(script.contains("expectedNames"));
        assert!(script.contains("missing_count"));
        assert!(script.contains("unexpected_count"));
        assert!(script.contains("uploading"));
        assert!(script.contains("has_error"));
        assert!(script.contains("same.md"));
    }

    #[test]
    fn native_upload_success_skips_fallback_and_failure_uses_it_once() {
        let calls = std::cell::RefCell::new(Vec::new());
        run_native_then_fallback(
            || {
                calls.borrow_mut().push("native");
                Ok(())
            },
            || {
                calls.borrow_mut().push("fallback");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*calls.borrow(), vec!["native"]);

        calls.borrow_mut().clear();
        run_native_then_fallback(
            || {
                calls.borrow_mut().push("native");
                Err("native unavailable".to_string())
            },
            || {
                calls.borrow_mut().push("fallback");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*calls.borrow(), vec!["native", "fallback"]);
    }

    #[test]
    fn chatgpt_document_policy_is_native_first_with_data_transfer_only_as_fallback() {
        assert_eq!(
            document_upload_policy(Provider::ChatGpt),
            DocumentUploadPolicy::NativeThenDataTransferFallback
        );
    }

    #[test]
    fn attachment_failure_keeps_prompt_not_started_and_never_submits() {
        let root = make_test_dir("attachment_fail_gate");
        let path = root.join("receipt.json");
        write_private_json(&path, &SessionReceipt::new(1, 123)).unwrap();
        let submit_count = std::cell::Cell::new(0);
        let result = execute_verified_prompt_submission(
            Some(&path),
            || Err("upload did not stabilize".to_string()),
            || Ok(7usize),
            || {
                submit_count.set(submit_count.get() + 1);
                Ok("submitted".to_string())
            },
        );
        assert!(result.is_err());
        assert_eq!(submit_count.get(), 0);
        let receipt = read_session_receipt(&path).unwrap();
        assert_eq!(
            receipt.attachment_verification,
            AttachmentVerification::Failed
        );
        assert_eq!(receipt.prompt_submission, PromptSubmission::NotStarted);
        assert_eq!(
            receipt.failure_code.as_deref(),
            Some(ATTACHMENT_VERIFICATION_FAILURE_CODE)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uploading_missing_error_and_timeout_gates_never_submit() {
        let not_verified = |probe: AttachmentProbe| {
            let mut tracker = AttachmentVerificationTracker::new(2);
            match tracker.observe(probe) {
                Ok(true) => Ok(()),
                Ok(false) | Err(_) => Err(ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string()),
            }
        };
        let uploading = not_verified(AttachmentProbe {
            expected_count: 2,
            observed_count: 2,
            missing_count: 0,
            unexpected_count: 0,
            uploading: true,
            has_error: false,
            complete: false,
        });
        let missing = not_verified(AttachmentProbe {
            expected_count: 2,
            observed_count: 1,
            missing_count: 1,
            unexpected_count: 0,
            uploading: false,
            has_error: false,
            complete: false,
        });
        let upload_error = not_verified(AttachmentProbe {
            expected_count: 2,
            observed_count: 1,
            missing_count: 1,
            unexpected_count: 0,
            uploading: false,
            has_error: true,
            complete: false,
        });
        let started_at = Instant::now();
        let deadline =
            McpOperationDeadline::from_start(started_at, Duration::from_millis(10)).unwrap();
        let timeout = deadline
            .phase_timeout_at(
                started_at + Duration::from_millis(10),
                MCP_CALL_TIMEOUT,
                "attachment verification",
            )
            .map(|_| ());

        for (case, gate_result) in [
            ("uploading", uploading),
            ("missing", missing),
            ("error", upload_error),
            ("timeout", timeout),
        ] {
            let root = make_test_dir(&format!("attachment_{case}_gate"));
            let path = root.join("receipt.json");
            write_private_json(&path, &SessionReceipt::new(2, 123)).unwrap();
            let submit_count = std::cell::Cell::new(0);
            let result = execute_verified_prompt_submission(
                Some(&path),
                || gate_result,
                || Ok(0usize),
                || {
                    submit_count.set(submit_count.get() + 1);
                    Ok("submitted".to_string())
                },
            );

            assert!(result.is_err(), "{case} must fail closed");
            assert_eq!(submit_count.get(), 0, "{case} must never submit");
            let receipt = read_session_receipt(&path).unwrap();
            assert_eq!(
                receipt.attachment_verification,
                AttachmentVerification::Failed,
                "{case}"
            );
            assert_eq!(
                receipt.prompt_submission,
                PromptSubmission::NotStarted,
                "{case}"
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn typed_attachment_tracker_verifies_documents_and_images() {
        let expectations = AttachmentExpectations::new(
            &["report.md".to_string(), "plan.json".to_string()],
            &["style.png".to_string()],
        )
        .unwrap();
        assert_eq!(expectations.document_names.len(), 2);
        assert_eq!(expectations.image_count, 1);

        let mut tracker = TypedAttachmentTracker::new(&expectations);

        // Uploading → not ready.
        assert!(
            !tracker
                .observe(
                    &TypedAttachmentProbe {
                        document_count: 2,
                        image_count: 1,
                        image_loaded: true,
                        uploading: true,
                        provider_error: false,
                    },
                    &expectations,
                )
                .unwrap()
        );

        // First stable probe → not enough (need 2).
        assert!(
            !tracker
                .observe(
                    &TypedAttachmentProbe {
                        document_count: 2,
                        image_count: 1,
                        image_loaded: true,
                        uploading: false,
                        provider_error: false,
                    },
                    &expectations,
                )
                .unwrap()
        );

        // Second stable probe → verified.
        assert!(
            tracker
                .observe(
                    &TypedAttachmentProbe {
                        document_count: 2,
                        image_count: 1,
                        image_loaded: true,
                        uploading: false,
                        provider_error: false,
                    },
                    &expectations,
                )
                .unwrap()
        );

        // Missing image → not ready.
        let mut tracker2 = TypedAttachmentTracker::new(&expectations);
        assert!(
            !tracker2
                .observe(
                    &TypedAttachmentProbe {
                        document_count: 2,
                        image_count: 0,
                        image_loaded: false,
                        uploading: false,
                        provider_error: false,
                    },
                    &expectations,
                )
                .unwrap()
        );

        // Provider error → Err.
        let mut tracker3 = TypedAttachmentTracker::new(&expectations);
        let result = tracker3.observe(
            &TypedAttachmentProbe {
                document_count: 2,
                image_count: 1,
                image_loaded: true,
                uploading: false,
                provider_error: true,
            },
            &expectations,
        );
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "provider_error");
    }

    #[test]
    fn attachment_probe_summary_has_no_sensitive_fields() {
        let expectations =
            AttachmentExpectations::new(&["report.md".to_string()], &["style.png".to_string()])
                .unwrap();
        let probe = TypedAttachmentProbe {
            document_count: 1,
            image_count: 1,
            image_loaded: true,
            uploading: false,
            provider_error: false,
        };
        let summary = AttachmentProbeSummary::new(&expectations, &probe);
        let json = serde_json::to_string(&summary).unwrap();
        assert!(json.contains("typed_mixed_v1"));
        assert!(json.contains("\"expected_documents\":1"));
        assert!(json.contains("\"expected_images\":1"));
        // No filenames, paths, DOM text or prompts.
        assert!(!json.contains("report.md"));
        assert!(!json.contains("style.png"));
        assert!(!json.contains("/"));
    }

    #[test]
    fn receipt_state_transitions_preserve_additive_attachment_probe() {
        let root = make_test_dir("preserve_attachment_probe");
        let path = root.join("receipt.json");
        write_private_json(
            &path,
            &SessionReceipt::new_for_output(2, 42, ExpectedOutputType::Image),
        )
        .unwrap();
        let expectations =
            AttachmentExpectations::new(&["source.md".to_string()], &["anchor.png".to_string()])
                .unwrap();
        let probe = TypedAttachmentProbe {
            document_count: 1,
            image_count: 1,
            image_loaded: true,
            uploading: false,
            provider_error: false,
        };
        write_attachment_probe_receipt(&path, &AttachmentProbeSummary::new(&expectations, &probe))
            .unwrap();
        record_session_receipt_event(&path, SessionReceiptEvent::AttachmentsVerified).unwrap();
        record_session_receipt_event(&path, SessionReceiptEvent::PromptIntentRecorded).unwrap();
        record_session_receipt_event(&path, SessionReceiptEvent::PromptSubmitted).unwrap();
        record_session_response_outcome(&path, ResponseCompletion::Completed, 1, None).unwrap();

        let json: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            json["attachment_probe"]["expected_documents"].as_u64(),
            Some(1)
        );
        assert_eq!(json["downloaded_image_count"].as_u64(), Some(1));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verify_attachments_only_flag_parses() {
        let cli = Cli::try_parse_from([
            "ask-bridge",
            "--provider",
            "chatgpt",
            "--new-tab-preserve-existing",
            "--session-id",
            "00000000-0000-4000-8000-000000000001",
            "--file",
            "report.md",
            "--image",
            "style.png",
            "--verify-attachments-only",
            "placeholder",
        ])
        .unwrap();
        assert!(cli.verify_attachments_only);
        assert_eq!(cli.files, vec!["report.md".to_string()]);
        assert_eq!(cli.images, vec!["style.png".to_string()]);
    }

    #[test]
    fn submit_failure_after_durable_intent_remains_unknown() {
        let root = make_test_dir("submit_intent_gate");
        let path = root.join("receipt.json");
        write_private_json(&path, &SessionReceipt::new(0, 0)).unwrap();
        let result = execute_verified_prompt_submission(
            Some(&path),
            || Ok(()),
            || Ok(0usize),
            || Err("browser submit state unknown".to_string()),
        );
        assert!(result.is_err());
        let receipt = read_session_receipt(&path).unwrap();
        assert_eq!(
            receipt.attachment_verification,
            AttachmentVerification::Verified
        );
        assert_eq!(receipt.prompt_submission, PromptSubmission::IntentRecorded);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn provider_lease_is_exclusive_and_private() {
        let root = std::env::temp_dir().join(format!("ask-bridge-lease-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("chatgpt.lease");
        let first = acquire_provider_lease_at(
            &path,
            Provider::ChatGpt,
            "00000000-0000-4000-8000-000000000001",
        )
        .unwrap();
        assert!(
            acquire_provider_lease_at(
                &path,
                Provider::ChatGpt,
                "00000000-0000-4000-8000-000000000002",
            )
            .is_err()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(first);
        let second = acquire_provider_lease_at(
            &path,
            Provider::ChatGpt,
            "00000000-0000-4000-8000-000000000002",
        )
        .unwrap();
        drop(second);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn isolated_binding_rejects_other_page_mutations_and_close() {
        clear_owned_page();
        bind_owned_page("00000000-0000-4000-8000-000000000001", 7).unwrap();
        assert_eq!(owned_page_binding().unwrap().page_id, 7);
        assert!(bind_owned_page("00000000-0000-4000-8000-000000000002", 8).is_err());
        assert!(call_mcp_tool("unused", "close_page", serde_json::json!({"pageId": 2})).is_err());
        assert!(
            call_mcp_tool(
                "unused",
                "new_page",
                serde_json::json!({"url": "https://example.test"})
            )
            .is_err()
        );
        assert!(call_mcp_tool("unused", "select_page", serde_json::json!({"pageId": 8})).is_err());
        clear_owned_page();
    }

    fn completed_receipt() -> SessionReceipt {
        let mut receipt = SessionReceipt::new(0, 0);
        receipt.response_completion = ResponseCompletion::Completed;
        receipt
    }

    fn owned_binding(page_id: usize) -> OwnedPageBinding {
        OwnedPageBinding {
            session_id: "00000000-0000-4000-8000-000000000001".to_string(),
            page_id,
        }
    }

    #[test]
    fn owned_tab_cleanup_decision_enters_for_exact_owned_page() {
        let binding = owned_binding(7);
        assert_eq!(
            decide_owned_tab_cleanup(Some(&binding), Some(&completed_receipt())).unwrap(),
            7
        );
    }

    #[test]
    fn owned_tab_cleanup_decision_refuses_unbounded_and_other_ids() {
        let binding = owned_binding(7);
        let receipt = completed_receipt();
        // Unbounded page (no binding) is refused.
        assert!(decide_owned_tab_cleanup(None, Some(&receipt)).is_err());
        // No receipt is refused.
        assert!(decide_owned_tab_cleanup(Some(&binding), None).is_err());
        // The decision only ever returns the exact owned page ID (7), never an
        // "other" ID.
        assert_eq!(
            decide_owned_tab_cleanup(Some(&binding), Some(&receipt)).unwrap(),
            7
        );
    }

    #[test]
    fn owned_tab_cleanup_decision_refuses_submitted_unknown_and_identity_changed() {
        let binding = owned_binding(7);
        // Submitted/unknown outcome (Pending) is refused.
        assert!(
            decide_owned_tab_cleanup(Some(&binding), Some(&SessionReceipt::new(0, 0))).is_err()
        );
        // Unknown outcome is refused.
        let mut unknown = SessionReceipt::new(0, 0);
        unknown.response_completion = ResponseCompletion::Unknown;
        assert!(decide_owned_tab_cleanup(Some(&binding), Some(&unknown)).is_err());
        // Identity-changed (failure code present) is refused.
        let mut identity_changed = completed_receipt();
        identity_changed.response_failure_code = Some(ResponseFailureCode::ResponseIdentityChanged);
        assert!(decide_owned_tab_cleanup(Some(&binding), Some(&identity_changed)).is_err());
    }

    #[test]
    fn owned_tab_cleanup_decision_refuses_unknown_image_download() {
        let binding = owned_binding(7);
        let mut receipt = completed_receipt();
        receipt.expected_output_type = ExpectedOutputType::Image;
        // Image output with zero downloaded images is an unknown download.
        assert!(decide_owned_tab_cleanup(Some(&binding), Some(&receipt)).is_err());
        // A known download count allows cleanup.
        receipt.downloaded_image_count = 3;
        assert_eq!(
            decide_owned_tab_cleanup(Some(&binding), Some(&receipt)).unwrap(),
            7
        );
    }

    #[test]
    fn owned_tab_cleanup_verifies_page_present_before_close() {
        let present: std::collections::HashSet<usize> = [7usize].into_iter().collect();
        assert!(verify_owned_page_present(7, &present).is_ok());
        // A newly-created / other page (not the owned page) is refused.
        let other: std::collections::HashSet<usize> = [8usize].into_iter().collect();
        assert!(verify_owned_page_present(7, &other).is_err());
        // An empty page list (owned page disappeared) is refused.
        let empty: std::collections::HashSet<usize> = std::collections::HashSet::new();
        assert!(verify_owned_page_present(7, &empty).is_err());
    }

    #[test]
    fn owned_tab_cleanup_refuses_without_mcp_for_unsafe_states() {
        clear_owned_page();
        // No binding: refused before any MCP call.
        assert!(cleanup_owned_page_after_success("unused", None).is_err());
        // Binding but no receipt: refused before any MCP call.
        bind_owned_page("00000000-0000-4000-8000-000000000001", 7).unwrap();
        assert!(cleanup_owned_page_after_success("unused", None).is_err());
        clear_owned_page();
    }

    #[test]
    fn owned_tab_cleanup_failure_is_non_gating_warning() {
        clear_owned_page();
        // No binding -> cleanup refuses -> a warning is returned, not an error
        // that would change the already-verified success result.
        let warning = run_owned_tab_cleanup_warning("unused", None);
        assert!(warning.is_some());
        assert!(warning.unwrap().contains("Warning:"));
        // A completed receipt with no binding is still refused (unbounded
        // page), and the failure is sanitised to a warning.
        let root = make_test_dir("cleanup_non_gating");
        let path = root.join("receipt.json");
        write_private_json(&path, &completed_receipt()).unwrap();
        let warning = run_owned_tab_cleanup_warning("unused", Some(&path));
        assert!(warning.is_some());
        assert!(warning.unwrap().contains("Warning:"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_chrome_devtools_mcp_node_versions() {
        for version in [
            "v20.19.0",
            "v20.20.1\r\n",
            "v22.12.0",
            "v22.15.1",
            "v23.0.0",
            "v24.4.1",
        ] {
            assert!(
                validate_node_version_output(version).is_ok(),
                "expected {version:?} to be supported"
            );
        }

        for version in ["v18.20.8", "v20.17.0", "v20.18.9", "v21.7.3", "v22.11.0"] {
            assert!(
                validate_node_version_output(version).is_err(),
                "expected {version:?} to be rejected"
            );
        }
    }

    #[test]
    fn reports_actionable_node_version_errors() {
        let unsupported = validate_node_version_output("v20.17.0").unwrap_err();
        assert!(unsupported.contains("v20.17.0"));
        assert!(unsupported.contains("^20.19.0"));
        assert!(unsupported.contains("reopen the terminal"));

        for output in ["", "20.19", "not-a-version", "v20.19.0.1"] {
            assert!(
                validate_node_version_output(output).is_err(),
                "expected {output:?} to be rejected"
            );
        }
    }

    #[test]
    fn pins_chrome_devtools_mcp_version() {
        // `@latest` makes every npx spawn re-resolve the dist-tag against the
        // npm registry; combined with mcp-cli's timeout-less request wait this
        // hung whole runs (2026-07-11). The package spec must pin a version.
        let config = build_chrome_devtools_server_config(true, true, false);
        let args = config["args"].as_array().expect("args array");
        let pkg = args
            .iter()
            .filter_map(|a| a.as_str())
            .find(|a| a.starts_with("chrome-devtools-mcp"))
            .expect("chrome-devtools-mcp package argument");
        assert!(
            !pkg.ends_with("@latest"),
            "chrome-devtools-mcp must be version-pinned, got {pkg}"
        );
        let version = pkg.rsplit('@').next().unwrap_or_default();
        assert!(
            version.chars().next().is_some_and(|c| c.is_ascii_digit()),
            "expected an explicit pinned version, got {pkg}"
        );
    }

    #[test]
    fn classifies_transport_errors_for_reconnect() {
        // Transport failures earn a session reset + loud error (exact phrases
        // from mcp-cli's StdioClient surface inside CliError's `Details:`
        // line); the call is never replayed — see mcp_error_is_transport...
        for transport in [
            "MCP tool 'click' timed out after 90s",
            "Error [SERVER_CONNECTION_FAILED]: x\n  Details: Failed to send request to process stdin",
            "Error [TOOL_EXECUTION_FAILED]: x\n  Details: Server process exited unexpectedly. Last stderr:\nnpm error",
            "Error [SERVER_CONNECTION_FAILED]: x\n  Details: Stdio response receiver canceled",
            "Failed to start chrome-devtools MCP server: timed out after 120s",
        ] {
            assert!(
                mcp_error_is_transport(transport),
                "expected transport-class error: {transport}"
            );
        }
        // ...application-level tool errors must NOT reset the session — the
        // transport is fine and the caller needs the original error.
        for app_level in [
            "mcp-cli library call failed: Error [TOOL_EXECUTION_FAILED]: Tool \"click\" execution failed\n  Details: element not found",
            "mcp-cli library call failed: Error [TOOL_EXECUTION_FAILED]: Tool \"evaluate_script\" execution failed\n  Details: TypeError: x is undefined",
        ] {
            assert!(
                !mcp_error_is_transport(app_level),
                "expected app-level error to pass through: {app_level}"
            );
        }
    }

    #[test]
    fn piped_stdin_grace_skips_silent_pipe_when_prompt_argument_present() {
        // Agent harnesses (Claude Code / Codex) run commands with a non-tty
        // stdin they may never close; blocking on EOF hung whole runs
        // (2026-07-11). With a prompt argument in hand, a silent pipe must be
        // treated as "no piped input" after the grace period.
        let (_probe_tx, probe_rx) = std::sync::mpsc::channel::<StdinProbe>();
        let (_data_tx, data_rx) = std::sync::mpsc::channel::<std::io::Result<String>>();
        let out = recv_piped_stdin(&probe_rx, &data_rx, Duration::from_millis(50), true)
            .expect("silent pipe should yield empty stdin, not an error");
        assert_eq!(out, "");
    }

    #[test]
    fn piped_stdin_reads_live_pipe_to_eof_when_prompt_argument_present() {
        // A pipe that delivers data keeps the documented combine behavior:
        // `cat notes.md | ask-bridge '摘要'` must still append stdin.
        let (probe_tx, probe_rx) = std::sync::mpsc::channel();
        let (data_tx, data_rx) = std::sync::mpsc::channel();
        probe_tx.send(StdinProbe::Data).unwrap();
        data_tx.send(Ok("piped context".to_string())).unwrap();
        let out = recv_piped_stdin(&probe_rx, &data_rx, Duration::from_millis(50), true)
            .expect("live pipe should be read");
        assert_eq!(out, "piped context");
    }

    #[test]
    fn piped_stdin_waits_unbounded_when_no_prompt_argument() {
        // Without a prompt argument stdin IS the prompt: keep upstream's
        // unbounded wait even when data arrives long after any grace window.
        let (_probe_tx, probe_rx) = std::sync::mpsc::channel();
        let (data_tx, data_rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(120));
            let _ = data_tx.send(Ok("stdin is the prompt".to_string()));
        });
        let out = recv_piped_stdin(&probe_rx, &data_rx, Duration::from_millis(10), false)
            .expect("unbounded wait should return the piped prompt");
        assert_eq!(out, "stdin is the prompt");
    }

    #[test]
    fn builds_direct_quiet_mcp_configs() {
        fn config_args(config: &serde_json::Value) -> Vec<&str> {
            config["args"]
                .as_array()
                .expect("MCP config should contain an args array")
                .iter()
                .map(|arg| arg.as_str().expect("MCP arguments should be strings"))
                .collect()
        }

        let privacy_canary = "PRIVATE-PROMPT-BASE64-CANARY";
        let quiet_windows = build_chrome_devtools_server_config(true, true, true);
        let verbose_windows = build_chrome_devtools_server_config(false, true, true);
        let quiet_unix = build_chrome_devtools_server_config(true, true, false);
        let quiet_args = config_args(&quiet_windows);
        let verbose_args = config_args(&verbose_windows);

        assert_eq!(quiet_windows["command"].as_str(), Some("npx.cmd"));
        assert_eq!(verbose_windows["command"].as_str(), Some("npx.cmd"));
        assert_eq!(quiet_unix["command"].as_str(), Some("npx"));
        for required in [
            MCP_PACKAGE_SPEC,
            "--browser-url=http://127.0.0.1:9223",
            "--headless",
        ] {
            assert!(quiet_args.contains(&required));
            assert!(verbose_args.contains(&required));
        }
        for args in [&quiet_args, &verbose_args] {
            assert!(!args.contains(&"--logFile"));
            assert!(!args.iter().any(|arg| arg.contains(privacy_canary)));
        }
        assert!(quiet_args.contains(&"--no-usage-statistics"));
        assert!(quiet_args.contains(&"--no-performance-crux"));
        assert!(!verbose_args.contains(&"--no-usage-statistics"));
        assert!(!verbose_args.contains(&"--no-performance-crux"));
        assert!(!quiet_args.iter().any(|arg| arg.contains("2>nul")));
        assert_eq!(quiet_windows["env"]["CI"].as_str(), Some("1"));
        assert!(verbose_windows.get("env").is_none());
    }

    #[test]
    fn private_mcp_config_has_no_raw_log_and_uses_private_permissions() {
        let root = make_test_dir("private_mcp_config");
        let config_dir = root.join("state");
        let path = write_mcp_config_at(&config_dir, true, true, false).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(!content.contains("--logFile"));
        assert!(!content.contains("chrome-devtools-mcp.log"));
        assert!(!content.contains("PRIVATE-PROMPT-BASE64-CANARY"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&config_dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_script_result_containing_markdown_code_fence() {
        let markdown = "說明\n```rust\nfn main() { println!(\"ok\"); }\n```\n結尾";
        let encoded = serde_json::to_string(markdown).expect("markdown should serialize");
        let result = serde_json::json!({
            "content": [{
                "type": "text",
                "text": format!("Script ran on page and returned:\n```json\n{}\n```", encoded)
            }]
        });

        assert_eq!(
            parse_script_result(&result).expect("script result should parse"),
            serde_json::Value::String(markdown.to_string())
        );
    }

    #[test]
    fn rejects_malformed_script_fence_without_leaking_payload() {
        let secret = "private-response-content";
        let encoded = serde_json::to_string(secret).expect("secret should serialize");

        for text in [
            format!("Script ran on page and returned:\n```json\n{}", encoded),
            format!(
                "Script ran on page and returned:\n```json\n{} trailing-data\n```",
                encoded
            ),
        ] {
            let result = serde_json::json!({
                "content": [{ "type": "text", "text": text }]
            });
            let error = parse_script_result(&result).expect_err("malformed fence should fail");

            assert!(!error.contains(secret));
        }
    }

    #[test]
    fn rejects_malformed_script_shape_without_leaking_payload() {
        let secret = "private-response-content";
        let result = serde_json::json!({
            "content": [{ "type": "text", "unexpected": secret }]
        });
        let error = parse_script_result(&result).expect_err("malformed shape should fail");

        assert!(!error.contains(secret));
        assert!(error.contains("Could not extract text field"));
    }

    fn make_test_dir(name: &str) -> std::path::PathBuf {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "ask_bridge_{}_{}_{}",
            name,
            std::process::id(),
            timestamp
        ))
    }

    #[test]
    fn parses_provider_as_global_argument() {
        let cli = Cli::try_parse_from(["ask-bridge", "--provider", "gemini", "login"]).unwrap();
        assert_eq!(cli.provider, Some(Provider::Gemini));
        assert!(matches!(cli.command, Some(Commands::Login)));

        let cli = Cli::try_parse_from(["ask-bridge", "login", "--provider", "gemini"]).unwrap();
        assert_eq!(cli.provider, Some(Provider::Gemini));
        assert!(matches!(cli.command, Some(Commands::Login)));
    }

    #[test]
    fn parses_config_command() {
        let cli = Cli::try_parse_from(["ask-bridge", "config", "--provider", "gemini"]).unwrap();
        assert_eq!(cli.provider, Some(Provider::Gemini));
        assert!(matches!(cli.command, Some(Commands::Config)));
    }

    #[test]
    fn parses_config_command_without_provider() {
        let cli = Cli::try_parse_from(["ask-bridge", "config"]).unwrap();
        assert_eq!(cli.provider, None);
        assert!(matches!(cli.command, Some(Commands::Config)));
    }

    #[test]
    fn parses_update_command() {
        let cli = Cli::try_parse_from(["ask-bridge", "update"]).unwrap();
        assert!(matches!(cli.command, Some(Commands::Update)));
    }

    #[test]
    fn leaves_provider_unset_when_cli_argument_is_missing() {
        let cli = Cli::try_parse_from(["ask-bridge", "hello"]).unwrap();
        assert_eq!(cli.provider, None);
    }

    #[test]
    fn parses_provider_from_config_json() {
        assert_eq!(
            parse_configured_provider(r#"{"provider":"gemini"}"#).unwrap(),
            Some(Provider::Gemini)
        );
        assert_eq!(
            parse_configured_provider(r#"{"provider":"chatgpt"}"#).unwrap(),
            Some(Provider::ChatGpt)
        );
        assert_eq!(
            parse_configured_provider(r#"{"provider":"chat-gpt"}"#).unwrap(),
            Some(Provider::ChatGpt)
        );
        assert_eq!(
            parse_configured_provider(r#"{"provider":"claude"}"#).unwrap(),
            Some(Provider::Claude)
        );
        assert_eq!(
            parse_configured_provider(r#"{"provider":"claude-ai"}"#).unwrap(),
            Some(Provider::Claude)
        );
        assert_eq!(parse_configured_provider(r#"{}"#).unwrap(), None);
    }

    #[test]
    fn resolves_provider_precedence() {
        assert_eq!(
            effective_provider(Some(Provider::ChatGpt), Some(Provider::Gemini)),
            Provider::ChatGpt
        );
        assert_eq!(
            effective_provider(None, Some(Provider::Gemini)),
            Provider::Gemini
        );
        assert_eq!(effective_provider(None, None), Provider::ChatGpt);
    }

    #[test]
    fn cli_provider_bypasses_invalid_config() {
        let provider = resolve_provider_with(Some(Provider::ChatGpt), || {
            Err("config should not be loaded".to_string())
        })
        .unwrap();

        assert_eq!(provider, Provider::ChatGpt);
    }

    #[test]
    fn resolves_provider_from_config_when_cli_provider_is_missing() {
        let provider = resolve_provider_with(None, || Ok(Some(Provider::Gemini))).unwrap();
        assert_eq!(provider, Provider::Gemini);
    }

    #[test]
    fn rejects_invalid_provider_in_config_json() {
        let err = parse_configured_provider(r#"{"provider":"copilot"}"#).unwrap_err();
        assert!(err.contains("Invalid provider"));
    }

    #[test]
    fn parses_close_command() {
        let cli = Cli::try_parse_from(["ask-bridge", "close"]).unwrap();
        assert!(matches!(cli.command, Some(Commands::Close)));
    }

    #[test]
    fn hides_debug_commands_from_help() {
        let mut command = Cli::command();
        let help = command.render_long_help().to_string();

        assert!(!help.contains("\n  open"));
        assert!(!help.contains("\n  get"));
        assert!(!help.contains("\n  dump"));
        assert!(!help.contains("\n  screenshot"));
        assert!(help.contains("\n  login"));
        assert!(help.contains("\n  close"));
        assert!(help.contains("\n  update"));
    }

    #[test]
    fn still_parses_hidden_debug_commands() {
        let cli = Cli::try_parse_from(["ask-bridge", "open"]).unwrap();
        assert!(matches!(cli.command, Some(Commands::Open { .. })));

        let cli = Cli::try_parse_from(["ask-bridge", "get"]).unwrap();
        assert!(matches!(cli.command, Some(Commands::Get { .. })));

        let cli = Cli::try_parse_from(["ask-bridge", "dump"]).unwrap();
        assert!(matches!(cli.command, Some(Commands::Dump)));

        let cli = Cli::try_parse_from(["ask-bridge", "screenshot"]).unwrap();
        assert!(matches!(cli.command, Some(Commands::Screenshot)));
    }

    #[test]
    fn parses_verbose_get_command_flag() {
        let url = "https://chatgpt.com/c/6a50fe34-43c0-83ee-ab86-d41adf91625e";
        let cli = Cli::try_parse_from(["ask-bridge", "get", "--verbose", url]).unwrap();
        if let Some(Commands::Get {
            url: parsed_url,
            verbose,
        }) = cli.command
        {
            assert_eq!(parsed_url, Some(url.to_string()));
            assert!(verbose);
        } else {
            panic!("expected get command");
        }
        assert!(!cli.verbose);
    }

    #[test]
    fn rejects_unknown_provider() {
        assert!(Cli::try_parse_from(["ask-bridge", "--provider", "copilot", "hello"]).is_err());
    }

    #[test]
    fn parses_claude_provider_argument() {
        let cli = Cli::try_parse_from(["ask-bridge", "--provider", "claude", "hello"]).unwrap();
        assert_eq!(cli.provider, Some(Provider::Claude));
    }

    #[test]
    fn maps_provider_urls() {
        assert_eq!(
            Provider::from_url("https://chatgpt.com/c/abc"),
            Some(Provider::ChatGpt)
        );
        assert_eq!(
            Provider::from_url("https://gemini.google.com/app/abc"),
            Some(Provider::Gemini)
        );
        assert_eq!(
            Provider::from_url("https://claude.ai/chat/abc"),
            Some(Provider::Claude)
        );
        assert_eq!(Provider::from_url("https://example.com"), None);
    }

    #[test]
    fn parses_chatgpt_agent_prompt_with_chinese_agent_name() {
        assert_eq!(
            parse_chatgpt_agent_prompt(
                "@智慧 研究多奇數位創意有限公司的發展沿革與創辦人的豐功偉業"
            ),
            Some(ChatGptAgentPrompt {
                agent_mention: "@智慧",
                body: "研究多奇數位創意有限公司的發展沿革與創辦人的豐功偉業"
            })
        );
    }

    #[test]
    fn parses_chatgpt_agent_prompt_with_ten_character_agent_name() {
        assert_eq!(
            parse_chatgpt_agent_prompt("@一二三四五六七八九十 查資料"),
            Some(ChatGptAgentPrompt {
                agent_mention: "@一二三四五六七八九十",
                body: "查資料"
            })
        );
    }

    #[test]
    fn trims_extra_whitespace_between_chatgpt_agent_and_body() {
        assert_eq!(
            parse_chatgpt_agent_prompt("@智慧 \n\t查資料").unwrap().body,
            "查資料"
        );
    }

    #[test]
    fn rejects_invalid_chatgpt_agent_prompt_shapes() {
        assert_eq!(parse_chatgpt_agent_prompt("智慧 查資料"), None);
        assert_eq!(parse_chatgpt_agent_prompt("@ 查資料"), None);
        assert_eq!(parse_chatgpt_agent_prompt("@智慧"), None);
        assert_eq!(parse_chatgpt_agent_prompt("@智慧   "), None);
        assert_eq!(
            parse_chatgpt_agent_prompt("@一二三四五六七八九十甲 查資料"),
            None
        );
    }

    #[test]
    fn extracts_snapshot_uid_from_common_formats() {
        assert_eq!(
            extract_snapshot_uid(r#"- button "上傳檔案" [uid="1_23"]"#),
            Some("1_23".to_string())
        );
        assert_eq!(
            extract_snapshot_uid(r#"- button "Upload file" uid=42"#),
            Some("42".to_string())
        );
    }

    #[test]
    fn finds_snapshot_uid_with_include_and_exclude_terms() {
        let snapshot = r#"
            - button "加入雲端硬碟檔案" [uid="1_10"]
            - menuitem "上傳檔案. 文件、資料、程式碼檔案" [uid="1_11"]
        "#;
        assert_eq!(
            find_snapshot_uid(snapshot, &["上傳檔案"], &["雲端"]),
            Some("1_11".to_string())
        );
    }

    #[test]
    fn rejects_gemini_image_attachments() {
        let cli = Cli::try_parse_from([
            "ask-bridge",
            "--provider",
            "gemini",
            "--image",
            "token.png",
            "read",
        ])
        .unwrap();
        assert!(validate_provider_feature_support(Provider::Gemini, &cli).is_err());
    }

    #[test]
    fn allows_claude_image_and_file_attachments() {
        let cli = Cli::try_parse_from([
            "ask-bridge",
            "--provider",
            "claude",
            "--image",
            "token.png",
            "--file",
            "token.txt",
            "read",
        ])
        .unwrap();
        assert!(validate_provider_feature_support(Provider::Claude, &cli).is_ok());
    }

    #[test]
    fn allows_gemini_file_attachments() {
        let cli = Cli::try_parse_from([
            "ask-bridge",
            "--provider",
            "gemini",
            "--file",
            "token.txt",
            "read",
        ])
        .unwrap();
        assert!(validate_provider_feature_support(Provider::Gemini, &cli).is_ok());
    }

    #[test]
    fn finds_linux_google_chrome_command_from_path() {
        let root = make_test_dir("chrome_path");
        let first_dir = root.join("first");
        let second_dir = root.join("second");
        std::fs::create_dir_all(&first_dir).unwrap();
        std::fs::create_dir_all(&second_dir).unwrap();

        let stable_path = first_dir.join("google-chrome-stable");
        let chrome_path = second_dir.join("google-chrome");
        std::fs::write(&stable_path, "").unwrap();
        std::fs::write(&chrome_path, "").unwrap();

        let path_env = std::env::join_paths([first_dir.as_os_str(), second_dir.as_os_str()])
            .expect("test PATH should be joinable");

        let found = find_linux_chrome_path(Some(path_env.as_os_str()), &[]);

        assert_eq!(found, Some(chrome_path.to_string_lossy().to_string()));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn finds_linux_chrome_from_standard_candidates_when_path_misses() {
        let root = make_test_dir("chrome_candidate");
        std::fs::create_dir_all(&root).unwrap();
        let chrome_path = root.join("google-chrome");
        std::fs::write(&chrome_path, "").unwrap();

        let chrome_path_str = chrome_path.to_string_lossy().to_string();
        let candidates = [chrome_path_str.as_str()];

        let found = find_linux_chrome_path(None, &candidates);

        assert_eq!(found, Some(chrome_path_str));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn returns_none_when_linux_chrome_is_missing() {
        assert_eq!(find_linux_chrome_path(None, &[]), None);
    }

    #[test]
    fn matches_profile_argument_with_quotes_and_slashes() {
        let command = r#""C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223 "--user-data-dir=C:\Users\Will\.config\ask-bridge\chrome-profile""#;
        let profile_path = r"C:/Users/Will/.config/ask-bridge/chrome-profile";

        assert!(command_uses_profile(command, profile_path));
    }

    #[test]
    fn matches_profile_argument_when_value_is_separated_by_space() {
        let command = r#"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9223 --user-data-dir /Users/will/.config/ask-bridge/chrome-profile"#;
        let profile_path = "/Users/will/.config/ask-bridge/chrome-profile";

        assert!(command_uses_profile(command, profile_path));
    }

    #[test]
    fn rejects_different_profile_argument() {
        let command = r#"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9223 --user-data-dir=/Users/will/.config/other/chrome-profile"#;
        let profile_path = "/Users/will/.config/ask-bridge/chrome-profile";

        assert!(!command_uses_profile(command, profile_path));
    }

    #[test]
    fn rejects_profile_and_marker_prefixes_with_extra_suffixes() {
        let profile_path = r"C:\Users\Will\.config\ask-bridge\chrome-profile";
        let profile_copy =
            r#"chrome.exe --user-data-dir=C:\Users\Will\.config\ask-bridge\chrome-profile-copy"#;
        let marker_copy = "chrome.exe --ask-bridge-instance-copy";

        assert!(!command_uses_profile(profile_copy, profile_path));
        assert!(!command_identifies_ask_chrome(marker_copy, profile_path));
    }

    #[test]
    fn composer_without_account_or_auth_controls_has_logged_in_state() {
        let signals = LoginSignals {
            account: false,
            auth_control: false,
            auth_path: false,
            composer: true,
            stable: true,
        };

        assert_eq!(signals.state(Provider::ChatGpt), LoginState::LoggedIn);
    }

    #[test]
    fn chatgpt_login_signals_wait_for_ambiguous_auth_shell() {
        let script = Provider::ChatGpt.login_signals_js();

        assert!(script.starts_with("async () =>"));
        assert!(script.contains("earliestDecision"));
        assert!(script.contains("stableSince"));
        assert!(script.contains("let stable = false"));
        assert!(script.contains("JSON.stringify(nextSignals)"));
        assert!(script.contains("await new Promise"));
        assert!(script.contains("Date.now() + 5000"));
        assert!(script.contains("return { ...signals, stable }"));
    }

    #[test]
    fn account_control_has_logged_in_state() {
        let signals = LoginSignals {
            account: true,
            auth_control: false,
            auth_path: false,
            composer: true,
            stable: true,
        };

        assert_eq!(signals.state(Provider::ChatGpt), LoginState::LoggedIn);
    }

    #[test]
    fn auth_control_or_auth_path_has_logged_out_state() {
        let visible_auth_control = LoginSignals {
            account: false,
            auth_control: true,
            auth_path: false,
            composer: true,
            stable: true,
        };
        let auth_path = LoginSignals {
            account: false,
            auth_control: false,
            auth_path: true,
            composer: false,
            stable: false,
        };

        assert_eq!(
            visible_auth_control.state(Provider::ChatGpt),
            LoginState::LoggedOut
        );
        assert_eq!(auth_path.state(Provider::ChatGpt), LoginState::LoggedOut);
    }

    #[test]
    fn empty_login_signals_have_unknown_state() {
        let signals = LoginSignals {
            account: false,
            auth_control: false,
            auth_path: false,
            composer: false,
            stable: true,
        };

        assert_eq!(signals.state(Provider::ChatGpt), LoginState::Unknown);
    }

    #[test]
    fn unstable_chatgpt_signals_never_block_or_confirm_login() {
        for signals in [
            LoginSignals {
                account: false,
                auth_control: true,
                auth_path: false,
                composer: true,
                stable: false,
            },
            LoginSignals {
                account: false,
                auth_control: false,
                auth_path: false,
                composer: true,
                stable: false,
            },
        ] {
            assert_eq!(signals.state(Provider::ChatGpt), LoginState::Unknown);
        }
    }

    #[test]
    fn auth_path_overrides_stale_account_control() {
        let signals = LoginSignals {
            account: true,
            auth_control: false,
            auth_path: true,
            composer: true,
            stable: false,
        };

        assert_eq!(signals.state(Provider::ChatGpt), LoginState::LoggedOut);
    }

    #[test]
    fn gemini_composer_without_account_remains_unknown() {
        let signals = LoginSignals {
            account: false,
            auth_control: false,
            auth_path: false,
            composer: true,
            stable: true,
        };

        assert_eq!(signals.state(Provider::Gemini), LoginState::Unknown);
    }

    #[test]
    fn prefers_logged_in_provider_page_over_selected_page() {
        let pages = [
            PageLoginState {
                id: 2,
                selected: true,
                login_state: LoginState::LoggedOut,
            },
            PageLoginState {
                id: 7,
                selected: false,
                login_state: LoginState::LoggedIn,
            },
        ];

        assert_eq!(preferred_provider_page_id(&pages), Some(7));
    }

    #[test]
    fn falls_back_to_selected_provider_page_when_none_are_logged_in() {
        let pages = [
            PageLoginState {
                id: 2,
                selected: false,
                login_state: LoginState::Unknown,
            },
            PageLoginState {
                id: 7,
                selected: true,
                login_state: LoginState::LoggedOut,
            },
        ];

        assert_eq!(preferred_provider_page_id(&pages), Some(7));
    }

    #[test]
    fn marker_identifies_ask_bridge_chrome_without_profile_argument() {
        let command = r#"chrome.exe --type=browser --ask-bridge-instance"#;

        assert!(command_identifies_ask_chrome(
            command,
            r"C:\Users\Will\.config\ask-bridge\chrome-profile"
        ));
    }

    #[test]
    fn parses_legacy_and_json_chrome_process_records() {
        assert_eq!(
            parse_chrome_process_record("15864\r\n"),
            Some(ChromeProcessRecord {
                pid: 15864,
                browser_id: None,
            })
        );
        assert_eq!(
            parse_chrome_process_record(r#"{"pid":20728,"browser_id":"browser-123"}"#),
            Some(ChromeProcessRecord {
                pid: 20728,
                browser_id: Some("browser-123".to_string()),
            })
        );
    }

    #[test]
    fn extracts_browser_id_from_cdp_version_response() {
        let body = r#"{"Browser":"Chrome/149","webSocketDebuggerUrl":"ws://127.0.0.1:9223/devtools/browser/browser-123"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length:{}\r\nContent-Type:application/json\r\n\r\n{}",
            body.len(),
            body
        );

        assert_eq!(
            browser_id_from_version_response(&response),
            Some("browser-123".to_string())
        );
        assert!(http_response_is_complete(response.as_bytes()));
        assert!(!http_response_is_complete(
            &response.as_bytes()[..response.len() - 1]
        ));

        let non_success = response.replacen("200 OK", "404 Not Found", 1);
        assert_eq!(browser_id_from_version_response(&non_success), None);
        assert_eq!(browser_id_from_version_response(body), None);

        let foreign_body = body.replace("127.0.0.1:9223", "example.com:9223");
        let foreign_response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length:{}\r\n\r\n{}",
            foreign_body.len(),
            foreign_body
        );
        assert_eq!(browser_id_from_version_response(&foreign_response), None);

        let overflowing_length = format!(
            "HTTP/1.1 200 OK\r\nContent-Length:{}\r\n\r\n{{}}",
            usize::MAX
        );
        assert!(!http_response_is_complete(overflowing_length.as_bytes()));
    }

    #[test]
    fn build_chrome_process_record_prefers_unique_listener_pid() {
        let listeners = vec!["20728".to_string()];
        assert_eq!(
            build_chrome_process_record(&listeners, Some("browser-123")),
            Some(ChromeProcessRecord {
                pid: 20728,
                browser_id: Some("browser-123".to_string()),
            })
        );
    }

    #[test]
    fn build_chrome_process_record_requires_unambiguous_identity() {
        assert_eq!(
            build_chrome_process_record(
                &["20728".to_string(), "30000".to_string()],
                Some("browser-123")
            ),
            None
        );
        assert_eq!(
            build_chrome_process_record(&["20728".to_string()], None),
            None
        );
    }

    #[test]
    fn chrome_record_matches_current_checks_browser_identity_and_scope() {
        let record = ChromeProcessRecord {
            pid: 20728,
            browser_id: Some("browser-123".to_string()),
        };
        let single = vec!["20728".to_string()];
        let multiple = vec!["20728".to_string(), "30000".to_string()];

        assert!(chrome_record_matches_current(
            Some(&record),
            Some("browser-123"),
            &single
        ));
        assert!(!chrome_record_matches_current(
            Some(&record),
            Some("browser-456"),
            &single
        ));
        assert!(!chrome_record_matches_current(
            Some(&record),
            Some("browser-123"),
            &multiple
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_netstat_parser_matches_exact_listening_port() {
        let output = concat!(
            "  TCP    127.0.0.1:9223    0.0.0.0:0    LISTENING    20728\r\n",
            "  TCP    127.0.0.1:92230   0.0.0.0:0    LISTENING    30000\r\n",
            "  TCP    [::1]:9223        [::]:0       LISTENING    20728\r\n",
            "  TCP    127.0.0.1:9223    127.0.0.1:50000 ESTABLISHED 40000\r\n",
            "  UDP    127.0.0.1:9223    *:*                       50000\r\n"
        );

        assert_eq!(
            parse_windows_netstat_listener_pids(output, 9223),
            vec!["20728".to_string()]
        );
    }

    #[test]
    fn finds_ask_owner_pids_and_deduplicates_results() {
        let listeners = vec![
            "30000".to_string(),
            "20728".to_string(),
            "20728".to_string(),
        ];
        let commands = std::collections::HashMap::from([
            ("20728", "chrome.exe --type=utility"),
            ("30000", "chrome.exe --type=gpu-process"),
            (
                "18000",
                "chrome.exe --remote-debugging-port=9223 --ask-bridge-instance",
            ),
            (
                "15000",
                "chrome.exe --user-data-dir=C:\\Users\\Chris\\.config\\ask-bridge\\chrome-profile",
            ),
        ]);
        let parents = std::collections::HashMap::from([
            ("20728", "18000"),
            ("30000", "18000"),
            ("18000", "1"),
            ("15000", "1"),
        ]);

        let ask_pids = find_ask_chrome_owner_pids_with(
            &listeners,
            r"C:\Users\Chris\.config\ask-bridge\chrome-profile",
            |pid| commands.get(pid).map(|command| (*command).to_string()),
            |pid| parents.get(pid).map(|parent| (*parent).to_string()),
        );

        assert_eq!(ask_pids, vec!["18000".to_string()]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parses_wmic_value_after_blank_lines() {
        let output = "CommandLine\r\n\r\n  chrome.exe --remote-debugging-port=9223  \r\n\r\n";

        assert_eq!(
            parse_wmic_column_value(output),
            Some("chrome.exe --remote-debugging-port=9223".to_string())
        );
    }

    #[test]
    fn finds_ask_chrome_owner_in_parent_process_chain() {
        let commands = std::collections::HashMap::from([
            ("100", "chrome.exe --type=utility"),
            (
                "50",
                "chrome.exe --remote-debugging-port=9223 --ask-bridge-instance",
            ),
        ]);
        let parents = std::collections::HashMap::from([("100", "50"), ("50", "1")]);

        let owner = find_ask_chrome_owner_pid_with(
            "100",
            "/tmp/ask-bridge/chrome-profile",
            |pid| commands.get(pid).map(|command| (*command).to_string()),
            |pid| parents.get(pid).map(|parent| (*parent).to_string()),
        );

        assert_eq!(owner, Some("50".to_string()));
    }

    #[test]
    fn rejects_process_chain_without_profile_or_marker() {
        let commands = std::collections::HashMap::from([
            ("100", "chrome.exe --type=utility"),
            ("50", "chrome.exe --remote-debugging-port=9223"),
        ]);
        let parents = std::collections::HashMap::from([("100", "50"), ("50", "1")]);

        let owner = find_ask_chrome_owner_pid_with(
            "100",
            "/tmp/ask-bridge/chrome-profile",
            |pid| commands.get(pid).map(|command| (*command).to_string()),
            |pid| parents.get(pid).map(|parent| (*parent).to_string()),
        );

        assert_eq!(owner, None);
    }
}

fn read_clipboard() -> Result<String, String> {
    let output = Command::new("pbpaste")
        .output()
        .map_err(|e| format!("Failed to run pbpaste: {}", e))?;

    if !output.status.success() {
        return Err(format!("pbpaste exited with status: {}", output.status));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn write_clipboard(content: &str) -> Result<(), String> {
    let mut child = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run pbcopy: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write clipboard content: {}", e))?;
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for pbcopy: {}", e))?;

    if !status.success() {
        return Err(format!("pbcopy exited with status: {}", status));
    }

    Ok(())
}

fn click_latest_copy_button(config_path: &str, provider: Provider) -> Result<(), String> {
    let response_selector = serde_json::to_string(provider.latest_response_selector())
        .map_err(|e| format!("Failed to serialize response selector: {}", e))?;
    let script = r#"() => {
                const isVisible = (el) => {
                    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                };

                const labelOf = (el) => [
                    el.getAttribute('aria-label'),
                    el.getAttribute('title'),
                    el.getAttribute('data-testid'),
                    el.textContent
                ].filter(Boolean).join(' ');

                const isCopyButton = (el) => {
                    const label = labelOf(el);
                    return /copy|複製|复制|コピー|복사/i.test(label)
                        && !/prompt|提示詞|提示词|入力|table|表格/i.test(label);
                };
                const copyButtonScore = (el) => {
                    const label = labelOf(el);
                    if (!isCopyButton(el) || !isVisible(el)) return -1;
                    if (el.closest('pre, code, [class*="code"], [data-testid*="code"]')) return -1;
                    if (/copy-turn-action-button/i.test(label)) return 100;
                    if (/response|回應|回答|reply/i.test(label)) return 90;
                    if (el.closest('model-response, response-container, [data-message-author-role="assistant"], .agent-turn, [data-is-streaming], .font-claude-response')) return 50;
                    return 10;
                };
                const messages = Array.from(document.querySelectorAll(__RESPONSE_SELECTOR__));
                const latest = messages[messages.length - 1];
                if (!latest) return { ok: false, reason: "No assistant message found" };

                latest.scrollIntoView({ block: 'center', inline: 'nearest' });
                for (const type of ['pointerover', 'mouseover', 'mouseenter']) {
                    latest.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
                }

                const scopes = [
                    latest,
                    latest.closest('article'),
                    latest.closest('[data-testid^="conversation-turn"]'),
                    latest.parentElement,
                    latest.parentElement?.parentElement
                ].filter(Boolean);

                for (const scope of scopes) {
                    const buttons = Array.from(scope.querySelectorAll('button'));
                    const candidates = buttons
                        .map((button) => ({ button, score: copyButtonScore(button) }))
                        .filter((candidate) => candidate.score >= 0)
                        .sort((a, b) => b.score - a.score);
                    if (candidates.length > 0) {
                        const button = candidates[0].button;
                        button.click();
                        return { ok: true, label: labelOf(button) };
                    }
                }

                return { ok: false, reason: "Copy response button not found" };
            }"#
    .replace("__RESPONSE_SELECTOR__", &response_selector);
    let res = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({
            "function": script
        }),
    )?;

    let parsed = parse_script_result(&res)?;
    if parsed["ok"].as_bool().unwrap_or(false) {
        Ok(())
    } else {
        Err(parsed["reason"]
            .as_str()
            .unwrap_or("Failed to click copy response button")
            .to_string())
    }
}

fn wait_for_page_load(config_path: &str, provider: Provider, verbose: bool) -> Result<(), String> {
    if verbose {
        println!("Waiting for page readyState...");
    }

    // Phase 1: Wait for readyState complete or interactive
    let mut ready = false;
    for _ in 0..90 {
        let ready_res = call_mcp_tool(
            config_path,
            "evaluate_script",
            serde_json::json!({
                "function": "() => document.readyState === 'complete' || document.readyState === 'interactive'"
            }),
        );

        if ready_res
            .and_then(|res| parse_script_result(&res))
            .map(|parsed| parsed.as_bool().unwrap_or(false))
            .unwrap_or(false)
        {
            ready = true;
            break;
        }

        thread::sleep(Duration::from_millis(500));
    }

    if !ready {
        return Err("Timeout waiting for page readyState to be loaded".to_string());
    }

    if verbose {
        println!("Waiting for {} page elements...", provider.display_name());
    }

    // Phase 2: Wait for key provider elements to render.
    for _ in 0..60 {
        let element_res = call_mcp_tool(
            config_path,
            "evaluate_script",
            serde_json::json!({
                "function": provider.ready_check_js()
            }),
        );

        if element_res
            .and_then(|res| parse_script_result(&res))
            .map(|parsed| parsed.as_bool().unwrap_or(false))
            .unwrap_or(false)
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }

    if verbose {
        println!(
            "Warning: Timeout waiting for {} page elements. Proceeding anyway...",
            provider.display_name()
        );
    }
    Ok(())
}

fn open_url_tab(
    config_path: &str,
    provider: Provider,
    url: &str,
    headless: bool,
    verbose: bool,
) -> Result<(), String> {
    if verbose {
        println!("Opening URL: {}", url);
    }

    let list_res = call_mcp_tool(config_path, "list_pages", serde_json::json!({}))?;
    let text = list_res
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|obj| obj.get("text"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| format!("Invalid list_pages response structure: {:?}", list_res))?;

    let pages = parse_pages(text);
    if pages.len() == 1
        && (pages[0].url == "about:blank"
            || pages[0].url.contains("new-tab-page")
            || pages[0].url.contains("chrome://welcome"))
    {
        call_mcp_tool(
            config_path,
            "navigate_page",
            serde_json::json!({
                "url": url
            }),
        )?;
    } else {
        call_mcp_tool(
            config_path,
            "new_page",
            serde_json::json!({
                "url": url
            }),
        )?;
    }

    for _ in 0..20 {
        let refreshed_pages_res = call_mcp_tool(config_path, "list_pages", serde_json::json!({}))?;
        let refreshed_text = refreshed_pages_res
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|obj| obj.get("text"))
            .and_then(|t| t.as_str())
            .ok_or_else(|| {
                format!(
                    "Invalid refreshed list_pages response structure: {:?}",
                    refreshed_pages_res
                )
            })?;

        let refreshed_pages = parse_pages(refreshed_text);
        if let Some(page) = refreshed_pages.iter().find(|page| page.url == url) {
            call_mcp_tool(
                config_path,
                "select_page",
                serde_json::json!({
                    "pageId": page.id,
                    "bringToFront": !headless
                }),
            )?;

            for stale_page in refreshed_pages.iter().filter(|p| p.id != page.id) {
                let _ = call_mcp_tool(
                    config_path,
                    "close_page",
                    serde_json::json!({
                        "pageId": stale_page.id
                    }),
                );
            }

            let page_provider = Provider::from_url(url).unwrap_or(provider);
            return wait_for_page_load(config_path, page_provider, verbose);
        }

        thread::sleep(Duration::from_millis(250));
    }

    let page_provider = Provider::from_url(url).unwrap_or(provider);
    wait_for_page_load(config_path, page_provider, verbose)
}

fn copy_latest_markdown(config_path: &str, provider: Provider) -> Result<String, String> {
    match copy_latest_markdown_via_clipboard(config_path, provider) {
        Ok(content) => Ok(content),
        Err(_) => scrape_latest_markdown_from_dom(config_path, provider),
    }
}

fn copy_latest_markdown_via_clipboard(
    config_path: &str,
    provider: Provider,
) -> Result<String, String> {
    let clipboard_before = read_clipboard().unwrap_or_default();
    let sentinel = format!("__ASK_CHATGPT_COPY_PENDING_{}__", std::process::id());
    write_clipboard(&sentinel)?;

    // Click the copy button, retrying if the message or button is not found yet (due to asynchronous rendering of Single Page App)
    let mut click_err = None;
    for _ in 0..30 {
        match click_latest_copy_button(config_path, provider) {
            Ok(_) => {
                click_err = None;
                break;
            }
            Err(e) => {
                click_err = Some(e);
                thread::sleep(Duration::from_millis(500));
            }
        }
    }

    if let Some(err) = click_err {
        // Restore clipboard before returning error
        let _ = write_clipboard(&clipboard_before);
        return Err(format!("Error copying latest response Markdown: {}", err));
    }

    let mut copied_content = None;
    for _ in 0..30 {
        thread::sleep(Duration::from_millis(100));
        match read_clipboard() {
            Ok(content) if !content.trim().is_empty() && content != sentinel => {
                copied_content = Some(content);
                break;
            }
            _ => {}
        }
    }

    // Always restore the original clipboard
    let _ = write_clipboard(&clipboard_before);

    let content = copied_content
        .ok_or_else(|| "Timed out waiting for clipboard content after clicking copy".to_string())?;

    // Create a temporary file path
    let temp_path = std::env::temp_dir().join(format!("ask_chatgpt_{}.md", std::process::id()));

    // Write the copied content immediately to the temporary file
    std::fs::write(&temp_path, &content)
        .map_err(|e| format!("Failed to write to temporary file: {}", e))?;

    // Read the content back from the temporary file to output to the terminal
    let verified_content = std::fs::read_to_string(&temp_path)
        .map_err(|e| format!("Failed to read from temporary file: {}", e))?;

    // Clean up temporary file
    let _ = std::fs::remove_file(&temp_path);

    Ok(verified_content)
}

fn scrape_latest_markdown_from_dom(
    config_path: &str,
    provider: Provider,
) -> Result<String, String> {
    let latest_selector = serde_json::to_string(provider.latest_response_selector())
        .map_err(|e| format!("Failed to serialize response selector: {}", e))?;
    let content_selector = serde_json::to_string(provider.response_content_selector())
        .map_err(|e| format!("Failed to serialize response content selector: {}", e))?;
    let inspect_js = r#"() => {
        const latestSelector = __LATEST_SELECTOR__;
        const contentSelector = __CONTENT_SELECTOR__;
        const messages = Array.from(document.querySelectorAll(latestSelector))
            .filter((el) => ((el.innerText || el.textContent || '').trim().length > 0));
        const latest = messages[messages.length - 1];
        if (!latest) return 'No assistant message found';
        const turn = contentSelector ? (latest.querySelector(contentSelector) || latest) : latest;
        
        const elementToMarkdown = (element) => {
            let markdown = '';
            const processedSrcs = new Set();
            const walk = (node) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    markdown += node.textContent;
                    return;
                }
                if (node.nodeType !== Node.ELEMENT_NODE) return;

                const tag = node.tagName.toLowerCase();
                
                const classText = Array.from(node.classList || []).join(' ');
                if (node.classList.contains('sr-only') ||
                    /screen-reader|visually-hidden|cdk-visually-hidden/.test(classText) ||
                    tag === 'button' || tag === 'style' || tag === 'script') {
                    return;
                }

                // Code blocks
                if (tag === 'pre') {
                    const codeEl = node.querySelector('code');
                    const langClass = codeEl ? Array.from(codeEl.classList).find(c => c.startsWith('language-')) : '';
                    const lang = langClass ? langClass.replace('language-', '') : '';
                    const codeText = codeEl ? codeEl.textContent : node.textContent;
                    markdown += '\n```' + lang + '\n' + codeText + '\n```\n';
                    return;
                }

                // Inline code
                if (tag === 'code') {
                    if (!node.closest('pre')) {
                        markdown += '`' + node.textContent + '`';
                        return;
                    }
                }

                // Bold
                if (tag === 'strong' || tag === 'b') {
                    markdown += '**';
                    for (const child of node.childNodes) walk(child);
                    markdown += '**';
                    return;
                }

                // Italics
                if (tag === 'em' || tag === 'i') {
                    markdown += '*';
                    for (const child of node.childNodes) walk(child);
                    markdown += '*';
                    return;
                }

                // Links
                if (tag === 'a') {
                    const href = node.getAttribute('href') || '';
                    const text = node.textContent || '';
                    if (href && text) {
                        markdown += '[' + text + '](' + href + ')';
                        return;
                    }
                }

                // Paragraphs, headers, list items
                if (tag === 'p') markdown += '\n';
                if (tag === 'br') markdown += '\n';
                if (tag === 'h1') markdown += '\n# ';
                if (tag === 'h2') markdown += '\n## ';
                if (tag === 'h3') markdown += '\n### ';
                if (tag === 'h4') markdown += '\n#### ';
                if (tag === 'h5') markdown += '\n##### ';
                if (tag === 'h6') markdown += '\n###### ';
                if (tag === 'li') markdown += '\n* ';

                // Images
                if (tag === 'img') {
                    const src = node.getAttribute('src') || '';
                    const alt = node.getAttribute('alt') || 'image';
                    if (src && !src.includes('avatar') && !src.includes('profile')) {
                        if (processedSrcs.has(src)) return;
                        processedSrcs.add(src);
                        markdown += '\n![' + alt + '](' + src + ')\n';
                        return;
                    }
                }

                for (const child of node.childNodes) {
                    walk(child);
                }

                if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'].includes(tag)) {
                    markdown += '\n';
                }
            };

            walk(element);
            return markdown.trim().replace(/\n{3,}/g, '\n\n');
        };
        
        return elementToMarkdown(turn);
    }"#
    .replace("__LATEST_SELECTOR__", &latest_selector)
    .replace("__CONTENT_SELECTOR__", &content_selector);

    let res = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({
            "function": inspect_js
        }),
    )?;

    let val = parse_script_result(&res)?;
    let content = val
        .as_str()
        .ok_or_else(|| "DOM scraper returned non-string result".to_string())?
        .to_string();

    if content == "No assistant message found" {
        return Err(format!(
            "No assistant message found on {} page",
            provider.display_name()
        ));
    }

    Ok(content)
}

fn download_images_from_latest_message(
    config_path: &str,
    provider: Provider,
    image_output: Option<&str>,
    verified_response: Option<(&ResponseBaseline, &VerifiedResponseIdentity)>,
    verbose: bool,
) -> Result<usize, ImageDownloadError> {
    if verbose {
        println!("Checking for generated images in the latest assistant response...");
    }
    let latest_selector = serde_json::to_string(provider.latest_response_selector())
        .map_err(|e| format!("Failed to serialize response selector: {}", e))?;
    let assistant_selector = serde_json::to_string(provider.assistant_selector())
        .map_err(|e| format!("Failed to serialize assistant selector: {}", e))?;
    let user_selector = serde_json::to_string(provider.user_selector())
        .map_err(|e| format!("Failed to serialize user selector: {}", e))?;
    let expected_identity = match verified_response {
        Some((baseline, identity)) => serde_json::json!({
            "ownership_token": baseline.ownership_token,
            "conversation_id": identity.conversation_id,
            "turn_id": identity.turn_id,
            "artifact_ids": identity.artifact_ids,
            "user_count": identity.user_count,
            "assistant_count": identity.assistant_count,
        }),
        None => Value::Null,
    };
    let expected_identity_json = serde_json::to_string(&expected_identity)
        .map_err(|_| "Failed to serialize verified response identity".to_string())?;
    let image_scan_js = r#"() => {
                window.__downloaded_images_status = "pending";
                window.__downloaded_images = null;
                (async () => {
                    try {
                        const latestSelector = __LATEST_SELECTOR__;
                        const assistantSelector = __ASSISTANT_SELECTOR__;
                        const userSelector = __USER_SELECTOR__;
                        const expectedIdentity = __EXPECTED_IDENTITY__;
                        const minimumImageDimension = __MINIMUM_IMAGE_DIMENSION__;
                        const stopSelectors = __STOP_SELECTORS__;
                        const isVisibleControl = (element) => {
                            if (!element) return false;
                            const style = window.getComputedStyle(element);
                            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                            const rect = element.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                        };
                        const conversationId = (() => {
                            const match = window.location.pathname.match(/^\/c\/([^/?#]+)/);
                            return match ? `conversation:${match[1]}` : `home:${window.location.origin}`;
                        })();
                        const semanticIdentity = (element) => {
                            const turn = element
                                ? (element.closest('section[data-turn="assistant"][data-turn-id]') ||
                                    element.closest('[data-turn="assistant"][data-turn-id]') || element)
                                : null;
                            const turnId = turn?.getAttribute('data-turn-id') || '';
                            const artifactIds = turn
                                ? Array.from(turn.querySelectorAll('[id^="image-"]'))
                                    .map((candidate) => candidate.id)
                                    .filter(Boolean)
                                    .filter((id, index, all) => all.indexOf(id) === index)
                                    .sort()
                                : [];
                            return { turnId, artifactIds };
                        };
                        const responseState = () => {
                            const assistantMessages = Array.from(document.querySelectorAll(assistantSelector));
                            const userMessages = Array.from(document.querySelectorAll(userSelector));
                            const latestMessages = expectedIdentity
                                ? assistantMessages
                                : Array.from(document.querySelectorAll(latestSelector));
                            const latestMessage = latestMessages[latestMessages.length - 1] || null;
                            if (!expectedIdentity) return { ok: true, latestMessage };
                            const identity = semanticIdentity(latestMessage);
                            const generationControl = stopSelectors
                                .map((selector) => document.querySelector(selector))
                                .find(isVisibleControl);
                            const ok =
                                window.__ask_bridge_response_owner_v1 === expectedIdentity.ownership_token &&
                                conversationId === expectedIdentity.conversation_id &&
                                (!expectedIdentity.turn_id || identity.turnId === expectedIdentity.turn_id) &&
                                (expectedIdentity.artifact_ids.length === 0 ||
                                    JSON.stringify(identity.artifactIds) === JSON.stringify(expectedIdentity.artifact_ids)) &&
                                userMessages.length === expectedIdentity.user_count &&
                                assistantMessages.length === expectedIdentity.assistant_count &&
                                !generationControl;
                            return { ok, latestMessage };
                        };
                        const before = responseState();
                        if (!before.ok) {
                            window.__downloaded_images_status = "error: response_identity_changed";
                            return;
                        }
                        const latestMessage = before.latestMessage;
                        if (!latestMessage) {
                            window.__downloaded_images = [];
                            window.__downloaded_images_status = "success";
                            return;
                        }
                        
                        const imgs = Array.from(latestMessage.querySelectorAll('img'));
                        const seenSrcs = new Set();
                        const candidateImgs = imgs.filter(img => {
                            const src = img.src || '';
                            if (src.includes('avatar') || src.includes('profile')) return false;
                            if (!img.complete || img.naturalWidth < minimumImageDimension || img.naturalHeight < minimumImageDimension) return false;
                            if (!src.startsWith('http') && !src.startsWith('blob:') && !src.startsWith('data:image/')) return false;
                            if (seenSrcs.has(src)) return false;
                            seenSrcs.add(src);
                            return true;
                        });

                        const imagesData = [];
                        let failedCount = 0;
                        for (let i = 0; i < candidateImgs.length; i++) {
                            const img = candidateImgs[i];
                            try {
                                let dataUrl = "";
                                if ((img.src || '').startsWith('data:image/')) {
                                    dataUrl = img.src;
                                } else {
                                    try {
                                        const response = await fetch(img.src);
                                        if (!response.ok) throw new Error('image_fetch_failed');
                                        const blob = await response.blob();
                                        if (!blob.type.startsWith('image/')) throw new Error('image_type_invalid');
                                        dataUrl = await new Promise((resolve, reject) => {
                                            const reader = new FileReader();
                                            reader.onloadend = () => resolve(reader.result);
                                            reader.onerror = reject;
                                            reader.readAsDataURL(blob);
                                        });
                                    } catch (fetchErr) {
                                        const canvas = document.createElement('canvas');
                                        canvas.width = img.naturalWidth || img.width || 512;
                                        canvas.height = img.naturalHeight || img.height || 512;
                                        const ctx = canvas.getContext('2d');
                                        ctx.drawImage(img, 0, 0);
                                        dataUrl = canvas.toDataURL('image/png');
                                    }
                                }

                                if (dataUrl && dataUrl.startsWith('data:image/')) {
                                    imagesData.push({
                                        index: i,
                                        dataUrl: dataUrl
                                    });
                                } else {
                                    failedCount += 1;
                                }
                            } catch (_) {
                                failedCount += 1;
                            }
                        }
                        const after = responseState();
                        if (!after.ok) {
                            window.__downloaded_images_status = "error: response_identity_changed";
                            return;
                        }
                        if (failedCount > 0) {
                            window.__downloaded_images_status = "error: image_download_failed";
                            return;
                        }
                        window.__downloaded_images = imagesData;
                        window.__downloaded_images_status = "success";
                    } catch (_) {
                        window.__downloaded_images_status = "error: image_download_failed";
                    }
                })();
                return { ok: true };
            }"#
    .replace("__LATEST_SELECTOR__", &latest_selector)
    .replace("__ASSISTANT_SELECTOR__", &assistant_selector)
    .replace("__USER_SELECTOR__", &user_selector)
    .replace("__EXPECTED_IDENTITY__", &expected_identity_json)
    .replace("__STOP_SELECTORS__", provider.stop_button_selectors_json())
    .replace(
        "__MINIMUM_IMAGE_DIMENSION__",
        &GENERATED_IMAGE_MIN_DIMENSION.to_string(),
    );

    let start_res = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({
            "function": image_scan_js
        }),
    )?;

    let start_parsed = parse_script_result(&start_res)?;
    if !start_parsed["ok"].as_bool().unwrap_or(false) {
        return Err(ImageDownloadError::DownloadFailed(
            "Failed to initiate image scanning script".to_string(),
        ));
    }

    let mut wait_cycles = 0;
    let mut status = String::from("pending");
    while status == "pending" && wait_cycles < 150 {
        thread::sleep(Duration::from_millis(100));
        let check_res = call_mcp_tool(
            config_path,
            "evaluate_script",
            serde_json::json!({
                "function": "() => window.__downloaded_images_status || 'pending'"
            }),
        )?;
        if let Some(s) = parse_script_result(&check_res)
            .ok()
            .and_then(|p| p.as_str().map(|str_ref| str_ref.to_string()))
        {
            status = s;
        }
        wait_cycles += 1;
    }

    if status.starts_with("error:") {
        return if status == "error: response_identity_changed" {
            Err(ImageDownloadError::ResponseIdentityChanged)
        } else {
            Err(ImageDownloadError::DownloadFailed(
                "Image scanning failed for the verified response".to_string(),
            ))
        };
    }

    if status == "pending" {
        return Err(ImageDownloadError::DownloadFailed(
            "Timed out waiting for images to download in browser".to_string(),
        ));
    }

    let get_res = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({
            "function": r#"() => {
                const res = window.__downloaded_images || [];
                delete window.__downloaded_images;
                delete window.__downloaded_images_status;
                return res;
            }"#
        }),
    )?;

    let parsed = parse_script_result(&get_res)?;
    let images = match parsed.as_array() {
        Some(arr) => arr,
        None => {
            return Err(ImageDownloadError::DownloadFailed(
                "Image scanner returned an invalid result".to_string(),
            ));
        }
    };

    if images.is_empty() {
        if verbose {
            println!("No generated images found in the latest response.");
        }
        return Ok(0);
    }

    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let total = images.len();
    let mut saved_count = 0usize;
    for (idx, img) in images.iter().enumerate() {
        let data_url = img["dataUrl"]
            .as_str()
            .ok_or_else(|| "Downloaded image result was incomplete".to_string())?;
        let (header, base64_data) = data_url
            .split_once(',')
            .ok_or_else(|| "Downloaded image data was malformed".to_string())?;
        if !header.starts_with("data:image/") {
            return Err(ImageDownloadError::DownloadFailed(
                "Downloaded image data had an invalid media type".to_string(),
            ));
        }

        let ext = if header.contains("image/png") {
            "png"
        } else if header.contains("image/jpeg") || header.contains("image/jpg") {
            "jpg"
        } else if header.contains("image/webp") {
            "webp"
        } else {
            "png"
        };

        let decoded = general_purpose::STANDARD
            .decode(base64_data)
            .map_err(|e| format!("Failed to decode base64 data: {}", e))?;

        let file_path = match image_output {
            Some(output_str) => {
                let path = std::path::Path::new(output_str);
                let is_dir = path.is_dir()
                    || output_str.ends_with('/')
                    || output_str.ends_with('\\')
                    || path.extension().is_none();

                if is_dir {
                    std::fs::create_dir_all(path)
                        .map_err(|e| format!("Failed to create directory {:?}: {}", path, e))?;
                    path.join(format!("generated_{}_{}.{}", epoch, idx, ext))
                } else {
                    let parent = path.parent().unwrap_or_else(|| std::path::Path::new(""));
                    if !parent.as_os_str().is_empty() {
                        std::fs::create_dir_all(parent).map_err(|e| {
                            format!("Failed to create parent directory {:?}: {}", parent, e)
                        })?;
                    }
                    let file_stem = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .ok_or_else(|| "Invalid file name".to_string())?;
                    let file_ext = path.extension().and_then(|e| e.to_str()).unwrap_or(ext);

                    if total <= 1 {
                        parent.join(format!("{}.{}", file_stem, file_ext))
                    } else {
                        parent.join(format!("{}_{}.{}", file_stem, idx + 1, file_ext))
                    }
                }
            }
            None => {
                std::fs::create_dir_all("target")
                    .map_err(|e| format!("Failed to create target/ directory: {}", e))?;
                std::path::PathBuf::from(format!("target/generated_{}_{}.{}", epoch, idx, ext))
            }
        };

        std::fs::write(&file_path, decoded)
            .map_err(|e| format!("Failed to write image file {:?}: {}", file_path, e))?;
        saved_count = saved_count.saturating_add(1);

        println!(
            "Downloaded and saved generated image to: {}",
            file_path.to_string_lossy()
        );
    }

    Ok(saved_count)
}

/// Display an image in the terminal using kitty's icat protocol.
/// Silently skips if kitty icat is not available.
fn display_image_in_terminal(image_path: &str) {
    let _ = Command::new("kitty").args(["icat", image_path]).status();
}

fn summarize_attachments(
    image_paths: &[String],
    file_paths: &[String],
) -> Result<AttachmentSummary, String> {
    let mut file_names = Vec::with_capacity(image_paths.len() + file_paths.len());
    let mut total_bytes = 0u64;
    for path in image_paths.iter().chain(file_paths.iter()) {
        let metadata = std::fs::metadata(path)
            .map_err(|_| "無法讀取其中一個附件；尚未開啟 provider 分頁".to_string())?;
        if !metadata.is_file() {
            return Err("附件必須是 regular file；尚未開啟 provider 分頁".to_string());
        }
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "附件總大小超出可表示範圍".to_string())?;
        let file_name = Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "附件檔名不是有效 UTF-8".to_string())?;
        file_names.push(file_name.to_string());
    }
    Ok(AttachmentSummary {
        file_names,
        total_bytes,
    })
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct AttachmentProbe {
    expected_count: usize,
    observed_count: usize,
    missing_count: usize,
    unexpected_count: usize,
    uploading: bool,
    has_error: bool,
    complete: bool,
}

/// Typed expectations for a mixed (document + image) attachment upload.
///
/// Images in ChatGPT's composer do not expose their original filename in the
/// DOM, so the legacy exact-filename multiset verifier cannot confirm them.
/// This typed model separates document evidence (filename chip) from image
/// evidence (preview count delta relative to a baseline + non-zero natural
/// dimensions).
#[derive(Clone, Debug)]
struct AttachmentExpectations {
    document_names: Vec<String>,
    image_count: usize,
}

impl AttachmentExpectations {
    fn new(file_paths: &[String], image_paths: &[String]) -> Result<Self, String> {
        let mut document_names = Vec::with_capacity(file_paths.len());
        for path in file_paths {
            let name = Path::new(path)
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|n| !n.is_empty())
                .ok_or_else(|| "附件檔名不是有效 UTF-8".to_string())?;
            document_names.push(name.to_string());
        }
        Ok(Self {
            document_names,
            image_count: image_paths.len(),
        })
    }
}

/// Typed DOM probe result for mixed attachment verification.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct TypedAttachmentProbe {
    document_count: usize,
    image_count: usize,
    image_loaded: bool,
    uploading: bool,
    provider_error: bool,
}

/// Sanitized receipt diagnostics for a typed attachment probe.  Contains only
/// count/enum-safe fields — no filenames, paths, DOM text or prompts.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct AttachmentProbeSummary {
    mode: &'static str,
    failure_stage: Option<String>,
    failure_reason: Option<String>,
    expected_documents: usize,
    observed_documents: usize,
    expected_images: usize,
    observed_images: usize,
    missing_documents: usize,
    unexpected_documents: usize,
    uploading: bool,
    provider_error: bool,
}

impl AttachmentProbeSummary {
    fn new(expectations: &AttachmentExpectations, probe: &TypedAttachmentProbe) -> Self {
        Self {
            mode: "typed_mixed_v1",
            failure_stage: None,
            failure_reason: None,
            expected_documents: expectations.document_names.len(),
            observed_documents: probe.document_count,
            expected_images: expectations.image_count,
            observed_images: probe.image_count,
            missing_documents: expectations
                .document_names
                .len()
                .saturating_sub(probe.document_count),
            unexpected_documents: probe
                .document_count
                .saturating_sub(expectations.document_names.len()),
            uploading: probe.uploading,
            provider_error: probe.provider_error,
        }
    }

    fn with_failure(mut self, stage: &str, reason: &str) -> Self {
        self.failure_stage = Some(stage.to_string());
        self.failure_reason = Some(reason.to_string());
        self
    }
}

struct TypedAttachmentTracker {
    expected_documents: usize,
    expected_images: usize,
    stable_probes: usize,
}

impl TypedAttachmentTracker {
    fn new(expectations: &AttachmentExpectations) -> Self {
        Self {
            expected_documents: expectations.document_names.len(),
            expected_images: expectations.image_count,
            stable_probes: 0,
        }
    }

    fn observe(
        &mut self,
        probe: &TypedAttachmentProbe,
        _expectations: &AttachmentExpectations,
    ) -> Result<bool, String> {
        if probe.provider_error {
            return Err("provider_error".to_string());
        }
        if probe.uploading {
            self.stable_probes = 0;
            return Ok(false);
        }
        let docs_ok = probe.document_count == self.expected_documents;
        let images_ok = probe.image_count == self.expected_images && probe.image_loaded;
        if docs_ok && images_ok {
            self.stable_probes += 1;
            return Ok(self.stable_probes >= ATTACHMENT_REQUIRED_STABLE_PROBES);
        }
        self.stable_probes = 0;
        Ok(false)
    }
}

struct AttachmentVerificationTracker {
    expected_count: usize,
    stable_complete_probes: usize,
}

impl AttachmentVerificationTracker {
    fn new(expected_count: usize) -> Self {
        Self {
            expected_count,
            stable_complete_probes: 0,
        }
    }

    fn observe(&mut self, probe: AttachmentProbe) -> Result<bool, String> {
        if probe.expected_count != self.expected_count {
            return Err("附件 DOM probe 回報的預期數量不一致".to_string());
        }
        if probe.has_error {
            return Err(ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string());
        }
        let ready = probe.complete
            && !probe.uploading
            && probe.observed_count == self.expected_count
            && probe.missing_count == 0
            && probe.unexpected_count == 0;
        if !ready {
            self.stable_complete_probes = 0;
            return Ok(false);
        }
        self.stable_complete_probes += 1;
        Ok(self.stable_complete_probes >= ATTACHMENT_REQUIRED_STABLE_PROBES)
    }
}

fn build_attachment_probe_script(
    provider: Provider,
    expected_file_names: &[String],
) -> Result<String, String> {
    let expected_names = serde_json::to_string(expected_file_names)
        .map_err(|_| "無法建立附件驗證 probe".to_string())?;
    let script = r#"() => {
        const expectedNames = __EXPECTED_NAMES__;
        const composerSelectors = __COMPOSER_SELECTORS__;
        const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                rect.width > 0 &&
                rect.height > 0;
        };
        const composer = composerSelectors.map((selector) => document.querySelector(selector)).find(Boolean);
        if (!composer) {
            return {
                expected_count: expectedNames.length,
                observed_count: 0,
                missing_count: expectedNames.length,
                unexpected_count: 0,
                uploading: false,
                has_error: true,
                complete: false
            };
        }
        const root = composer.closest('[data-testid*="composer"]') ||
            composer.closest('form') ||
            composer.parentElement?.parentElement?.parentElement ||
            composer.parentElement ||
            document.body;
        const candidateSelector = [
            '[data-testid*="attachment"]',
            '[data-testid*="file-chip"]',
            '[data-testid*="file-pill"]',
            '[data-testid*="file-preview"]',
            '[data-testid*="file-thumbnail"]',
            '[class*="attachment"]',
            '[class*="file-tile"]',
            '[class*="file-chip"]',
            '[class*="file-pill"]',
            '[class*="file-preview"]',
            '[class*="file-thumbnail"]',
            '[aria-label*="attachment" i]'
        ].join(',');
        const textFor = (el) => [
            el.innerText,
            el.textContent,
            el.getAttribute('aria-label'),
            el.getAttribute('title')
        ].filter(Boolean).join(' ').trim();
        const candidates = Array.from(root.querySelectorAll(candidateSelector)).filter(isVisible);
        const leaves = candidates.filter((candidate) =>
            !candidates.some((other) => other !== candidate && candidate.contains(other))
        );
        const filteredLeaves = leaves.filter((l) => {
            const ariaLabel = (l.getAttribute('aria-label') || '').toLowerCase();
            return !ariaLabel.startsWith('移除') && !ariaLabel.startsWith('remove');
        });
        const expectedCounts = new Map();
        for (const name of expectedNames) {
            expectedCounts.set(name, (expectedCounts.get(name) || 0) + 1);
        }
        const observedCounts = new Map();
        let unmatchedVisibleCandidates = 0;
        for (const candidate of filteredLeaves) {
            const text = textFor(candidate);
            const matches = Array.from(expectedCounts.keys())
                .filter((name) => text.includes(name))
                .sort((left, right) => right.length - left.length);
            if (matches.length > 0) {
                const name = matches[0];
                observedCounts.set(name, (observedCounts.get(name) || 0) + 1);
            } else {
                unmatchedVisibleCandidates += 1;
            }
        }
        if (observedCounts.size === 0) {
            const rootText = root.innerText || root.textContent || '';
            for (const [name] of expectedCounts) {
                let count = 0;
                let offset = 0;
                while (name && (offset = rootText.indexOf(name, offset)) !== -1) {
                    count += 1;
                    offset += name.length;
                }
                if (count > 0) observedCounts.set(name, count);
            }
            unmatchedVisibleCandidates = 0;
        }
        let missingCount = 0;
        let unexpectedCount = unmatchedVisibleCandidates;
        let observedCount = unmatchedVisibleCandidates;
        for (const [name, expected] of expectedCounts) {
            const observed = observedCounts.get(name) || 0;
            observedCount += observed;
            missingCount += Math.max(0, expected - observed);
            unexpectedCount += Math.max(0, observed - expected);
        }
        const uploadingState = Array.from(root.querySelectorAll(
            '[aria-busy="true"], [role="progressbar"], [data-state*="uploading" i], [data-status*="uploading" i], [data-testid*="progress" i]'
        )).some(isVisible);
        const uploadingText = filteredLeaves.some((candidate) =>
            /uploading|upload in progress|上傳中|正在上傳|上传中|正在上传/i.test(textFor(candidate))
        );
        const errorState = Array.from(root.querySelectorAll(
            '[data-state="error"], [data-status="error"], [data-testid*="upload-error" i], [aria-label*="upload failed" i]'
        )).some(isVisible);
        const errorText = filteredLeaves.some((candidate) =>
            /upload failed|failed to upload|上傳失敗|上传失败/i.test(textFor(candidate))
        );
        const uploading = uploadingState || uploadingText;
        const hasError = errorState || errorText;
        const complete = missingCount === 0 &&
            unexpectedCount === 0 &&
            observedCount === expectedNames.length &&
            !uploading &&
            !hasError;
        return {
            expected_count: expectedNames.length,
            observed_count: observedCount,
            missing_count: missingCount,
            unexpected_count: unexpectedCount,
            uploading,
            has_error: hasError,
            complete
        };
    }"#
    .replace("__EXPECTED_NAMES__", &expected_names)
    .replace(
        "__COMPOSER_SELECTORS__",
        provider.composer_selectors_json(),
    );
    Ok(script)
}

fn verify_attachment_completion(
    config_path: &str,
    provider: Provider,
    expected_file_names: &[String],
    verbose: bool,
) -> Result<(), String> {
    if expected_file_names.is_empty() {
        return Ok(());
    }
    let script = build_attachment_probe_script(provider, expected_file_names)?;
    let verify_timeout = attachment_verify_timeout_for_count(expected_file_names.len());
    let deadline = McpOperationDeadline::from_timeout(verify_timeout)
        .map_err(|_| ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string())?;
    let mut tracker = AttachmentVerificationTracker::new(expected_file_names.len());
    loop {
        let response = call_mcp_tool_with_deadline(
            config_path,
            "evaluate_script",
            serde_json::json!({ "function": script }),
            Some(deadline),
        )
        .map_err(|_| ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string())?;
        let value = parse_script_result(&response)
            .map_err(|_| ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string())?;
        let probe: AttachmentProbe = serde_json::from_value(value)
            .map_err(|_| ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string())?;
        if tracker.observe(probe)? {
            if verbose {
                println!(
                    "{} verified {} attachment(s).",
                    provider.display_name(),
                    expected_file_names.len()
                );
            }
            return Ok(());
        }
        let remaining = deadline
            .phase_timeout(verify_timeout, "attachment verification poll")
            .map_err(|_| ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string())?;
        if remaining <= ATTACHMENT_VERIFY_POLL_INTERVAL {
            return Err(ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string());
        }
        thread::sleep(ATTACHMENT_VERIFY_POLL_INTERVAL);
    }
}

/// Build a JS probe that counts document chips by filename and image previews
/// by non-zero natural dimensions.  Image previews in ChatGPT do not expose
/// their original filename, so we count visible ``<img>`` elements inside the
/// composer root whose naturalWidth/naturalHeight are positive.
fn build_typed_attachment_probe_script(
    provider: Provider,
    expected_document_names: &[String],
) -> Result<String, String> {
    let expected_names = serde_json::to_string(expected_document_names)
        .map_err(|_| "無法建立 typed 附件驗證 probe".to_string())?;
    let script = r#"() => {
        const expectedNames = __EXPECTED_NAMES__;
        const composerSelectors = __COMPOSER_SELECTORS__;
        const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                rect.width > 0 &&
                rect.height > 0;
        };
        const composer = composerSelectors.map((s) => document.querySelector(s)).find(Boolean);
        if (!composer) {
            return { document_count: 0, image_count: 0, image_loaded: false, uploading: false, provider_error: false };
        }
        const root = composer.closest('[data-testid*="composer"]') ||
            composer.closest('form') ||
            composer.parentElement?.parentElement?.parentElement ||
            composer.parentElement ||
            document.body;
        // ChatGPT file attachments use class "group/file-tile" (and legacy
        // data-testid/class patterns).  Each tile's textContent contains the
        // filename.  Image tiles contain an <img> with positive natural
        // dimensions but no filename text.
        const docSelector = [
            '[class*="file-tile"]',
            '[data-testid*="file-chip"]',
            '[data-testid*="file-pill"]',
            '[data-testid*="file-preview"]',
            '[data-testid*="file-thumbnail"]',
            '[class*="file-chip"]',
            '[class*="file-pill"]',
            '[class*="file-preview"]',
            '[class*="file-thumbnail"]'
        ].join(',');
        const allTiles = Array.from(root.querySelectorAll(docSelector)).filter(isVisible);
        // Only keep tiles that are leaf-level (no child tile inside them).
        const docCandidates = allTiles.filter((t) =>
            !allTiles.some((o) => o !== t && t.contains(o))
        ).filter((l) => {
            const ariaLabel = (l.getAttribute('aria-label') || '').toLowerCase();
            return !ariaLabel.startsWith('移除') && !ariaLabel.startsWith('remove');
        });
        const textFor = (el) => [
            el.innerText, el.textContent,
            el.getAttribute('aria-label'), el.getAttribute('title')
        ].filter(Boolean).join(' ').trim();
        const expectedCounts = new Map();
        for (const name of expectedNames) {
            expectedCounts.set(name, (expectedCounts.get(name) || 0) + 1);
        }
        const observedCounts = new Map();
        let documentCount = 0;
        // A tile counts as a document if its text contains one of the
        // expected filenames.  Otherwise it's an image tile.
        for (const candidate of docCandidates) {
            const text = textFor(candidate);
            const matches = Array.from(expectedCounts.keys())
                .filter((name) => text.includes(name))
                .sort((a, b) => b.length - a.length);
            if (matches.length > 0) {
                const name = matches[0];
                const prev = observedCounts.get(name) || 0;
                observedCounts.set(name, prev + 1);
                documentCount += 1;
            }
        }
        // Count image previews: visible <img> inside the composer root with
        // positive natural dimensions.  These are the ChatGPT image-attachment
        // thumbnails that do not expose a filename.
        const imgCandidates = Array.from(root.querySelectorAll('img')).filter(isVisible);
        let imageCount = 0;
        let imageLoaded = false;
        for (const img of imgCandidates) {
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                imageCount += 1;
                imageLoaded = true;
            }
        }
        const uploadingState = Array.from(root.querySelectorAll(
            '[aria-busy="true"], [role="progressbar"], [data-state*="uploading" i], [data-status*="uploading" i]'
        )).some(isVisible);
        const uploadingText = docCandidates.some((c) =>
            /uploading|upload in progress|上傳中|正在上傳/i.test(textFor(c))
        );
        const errorState = Array.from(root.querySelectorAll(
            '[data-state="error"], [data-status="error"], [data-testid*="upload-error" i]'
        )).some(isVisible);
        const errorText = docCandidates.some((c) =>
            /upload failed|failed to upload|上傳失敗/i.test(textFor(c))
        );
        return {
            document_count: documentCount,
            image_count: imageCount,
            image_loaded: imageLoaded,
            uploading: uploadingState || uploadingText,
            provider_error: errorState || errorText
        };
    }"#
    .replace("__EXPECTED_NAMES__", &expected_names)
    .replace("__COMPOSER_SELECTORS__", provider.composer_selectors_json());
    Ok(script)
}

/// Verify a mixed (document + image) attachment upload using typed evidence:
/// document chips matched by filename, image previews matched by count
/// delta and non-zero natural dimensions.  Returns a sanitized summary.
fn verify_typed_attachment_completion(
    config_path: &str,
    provider: Provider,
    expectations: &AttachmentExpectations,
    verbose: bool,
) -> Result<AttachmentProbeSummary, String> {
    if expectations.document_names.is_empty() && expectations.image_count == 0 {
        return Ok(AttachmentProbeSummary {
            mode: "typed_mixed_v1",
            failure_stage: None,
            failure_reason: None,
            expected_documents: 0,
            observed_documents: 0,
            expected_images: 0,
            observed_images: 0,
            missing_documents: 0,
            unexpected_documents: 0,
            uploading: false,
            provider_error: false,
        });
    }
    let script = build_typed_attachment_probe_script(provider, &expectations.document_names)?;
    let total_count = expectations.document_names.len() + expectations.image_count;
    let verify_timeout = attachment_verify_timeout_for_count(total_count);
    let deadline = McpOperationDeadline::from_timeout(verify_timeout)
        .map_err(|_| ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string())?;
    let mut tracker = TypedAttachmentTracker::new(expectations);
    loop {
        let response = call_mcp_tool_with_deadline(
            config_path,
            "evaluate_script",
            serde_json::json!({ "function": script }),
            Some(deadline),
        )
        .map_err(|_| ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string())?;
        let value = parse_script_result(&response)
            .map_err(|_| ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string())?;
        let probe: TypedAttachmentProbe = serde_json::from_value(value)
            .map_err(|_| ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string())?;
        match tracker.observe(&probe, expectations) {
            Ok(true) => {
                if verbose {
                    println!(
                        "{} verified {} document(s) and {} image(s).",
                        provider.display_name(),
                        expectations.document_names.len(),
                        expectations.image_count
                    );
                }
                return Ok(AttachmentProbeSummary::new(expectations, &probe));
            }
            Ok(false) => {}
            Err(reason) => {
                let _summary = AttachmentProbeSummary::new(expectations, &probe)
                    .with_failure("verification", &reason);
                return Err(format!(
                    "{}:{}",
                    ATTACHMENT_VERIFICATION_FAILURE_CODE, reason
                ));
            }
        }
        let remaining = deadline
            .phase_timeout(verify_timeout, "typed attachment verification poll")
            .map_err(|_| ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string())?;
        if remaining <= ATTACHMENT_VERIFY_POLL_INTERVAL {
            return Err(format!(
                "{}:verification_timeout",
                ATTACHMENT_VERIFICATION_FAILURE_CODE
            ));
        }
        thread::sleep(ATTACHMENT_VERIFY_POLL_INTERVAL);
    }
}

fn upload_attachments_via_file_chooser(
    config_path: &str,
    provider: Provider,
    image_paths: &[String],
    file_paths: &[String],
    verbose: bool,
) -> Result<(), String> {
    let total = image_paths.len() + file_paths.len();
    for (index, path) in image_paths.iter().chain(file_paths.iter()).enumerate() {
        let canonical_path = std::fs::canonicalize(path)
            .map_err(|_| "Failed to resolve an attachment for native upload".to_string())?;
        let file_path = canonical_path.to_string_lossy().to_string();

        let snapshot = take_snapshot_text(config_path)
            .map_err(|_| "Native attachment upload menu was unavailable".to_string())?;
        let menu_uid = match provider {
            Provider::Gemini => {
                find_snapshot_uid(&snapshot, &["上傳與工具"], &["更多", "雲端", "drive"])
                    .or_else(|| find_snapshot_uid(&snapshot, &["upload"], &["drive"]))
            }
            Provider::ChatGpt => find_snapshot_uid(&snapshot, &["attach"], &["settings", "menu"]),
            Provider::Claude => find_snapshot_uid(&snapshot, &["attach"], &["settings", "menu"])
                .or_else(|| find_snapshot_uid(&snapshot, &["upload"], &["drive"])),
        }
        .ok_or_else(|| {
            format!(
                "Could not find {} upload menu in page snapshot",
                provider.display_name()
            )
        })?;

        call_mcp_tool(
            config_path,
            "click",
            serde_json::json!({
                "uid": menu_uid,
                "includeSnapshot": false
            }),
        )
        .map_err(|_| "Native attachment upload menu did not open".to_string())?;
        thread::sleep(Duration::from_millis(500));

        let snapshot = take_snapshot_text(config_path)
            .map_err(|_| "Native attachment upload chooser was unavailable".to_string())?;
        let upload_uid = match provider {
            Provider::Gemini => find_snapshot_uid(&snapshot, &["上傳檔案"], &["雲端", "drive"])
                .or_else(|| find_snapshot_uid(&snapshot, &["upload", "file"], &["drive"])),
            Provider::ChatGpt => find_snapshot_uid(&snapshot, &["file"], &["drive", "connect"]),
            Provider::Claude => {
                find_snapshot_uid(&snapshot, &["upload", "file"], &["drive", "connect"])
                    .or_else(|| find_snapshot_uid(&snapshot, &["file"], &["drive", "connect"]))
            }
        }
        .unwrap_or_else(|| menu_uid.clone());

        if verbose {
            println!(
                "Uploading attachment {}/{} to {} with the native file chooser...",
                index + 1,
                total,
                provider.display_name(),
            );
        }
        call_mcp_tool(
            config_path,
            "upload_file",
            serde_json::json!({
                "uid": upload_uid,
                "filePath": file_path,
                "includeSnapshot": false
            }),
        )
        .map_err(|_| "Native attachment upload did not start".to_string())?;
    }

    Ok(())
}

fn run_native_then_fallback<Native, Fallback>(
    native: Native,
    fallback: Fallback,
) -> Result<(), String>
where
    Native: FnOnce() -> Result<(), String>,
    Fallback: FnOnce() -> Result<(), String>,
{
    match native() {
        Ok(()) => Ok(()),
        Err(_) => {
            fallback()?;
            Ok(())
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DocumentUploadPolicy {
    NativeThenDataTransferFallback,
    DataTransferOnly,
}

fn document_upload_policy(provider: Provider) -> DocumentUploadPolicy {
    match provider {
        Provider::ChatGpt | Provider::Claude => {
            DocumentUploadPolicy::NativeThenDataTransferFallback
        }
        Provider::Gemini => DocumentUploadPolicy::DataTransferOnly,
    }
}

/// Map a file extension to a MIME type. Covers common image and document formats.
/// `ext` is expected to already be lowercased by the caller.
fn mime_type_for_extension(ext: &str) -> &'static str {
    match ext {
        // Images
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        // Documents
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "odp" => "application/vnd.oasis.opendocument.presentation",
        "rtf" => "application/rtf",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "json" => "application/json",
        "yaml" | "yml" => "text/yaml",
        "ts" => "text/typescript",
        "tsx" => "text/typescript",
        "js" | "mjs" | "cjs" => "text/javascript",
        "jsx" => "text/javascript",
        "css" => "text/css",
        "py" => "text/x-python",
        "rb" => "text/x-ruby",
        "go" => "text/x-go",
        "rs" => "text/x-rust",
        "java" => "text/x-java",
        "kt" => "text/x-kotlin",
        "c" => "text/x-c",
        "h" => "text/x-c",
        "cpp" | "cc" | "cxx" => "text/x-c++",
        "hpp" => "text/x-c++",
        "cs" => "text/x-csharp",
        "swift" => "text/x-swift",
        "php" => "text/x-php",
        "sh" => "application/x-sh",
        "bash" => "application/x-sh",
        "zsh" => "application/x-sh",
        "sql" => "application/sql",
        "toml" => "application/toml",
        "ini" => "text/plain",
        "log" => "text/plain",
        // Archives
        "zip" => "application/zip",
        "gz" | "gzip" => "application/gzip",
        "tar" => "application/x-tar",
        "bz2" => "application/x-bzip2",
        "7z" => "application/x-7z-compressed",
        // Audio
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        // Video
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

/// Upload local image and/or document files to the provider prompt composer using the
/// best available provider-specific upload mechanism.
/// Returns an error string if any attachment fails to upload.
fn upload_attachments_via_data_transfer(
    config_path: &str,
    provider: Provider,
    image_paths: &[String],
    file_paths: &[String],
    verbose: bool,
) -> Result<(), String> {
    let total = image_paths.len() + file_paths.len();
    if total == 0 {
        return Ok(());
    }

    if verbose {
        println!(
            "Attaching {} attachment(s) ({} image(s), {} file(s)) to the prompt...",
            total,
            image_paths.len(),
            file_paths.len()
        );
    }

    // Build a JSON array of { name, mime, base64 } objects. Images first, then other files.
    // We pass raw base64 + mime and decode in JS to avoid `fetch(data:...)` which ChatGPT's
    // Content-Security-Policy blocks (results in "Failed to fetch").
    let mut files_json = Vec::new();
    for path in image_paths.iter().chain(file_paths.iter()) {
        let bytes = std::fs::read(path).map_err(|_| "Failed to read an attachment".to_string())?;
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mime = mime_type_for_extension(&ext);
        let b64 = general_purpose::STANDARD.encode(&bytes);
        let file_name = Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("attachment")
            .to_string();
        files_json.push(serde_json::json!({
            "name": file_name,
            "mime": mime,
            "base64": b64
        }));
    }

    let files_json_str = serde_json::to_string(&files_json)
        .map_err(|_| "Failed to serialize attachment data".to_string())?;
    let composer_selectors = provider.composer_selectors_json();
    // Build JS without raw strings to avoid r#"..."# termination conflicts
    let js = "() => {\n".to_string()
        + "    window.__upload_images_status = 'pending';\n"
        + "    (async () => {\n"
        + "        try {\n"
        + &format!("            const filesData = {};\n", files_json_str)
        + "            const decodeB64 = (b64) => {\n"
        + "                const bin = atob(b64);\n"
        + "                const len = bin.length;\n"
        + "                const bytes = new Uint8Array(len);\n"
        + "                for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);\n"
        + "                return bytes;\n"
        + "            };\n"
        + "            const fileObjects = filesData.map((f) => {\n"
        + "                const bytes = decodeB64(f.base64);\n"
        + "                const blob = new Blob([bytes], { type: f.mime || 'application/octet-stream' });\n"
        + "                return new File([blob], f.name, { type: blob.type });\n"
        + "            });\n"
        + &format!(
            "            const composerSelectors = {};\n",
            composer_selectors
        )
        + "            const el = composerSelectors.map((s) => document.querySelector(s)).find(Boolean);\n"
        + "            if (!el) {\n"
        + "                window.__upload_images_status = 'error: composer not found';\n"
        + "                return;\n"
        + "            }\n"
        + "            el.focus();\n"
        + "            const fileInputs = Array.from(document.querySelectorAll('input[type=\"file\"]'));\n"
        + "            // Pick the file input whose `accept` attribute covers every attached file.\n"
        + "            // An input accepts a file when accept is empty, contains `*/*` or a matching\n"
        + "            // wildcard (e.g. `image/*`), or lists the file's exact MIME type.\n"
        + "            const accepts = (input, file) => {\n"
        + "                const acc = (input.getAttribute('accept') || '').trim();\n"
        + "                if (!acc) return true;\n"
        + "                const parts = acc.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);\n"
        + "                const mime = (file.type || '').toLowerCase();\n"
        + "                const top = mime.split('/')[0];\n"
        + "                return parts.some(p => p === '*/*' || p === mime || (p.endsWith('/*') && top && p === top + '/*'));\n"
        + "            };\n"
        + "            const fileInput = fileInputs.find(i => fileObjects.every(f => accepts(i, f)))\n"
        + "                || fileInputs.find(i => !i.getAttribute('accept'))\n"
        + "                || fileInputs[0];\n"
        + "            if (fileInput) {\n"
        + "                const dt = new DataTransfer();\n"
        + "                for (const f of fileObjects) dt.items.add(f);\n"
        + "                fileInput.files = dt.files;\n"
        + "                fileInput.dispatchEvent(new Event('change', { bubbles: true }));\n"
        + "                window.__upload_images_status = 'success:file-input';\n"
        + "                return;\n"
        + "            }\n"
        + "            const dt = new DataTransfer();\n"
        + "            for (const f of fileObjects) dt.items.add(f);\n"
        + "            const targets = [el, el.closest('form'), document.querySelector('main'), document.body].filter(Boolean);\n"
        + "            for (const target of targets) {\n"
        + "                for (const type of ['dragenter', 'dragover', 'drop']) {\n"
        + "                    target.dispatchEvent(new DragEvent(type, {\n"
        + "                        bubbles: true, cancelable: true, dataTransfer: dt\n"
        + "                    }));\n"
        + "                }\n"
        + "            }\n"
        + "            const pasteEvent = new ClipboardEvent('paste', {\n"
        + "                bubbles: true, cancelable: true, clipboardData: dt\n"
        + "            });\n"
        + "            el.dispatchEvent(pasteEvent);\n"
        + "            window.__upload_images_status = 'success:drop';\n"
        + "        } catch (e) {\n"
        + "            window.__upload_images_status = 'error: ' + e.message;\n"
        + "        }\n"
        + "    })();\n"
        + "    return true;\n"
        + "}";

    let start_res = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({ "function": js }),
    )
    .map_err(|_| "Failed to initiate attachment upload script".to_string())?;

    let start_parsed = parse_script_result(&start_res)
        .map_err(|_| "Failed to initiate attachment upload script".to_string())?;
    if !start_parsed.as_bool().unwrap_or(false) {
        return Err("Failed to initiate attachment upload script".to_string());
    }

    // Poll for completion. Allow up to ~60s for large document uploads.
    let mut wait_cycles = 0;
    let mut status = String::from("pending");
    while status == "pending" && wait_cycles < 300 {
        thread::sleep(Duration::from_millis(200));
        let check_res = call_mcp_tool(
            config_path,
            "evaluate_script",
            serde_json::json!({ "function": "() => window.__upload_images_status || 'pending'" }),
        )
        .map_err(|_| "Attachment upload status was unavailable".to_string())?;
        if let Some(s) = parse_script_result(&check_res)
            .ok()
            .and_then(|p| p.as_str().map(|r| r.to_string()))
        {
            status = s;
        }
        wait_cycles += 1;
    }

    if status.starts_with("error:") {
        return Err("Attachment upload failed".to_string());
    }
    if status == "pending" {
        return Err("Timed out waiting for attachments to upload".to_string());
    }

    if verbose {
        println!("Attachments attached successfully ({})", status);
    }

    Ok(())
}

/// Upload every attachment and then require an exact, healthy filename
/// multiset to remain unchanged across two probes before the prompt may be
/// typed or submitted.
fn upload_attachments_to_provider(
    config_path: &str,
    provider: Provider,
    image_paths: &[String],
    file_paths: &[String],
    summary: &AttachmentSummary,
    verbose: bool,
) -> Result<Option<AttachmentProbeSummary>, String> {
    if summary.count() != image_paths.len() + file_paths.len() {
        return Err("附件摘要數量不一致".to_string());
    }

    // Typed mixed-attachment upload sequence (verified_mixed_attachment_upload_v1):
    // 1. Upload documents first (native chooser / fallback).
    // 2. If images are present, upload them via DataTransfer after documents
    //    are stable.
    // 3. Verify the full mixed set with the typed verifier (document filename
    //    multiset + image preview delta + natural dimensions).  If only
    //    documents are present, the legacy filename-multiset verifier is
    //    reused for backward compatibility.
    let has_images = !image_paths.is_empty();
    let expectations = AttachmentExpectations::new(file_paths, image_paths)
        .map_err(|_| ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string())?;

    // 1. Documents first.
    match document_upload_policy(provider) {
        DocumentUploadPolicy::NativeThenDataTransferFallback => {
            for path in file_paths {
                run_native_then_fallback(
                    || {
                        upload_attachments_via_file_chooser(
                            config_path,
                            provider,
                            &[],
                            std::slice::from_ref(path),
                            verbose,
                        )
                    },
                    || {
                        upload_attachments_via_data_transfer(
                            config_path,
                            provider,
                            &[],
                            std::slice::from_ref(path),
                            verbose,
                        )
                    },
                )?;
            }
        }
        DocumentUploadPolicy::DataTransferOnly => {
            upload_attachments_via_data_transfer(config_path, provider, &[], file_paths, verbose)?;
        }
    }

    // 2. If there are images, upload them via DataTransfer after documents.
    if has_images {
        match provider {
            Provider::Gemini => {
                run_native_then_fallback(
                    || {
                        upload_attachments_via_file_chooser(
                            config_path,
                            provider,
                            image_paths,
                            &[],
                            verbose,
                        )
                    },
                    || {
                        upload_attachments_via_data_transfer(
                            config_path,
                            provider,
                            image_paths,
                            &[],
                            verbose,
                        )
                    },
                )?;
            }
            Provider::ChatGpt | Provider::Claude => {
                upload_attachments_via_data_transfer(
                    config_path,
                    provider,
                    image_paths,
                    &[],
                    verbose,
                )?;
            }
        }
        // 3. Typed verification for the mixed set.
        let typed_summary =
            verify_typed_attachment_completion(config_path, provider, &expectations, verbose)?;
        Ok(Some(typed_summary))
    } else {
        // Documents-only: use the legacy filename-multiset verifier.
        verify_attachment_completion(config_path, provider, &summary.file_names, verbose)?;
        Ok(None)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChatGptStateOwnerRelation {
    Marker,
    Descendant,
}

impl ChatGptStateOwnerRelation {
    fn from_projection(value: &str) -> Result<Self, String> {
        match value {
            "marker" => Ok(Self::Marker),
            "descendant" => Ok(Self::Descendant),
            _ => Err("reasoning slider state owner relation is invalid".to_string()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChatGptFocusOwnerRelation {
    StateOwner,
    Descendant,
}

impl ChatGptFocusOwnerRelation {
    fn from_projection(value: &str) -> Result<Self, String> {
        match value {
            "state_owner" => Ok(Self::StateOwner),
            "descendant" => Ok(Self::Descendant),
            _ => Err("reasoning slider focus owner relation is invalid".to_string()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChatGptRoleEvidence {
    Slider,
    NativeRange,
    Missing,
    Conflict,
}

impl ChatGptRoleEvidence {
    fn from_projection(value: &str) -> Result<Self, String> {
        match value {
            "slider" => Ok(Self::Slider),
            "native_range" => Ok(Self::NativeRange),
            "missing" => Ok(Self::Missing),
            "conflict" => Ok(Self::Conflict),
            _ => Err("reasoning slider role evidence is invalid".to_string()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChatGptSliderState {
    min: i64,
    max: i64,
    now: i64,
    matched: bool,
    announcement_present: bool,
    focused: bool,
    marker_present: bool,
    marker_count: usize,
    role_slider: bool,
    state_owner_relation: Option<ChatGptStateOwnerRelation>,
    focus_owner_relation: Option<ChatGptFocusOwnerRelation>,
    role_evidence: ChatGptRoleEvidence,
    ordinal_present: bool,
    ordinal_current: Option<i64>,
    ordinal_total: Option<i64>,
    ordinal_consistent: bool,
    semantic_effort: Option<ReasoningEffort>,
    semantic_conflict: bool,
}

impl ChatGptSliderState {
    fn has_ordinal_evidence(&self) -> bool {
        self.ordinal_present || self.ordinal_current.is_some() || self.ordinal_total.is_some()
    }

    fn requires_bounded_ordinal(&self) -> bool {
        self.marker_present || self.has_ordinal_evidence()
    }

    fn model_selection_evidence(&self) -> ModelSelectionEvidence {
        let exact_same_owner = self.marker_present
            && self.state_owner_relation == Some(ChatGptStateOwnerRelation::Marker)
            && self.focus_owner_relation == Some(ChatGptFocusOwnerRelation::StateOwner)
            && matches!(
                self.role_evidence,
                ChatGptRoleEvidence::Slider | ChatGptRoleEvidence::NativeRange
            );
        if exact_same_owner {
            ModelSelectionEvidence::BoundedOrdinalV1
        } else {
            ModelSelectionEvidence::ResolvedBoundedOrdinalV2
        }
    }

    fn validate_bounded_ordinal(&self) -> Result<(), String> {
        if !self.marker_present || self.marker_count != 1 {
            return Err("Model switch failed: reasoning slider marker is missing".to_string());
        }
        if self.state_owner_relation.is_none() || self.focus_owner_relation.is_none() {
            return Err(
                "Model switch failed: reasoning slider control bundle is invalid".to_string(),
            );
        }
        if self.role_evidence == ChatGptRoleEvidence::Conflict {
            return Err(
                "Model switch failed: reasoning slider role conflicts with its control".to_string(),
            );
        }
        if self.min != 0 || self.max != 2 {
            return Err(
                "Model switch failed: reasoning slider must expose the exact 0..2 profile"
                    .to_string(),
            );
        }
        if !self.announcement_present
            || !self.ordinal_present
            || !self.ordinal_consistent
            || self.ordinal_total != Some(3)
            || self.ordinal_current != Some(self.now + 1)
        {
            return Err(
                "Model switch failed: reasoning slider ordinal state is invalid".to_string(),
            );
        }
        if self.semantic_conflict {
            return Err(
                "Model switch failed: reasoning slider semantic labels conflict".to_string(),
            );
        }
        if let Some(effort) = self.semantic_effort
            && Some(effort) != ReasoningEffort::from_ordinal_index(self.now)
        {
            return Err(
                "Model switch failed: reasoning slider semantic label contradicts ordinal"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn same_observable_state(self, other: Self) -> bool {
        self.min == other.min
            && self.max == other.max
            && self.now == other.now
            && self.matched == other.matched
            && self.announcement_present == other.announcement_present
            && self.focused == other.focused
            && self.marker_present == other.marker_present
            && self.marker_count == other.marker_count
            && self.role_slider == other.role_slider
            && self.state_owner_relation == other.state_owner_relation
            && self.focus_owner_relation == other.focus_owner_relation
            && self.role_evidence == other.role_evidence
            && self.ordinal_present == other.ordinal_present
            && self.ordinal_current == other.ordinal_current
            && self.ordinal_total == other.ordinal_total
            && self.ordinal_consistent == other.ordinal_consistent
            && self.semantic_effort == other.semantic_effort
            && self.semantic_conflict == other.semantic_conflict
    }
}

fn chatgpt_reasoning_control_bundle_resolver_js() -> &'static str {
    r##"((targetEffort) => {
    const markerSelector = '[data-model-reasoning-effort-slider]';
    const ordinalPattern = /第\s*(\d+)\s*(?:項|個)\s*(?:[，,、])?\s*(?:共|總共)\s*(\d+)\s*(?:項|個)|\bitem\s+(\d+)\s+of\s+(\d+)\b|\b(\d+)\s+of\s+(\d+)\b/i;
    const reasoningPattern = /reasoning|推理強度|思考強度/i;
    const interactiveRoles = new Set([
        'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem',
        'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'scrollbar',
        'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox',
        'treeitem'
    ]);
    const isVisible = (element) => {
        if (!element) return false;
        if (element.closest('[hidden], [aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
            style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };
    const textFor = (element) => [
        element?.getAttribute?.('aria-label'),
        element?.getAttribute?.('title'),
        element?.getAttribute?.('data-testid'),
        element?.textContent
    ].filter(Boolean).join(' ').trim();
    const isReasoningContainer = (element) =>
        reasoningPattern.test(textFor(element)) ||
        element?.matches?.('[role="menuitem"], [role="menu"], [role="group"]');
    const nearestReasoningContainer = (element) => {
        let owner = element;
        for (let depth = 0; owner && depth < 6; depth += 1, owner = owner.parentElement) {
            if (isReasoningContainer(owner)) return owner;
        }
        return null;
    };
    const isActiveContext = (context) => Boolean(
        context && (isVisible(context) || context.getAttribute('aria-expanded') === 'true' ||
            context.getAttribute('data-state') === 'open')
    );
    const activeMarkers = Array.from(document.querySelectorAll(markerSelector)).filter((marker) =>
        isActiveContext(nearestReasoningContainer(marker))
    );
    const markerCount = activeMarkers.length;
    if (markerCount > 1) {
        return {
            found: true,
            marker_count: markerCount,
            bundle_error: 'reasoning slider marker is ambiguous'
        };
    }

    let marker = activeMarkers[0] || null;
    let stateRoot = marker;
    if (!marker) {
        const legacyCandidates = Array.from(document.querySelectorAll(
            '[role="slider"][aria-valuemin][aria-valuemax], ' +
            'input[type="range"], ' +
            '[aria-valuemin][aria-valuemax][aria-valuenow]'
        )).filter((candidate) => isActiveContext(nearestReasoningContainer(candidate)));
        if (legacyCandidates.length !== 1) return { found: false, marker_count: 0 };
        stateRoot = legacyCandidates[0];
    }

    const isNativeRange = (element) =>
        element instanceof HTMLInputElement && element.type === 'range';
    const rawStateValue = (element, key) => {
        const ariaValue = element.getAttribute('aria-value' + key);
        if (ariaValue !== null) return ariaValue;
        if (isNativeRange(element)) {
            if (key === 'min') return element.getAttribute('min');
            if (key === 'max') return element.getAttribute('max');
            return element.value;
        }
        return null;
    };
    const hasCompleteState = (element) => Boolean(element &&
        rawStateValue(element, 'min') !== null && rawStateValue(element, 'max') !== null &&
        rawStateValue(element, 'now') !== null);
    const stateCandidates = marker
        ? Array.from(marker.querySelectorAll(
            '[aria-valuemin][aria-valuemax][aria-valuenow], input[type="range"]'
        )).filter(hasCompleteState)
        : [];
    let stateOwner = null;
    if (marker && hasCompleteState(marker)) {
        if (stateCandidates.length > 0) {
            return {
                found: true,
                marker_count: markerCount,
                bundle_error: 'reasoning slider state owner is ambiguous'
            };
        }
        stateOwner = marker;
    } else if (marker && stateCandidates.length === 1) {
        stateOwner = stateCandidates[0];
    } else if (!marker && hasCompleteState(stateRoot)) {
        stateOwner = stateRoot;
    } else {
        return {
            found: true,
            marker_count: markerCount,
            bundle_error: 'reasoning slider state owner is invalid'
        };
    }

    const isFocusable = (element) => Boolean(element &&
        element.matches('input, button, select, textarea, a[href], [contenteditable="true"], [tabindex]') &&
        !element.disabled && element.getAttribute('aria-disabled') !== 'true');
    let focusOwner = isFocusable(stateOwner) ? stateOwner : null;
    if (!focusOwner) {
        const focusRoot = marker || stateOwner;
        const focusCandidates = Array.from(focusRoot.querySelectorAll(
            'input, button, select, textarea, a[href], [contenteditable="true"], [tabindex]'
        )).filter(isFocusable);
        if (focusCandidates.length !== 1) {
            return {
                found: true,
                marker_count: markerCount,
                bundle_error: 'reasoning slider focus owner is ambiguous'
            };
        }
        focusOwner = focusCandidates[0];
    }
    focusOwner.focus();

    const actualOwners = [stateOwner];
    if (focusOwner !== stateOwner) actualOwners.push(focusOwner);
    const explicitRole = (element) => (element.getAttribute('role') || '').trim().toLowerCase();
    const implicitInteractiveRole = (element) => {
        if (isNativeRange(element)) return null;
        if (element.matches('button')) return 'button';
        if (element.matches('a[href]')) return 'link';
        if (element.matches('input, select, textarea')) return 'textbox';
        return null;
    };
    const ownerRoles = actualOwners.map((owner) =>
        explicitRole(owner) || implicitInteractiveRole(owner)
    ).filter(Boolean);
    const roleConflict = ownerRoles.some((role) => role !== 'slider' && interactiveRoles.has(role));
    const roleEvidence = roleConflict ? 'conflict' :
        actualOwners.some(isNativeRange) ? 'native_range' :
        ownerRoles.includes('slider') ? 'slider' : 'missing';

    const associatedNodes = new Set(actualOwners);
    const attributeNodes = new Set(actualOwners);
    if (marker) {
        associatedNodes.add(marker);
        attributeNodes.add(marker);
    }
    const describedNodes = new Set();
    for (const owner of [marker, stateOwner, focusOwner].filter(Boolean)) {
        for (const id of (owner.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)) {
            const described = document.getElementById(id);
            if (described) {
                associatedNodes.add(described);
                describedNodes.add(described);
            }
        }
    }
    const reasoningContainer = nearestReasoningContainer(marker || stateOwner);
    if (reasoningContainer) {
        for (const live of reasoningContainer.querySelectorAll(
            '[aria-live], [role="status"], [role="alert"]'
        )) associatedNodes.add(live);
    }
    const textSources = [];
    for (const node of associatedNodes) {
        if (describedNodes.has(node) || node.matches?.('[aria-live], [role="status"], [role="alert"]')) {
            if (node.textContent) textSources.push(node.textContent.trim());
        } else if (attributeNodes.has(node)) {
            for (const value of [node.getAttribute?.('aria-label'), node.getAttribute?.('aria-valuetext')]) {
                if (value) textSources.push(value.trim());
            }
        }
    }
    const parseOrdinal = (value) => {
        const match = String(value || '').match(ordinalPattern);
        if (!match) return null;
        const current = Number(match[1] || match[3] || match[5]);
        const total = Number(match[2] || match[4] || match[6]);
        return Number.isInteger(current) && Number.isInteger(total) ? { current, total } : null;
    };
    const ordinalSources = textSources.filter((value) => ordinalPattern.test(value));
    const parsedOrdinals = ordinalSources.map(parseOrdinal).filter(Boolean);
    const firstOrdinal = parsedOrdinals[0] || null;
    const ordinalConsistent = parsedOrdinals.length > 0 && parsedOrdinals.every((ordinal) =>
        ordinal.current === firstOrdinal.current && ordinal.total === firstOrdinal.total
    );
    const norm = (value) => (value || '').toLowerCase()
        .replace(/[^\p{Letter}\p{Number}]+/gu, '');
    const canonicalEffort = (value) => {
        const normalized = norm(value)
            .replace(/^(已選取|已選|selected|currentlyselected)/, '')
            .replace(/(已選取|已選|selected|currentlyselected)$/, '');
        const aliases = {
            '中等': 'medium', '中等推理': 'medium', '中': 'medium',
            '高推理': 'high', '高': 'high',
            '即時推理': 'instant', '即時': 'instant',
            'instant': 'instant', 'fast': 'instant', 'light': 'instant', 'low': 'instant',
            'medium': 'medium', 'standard': 'medium', 'thinking': 'medium',
            'high': 'high', 'heavy': 'high', 'extended': 'high'
        };
        return aliases[normalized] || null;
    };
    const semanticEfforts = new Set();
    for (const value of textSources) {
        const withoutOrdinal = String(value).replace(ordinalPattern, ' ');
        for (const part of [withoutOrdinal, ...withoutOrdinal.split(/[\n，,|:：、]/)]) {
            const effort = canonicalEffort(part);
            if (effort) semanticEfforts.add(effort);
        }
    }
    const semanticEffortValues = Array.from(semanticEfforts);
    const numberValue = (value) => value === null || value === '' ? NaN : Number(value);
    const min = numberValue(rawStateValue(stateOwner, 'min'));
    const max = numberValue(rawStateValue(stateOwner, 'max'));
    const now = numberValue(rawStateValue(stateOwner, 'now'));
    const target = canonicalEffort(targetEffort);
    return {
        found: true,
        marker_present: Boolean(marker),
        marker_count: markerCount,
        state_owner_relation: marker ? (stateOwner === marker ? 'marker' : 'descendant') : null,
        focus_owner_relation: focusOwner === stateOwner ? 'state_owner' : 'descendant',
        role_evidence: roleEvidence,
        role_slider: roleEvidence === 'slider',
        min,
        max,
        now,
        matched: Boolean(target && semanticEffortValues.includes(target)),
        announcement_present: ordinalSources.length > 0,
        ordinal_present: ordinalSources.length > 0,
        ordinal_current: firstOrdinal?.current ?? null,
        ordinal_total: firstOrdinal?.total ?? null,
        ordinal_consistent: ordinalConsistent,
        semantic_effort: semanticEffortValues.length === 1 ? semanticEffortValues[0] : null,
        semantic_conflict: semanticEffortValues.length > 1,
        focused: document.activeElement === focusOwner
    };
})"##
}

fn build_chatgpt_model_selection_script(target_json: &str) -> String {
    let template = r##"() => {
    window.__switch_model_status = 'pending';
    (async () => {
        try {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const norm = (value) => (value || '').toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '');
            const aliases = {
                '中等': '中',
                '中等推理': '中',
                '高推理': '高',
                '即時推理': '即時',
                'instant': '即時',
                'fast': '即時',
                'light': '即時',
                'low': '即時',
                'medium': '中',
                'standard': '中',
                'thinking': '中',
                'high': '高',
                'heavy': '高',
                'extended': '高'
            };
            const canonical = (value) => {
                const normalized = norm(value)
                    .replace(/^(已選取|已選|selected|currentlyselected)/, '')
                    .replace(/(已選取|已選|selected|currentlyselected)$/, '');
                return aliases[normalized] || normalized;
            };
            const target = canonical(__TARGET_MODEL__);
            if (!target) {
                window.__switch_model_status = 'error: empty target';
                return;
            }
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden' &&
                    style.opacity !== '0' && rect.width > 0 && rect.height > 0;
            };
            const isVisibleOrOwned = (element) => isVisible(element) ||
                isVisible(element.closest('[role="menuitemradio"], [role="radio"], label'));
            const labelValues = (element) => [
                element?.getAttribute('aria-label'),
                element?.getAttribute('title'),
                element?.innerText,
                element?.textContent
            ].filter(Boolean).map((value) => value.trim()).filter(Boolean);
            const labelOf = (element) => labelValues(element).join(' ');
            const matchesTarget = (element) => labelValues(element).some((value) =>
                canonical(value) === target
            );
            const hasCheckedEvidence = (element) => {
                if (!element) return false;
                if (element.matches(':checked')) return true;
                if (element.getAttribute('aria-checked') === 'true') return true;
                if (element.getAttribute('aria-selected') === 'true') return true;
                if (element.getAttribute('data-state') === 'checked') return true;
                const nested = element.querySelector('input[type="radio"], [role="radio"]');
                return Boolean(nested && (
                    nested.matches(':checked') ||
                    nested.getAttribute('aria-checked') === 'true' ||
                    nested.getAttribute('data-state') === 'checked'
                ));
            };
            const closeMenus = async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Escape', keyCode: 27, bubbles: true
                }));
                await sleep(350);
            };
            await closeMenus();
            let pill = null;
            for (let attempt = 0; attempt < 20; attempt++) {
                pill = document.querySelector('button.__composer-pill');
                if (pill && isVisible(pill)) break;
                await sleep(250);
            }
            if (!pill || !isVisible(pill)) {
                window.__switch_model_status = 'error: composer pill not found';
                return;
            }
            // React's composer control may attach its menu opener to the
            // pointer sequence.  These events only open the menu; all model
            // and slider selections remain verified below.
            pill.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, pointerType: 'mouse', isPrimary: true
            }));
            pill.dispatchEvent(new PointerEvent('pointerup', {
                bubbles: true, pointerType: 'mouse', isPrimary: true
            }));
            pill.click();
            await sleep(800);

            const radioCandidates = () => Array.from(document.querySelectorAll(
                '[role="menuitemradio"], [role="radio"], input[type="radio"]'
            ));
            const matchingRadio = () => radioCandidates().find((item) =>
                isVisibleOrOwned(item) && matchesTarget(item)
            );
            const radio = matchingRadio();
            if (radio) {
                radio.click();
                await sleep(500);
                const selected = radioCandidates().find((item) =>
                    matchesTarget(item) && hasCheckedEvidence(item)
                );
                if (!selected) {
                    window.__switch_model_status = 'error: model radio selection was not verified';
                    return;
                }
                await closeMenus();
                window.__switch_model_status = 'success:legacy_menu_v1';
                return;
            }

            const resolveReasoningControlBundle = __CONTROL_BUNDLE_RESOLVER__;
            let bundle = resolveReasoningControlBundle(target);
            let reasoningTriggerCount = 0;
            let reasoningOpenAttempts = 0;
            if (!bundle.found) {
                const triggers = Array.from(document.querySelectorAll(
                    '[aria-expanded], [role="menuitem"], button'
                )).filter((item) =>
                    isVisibleOrOwned(item) && item.getAttribute('role') !== 'slider' &&
                    /reasoning|推理強度|思考強度/i.test(labelValues(item).join(' '))
                );
                reasoningTriggerCount = triggers.length;
                for (const trigger of triggers) {
                    if (trigger.getAttribute('aria-expanded') === 'true') continue;
                    reasoningOpenAttempts += 1;
                    trigger.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }));
                    trigger.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
                    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                    trigger.click();
                    await sleep(700);
                    bundle = resolveReasoningControlBundle(target);
                    if (bundle.found) break;
                }
            }
            if (bundle.found) {
                if (bundle.bundle_error) {
                    window.__switch_model_status = 'error: ' + bundle.bundle_error;
                    return;
                }
                window.__switch_model_status = 'slider_ready';
                return;
            }

            const visited = new Set();
            for (let depth = 0; depth < 6; depth++) {
                const all = Array.from(document.querySelectorAll(
                    '[role="menuitem"], [role="menuitemradio"]'
                ));
                const leaves = all.filter((item) => item.getAttribute('aria-haspopup') !== 'menu');
                const match = leaves.find((item) =>
                    isVisibleOrOwned(item) && matchesTarget(item)
                );
                if (match) {
                    match.click();
                    await sleep(500);
                    const verified = Array.from(document.querySelectorAll(
                        '[role="menuitem"], [role="menuitemradio"], [role="option"]'
                    )).some((item) => matchesTarget(item) && hasCheckedEvidence(item));
                    if (!verified) {
                        window.__switch_model_status = 'error: legacy menu selection was not verified';
                        return;
                    }
                    await closeMenus();
                    window.__switch_model_status = 'success:legacy_menu_v1';
                    return;
                }
                const triggers = all.filter((item) => item.getAttribute('aria-haspopup') === 'menu');
                const trigger = triggers.find((item) => {
                    const key = canonical(labelOf(item));
                    return key && !visited.has(key);
                });
                if (!trigger) break;
                visited.add(canonical(labelOf(trigger)));
                trigger.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }));
                trigger.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
                trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                trigger.click();
                await sleep(750);
            }
            await closeMenus();
            window.__switch_model_status = 'error: model not found in verified selectors' +
                ' (radios=' + radioCandidates().length +
                ', slider=' + (bundle.found ? 1 : 0) +
                ', reasoning_triggers=' + reasoningTriggerCount +
                ', reasoning_attempts=' + reasoningOpenAttempts + ')';
        } catch (error) {
            window.__switch_model_status = 'error: ' + error.message;
        }
    })();
    return true;
}"##;
    template.replace("__TARGET_MODEL__", target_json).replace(
        "__CONTROL_BUNDLE_RESOLVER__",
        chatgpt_reasoning_control_bundle_resolver_js(),
    )
}

fn build_chatgpt_slider_state_script(target_json: &str) -> String {
    let mut template = r##"() => {
    const resolveReasoningControlBundle = __CONTROL_BUNDLE_RESOLVER__;
    return resolveReasoningControlBundle(__TARGET_MODEL__);
}"##
    .to_string();
    template = template.replace("__TARGET_MODEL__", target_json);
    template.replace(
        "__CONTROL_BUNDLE_RESOLVER__",
        chatgpt_reasoning_control_bundle_resolver_js(),
    )
}

fn parse_chatgpt_slider_state(value: &Value) -> Result<ChatGptSliderState, String> {
    if value.get("found").and_then(Value::as_bool) != Some(true) {
        return Err("reasoning slider disappeared".to_string());
    }
    if let Some(error) = value.get("bundle_error").and_then(Value::as_str) {
        return Err(format!("Model switch failed: {}", error));
    }
    let marker_present = value
        .get("marker_present")
        .and_then(Value::as_bool)
        .ok_or_else(|| "reasoning slider marker evidence is unavailable".to_string())?;
    let marker_count = value
        .get("marker_count")
        .and_then(Value::as_u64)
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(|| "reasoning slider marker count is unavailable".to_string())?;
    let role_evidence = value
        .get("role_evidence")
        .and_then(Value::as_str)
        .ok_or_else(|| "reasoning slider role evidence is unavailable".to_string())
        .and_then(ChatGptRoleEvidence::from_projection)?;
    let state_owner_relation = match value.get("state_owner_relation") {
        Some(Value::String(relation)) => {
            Some(ChatGptStateOwnerRelation::from_projection(relation)?)
        }
        None | Some(Value::Null) if !marker_present => None,
        None | Some(Value::Null) => {
            return Err("reasoning slider state owner relation is unavailable".to_string());
        }
        Some(_) => return Err("reasoning slider state owner relation is invalid".to_string()),
    };
    let focus_owner_relation = match value.get("focus_owner_relation") {
        Some(Value::String(relation)) => {
            Some(ChatGptFocusOwnerRelation::from_projection(relation)?)
        }
        None | Some(Value::Null) if !marker_present => None,
        None | Some(Value::Null) => {
            return Err("reasoning slider focus owner relation is unavailable".to_string());
        }
        Some(_) => return Err("reasoning slider focus owner relation is invalid".to_string()),
    };
    let min = value
        .get("min")
        .and_then(Value::as_i64)
        .ok_or_else(|| "reasoning slider minimum is unavailable".to_string())?;
    let max = value
        .get("max")
        .and_then(Value::as_i64)
        .ok_or_else(|| "reasoning slider maximum is unavailable".to_string())?;
    let now = value
        .get("now")
        .and_then(Value::as_i64)
        .ok_or_else(|| "reasoning slider value is unavailable".to_string())?;
    if min < 0 || max < min || max - min > 20 || now < min || now > max {
        return Err("reasoning slider state is invalid".to_string());
    }
    if value.get("focused").and_then(Value::as_bool) != Some(true) {
        return Err("reasoning slider could not be focused".to_string());
    }
    let optional_integer = |key: &str| -> Result<Option<i64>, String> {
        match value.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(raw) => raw
                .as_i64()
                .map(Some)
                .ok_or_else(|| format!("reasoning slider {} is not an integer", key)),
        }
    };
    let semantic_effort = match value.get("semantic_effort") {
        None | Some(Value::Null) => None,
        Some(raw) => {
            let label = raw
                .as_str()
                .ok_or_else(|| "reasoning slider semantic effort is invalid".to_string())?;
            Some(
                ReasoningEffort::from_label(label)
                    .ok_or_else(|| "reasoning slider semantic effort is unknown".to_string())?,
            )
        }
    };
    let focused = value
        .get("focused")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(ChatGptSliderState {
        min,
        max,
        now,
        matched: value
            .get("matched")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        announcement_present: value
            .get("announcement_present")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        focused,
        marker_present,
        marker_count,
        role_slider: role_evidence == ChatGptRoleEvidence::Slider,
        state_owner_relation,
        focus_owner_relation,
        role_evidence,
        ordinal_present: value
            .get("ordinal_present")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        ordinal_current: optional_integer("ordinal_current")?,
        ordinal_total: optional_integer("ordinal_total")?,
        ordinal_consistent: value
            .get("ordinal_consistent")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        semantic_effort,
        semantic_conflict: value
            .get("semantic_conflict")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn read_chatgpt_slider_state(
    config_path: &str,
    target_json: &str,
) -> Result<ChatGptSliderState, String> {
    let response = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({
            "function": build_chatgpt_slider_state_script(target_json)
        }),
    )?;
    let value = parse_script_result(&response)?;
    parse_chatgpt_slider_state(&value)
}

fn press_provider_key(config_path: &str, key: &str) -> Result<(), String> {
    call_mcp_tool(
        config_path,
        "press_key",
        serde_json::json!({
            "key": key,
            "includeSnapshot": false
        }),
    )?;
    Ok(())
}

fn build_chatgpt_reopen_slider_script() -> String {
    let template = r##"() => {
    window.__reopen_model_status = 'pending';
    (async () => {
        try {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden' &&
                    style.opacity !== '0' && rect.width > 0 && rect.height > 0;
            };
            const resolveReasoningControlBundle = __CONTROL_BUNDLE_RESOLVER__;
            const pill = document.querySelector('button.__composer-pill');
            if (!pill || !isVisible(pill)) {
                window.__reopen_model_status = 'error: composer pill not found';
                return;
            }
            pill.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, pointerType: 'mouse', isPrimary: true
            }));
            pill.dispatchEvent(new PointerEvent('pointerup', {
                bubbles: true, pointerType: 'mouse', isPrimary: true
            }));
            pill.click();
            for (let attempt = 0; attempt < 20; attempt++) {
                const bundle = resolveReasoningControlBundle(null);
                if (bundle.found) {
                    if (bundle.bundle_error) {
                        window.__reopen_model_status = 'error: ' + bundle.bundle_error;
                        return;
                    }
                    window.__reopen_model_status = 'success';
                    return;
                }
                await sleep(250);
            }
            window.__reopen_model_status = 'error: reasoning slider did not reopen';
        } catch (error) {
            window.__reopen_model_status = 'error: ' + error.message;
        }
    })();
    return true;
}"##;
    template.replace(
        "__CONTROL_BUNDLE_RESOLVER__",
        chatgpt_reasoning_control_bundle_resolver_js(),
    )
}

fn reopen_chatgpt_slider(config_path: &str) -> Result<(), String> {
    let start_res = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({ "function": build_chatgpt_reopen_slider_script() }),
    )?;
    if !parse_script_result(&start_res)?.as_bool().unwrap_or(false) {
        return Err("Model switch failed: could not reopen reasoning slider".to_string());
    }

    let mut wait_cycles = 0;
    let mut status = String::from("pending");
    while status == "pending" && wait_cycles < 60 {
        thread::sleep(Duration::from_millis(200));
        let check_res = call_mcp_tool(
            config_path,
            "evaluate_script",
            serde_json::json!({ "function": "() => window.__reopen_model_status || 'pending'" }),
        )?;
        if let Some(value) = parse_script_result(&check_res)
            .ok()
            .and_then(|parsed| parsed.as_str().map(str::to_string))
        {
            status = value;
        }
        wait_cycles += 1;
    }
    if status != "success" {
        return Err(format!(
            "Model switch failed: reasoning slider reopen status {}",
            status
        ));
    }
    Ok(())
}

fn select_chatgpt_bounded_ordinal(
    config_path: &str,
    target_json: &str,
    target: ReasoningEffort,
    mut state: ChatGptSliderState,
) -> Result<ModelSelectionOutcome, String> {
    state.validate_bounded_ordinal()?;

    while state.now > state.min {
        let previous = state;
        press_provider_key(&config_path, "ArrowLeft")?;
        thread::sleep(Duration::from_millis(500));
        let next = read_chatgpt_slider_state(config_path, target_json)?;
        next.validate_bounded_ordinal()?;
        if next.now != previous.now - 1
            || next.ordinal_current != previous.ordinal_current.map(|current| current - 1)
        {
            return Err(
                "Model switch failed: reasoning slider left movement was not exactly one ordinal"
                    .to_string(),
            );
        }
        state = next;
    }
    if state.now != 0 {
        return Err("Model switch failed: reasoning slider did not reach its minimum".to_string());
    }

    while state.now < target.target_index() {
        let previous = state;
        press_provider_key(&config_path, "ArrowRight")?;
        thread::sleep(Duration::from_millis(500));
        let next = read_chatgpt_slider_state(config_path, target_json)?;
        next.validate_bounded_ordinal()?;
        if next.now != previous.now + 1
            || next.ordinal_current != previous.ordinal_current.map(|current| current + 1)
        {
            return Err(
                "Model switch failed: reasoning slider right movement was not exactly one ordinal"
                    .to_string(),
            );
        }
        state = next;
    }

    let stable = read_chatgpt_slider_state(config_path, target_json)?;
    stable.validate_bounded_ordinal()?;
    if !state.same_observable_state(stable) {
        return Err(
            "Model switch failed: reasoning slider target was not stable across reads".to_string(),
        );
    }
    if stable.now != target.target_index() {
        return Err(
            "Model switch failed: reasoning slider target ordinal is incorrect".to_string(),
        );
    }

    press_provider_key(&config_path, "Escape")?;
    thread::sleep(Duration::from_millis(350));
    reopen_chatgpt_slider(config_path)?;
    let reopened = read_chatgpt_slider_state(config_path, target_json)?;
    reopened.validate_bounded_ordinal()?;
    if reopened.now != target.target_index() || !stable.same_observable_state(reopened) {
        return Err(
            "Model switch failed: reasoning slider target did not persist after reopen".to_string(),
        );
    }
    let reopened_stable = read_chatgpt_slider_state(config_path, target_json)?;
    reopened_stable.validate_bounded_ordinal()?;
    if !reopened.same_observable_state(reopened_stable) {
        return Err(
            "Model switch failed: reopened reasoning slider target was not stable".to_string(),
        );
    }
    press_provider_key(&config_path, "Escape")?;

    Ok(ModelSelectionOutcome {
        contract: ModelSelectionContract::ReasoningSliderV1,
        evidence: state.model_selection_evidence(),
    })
}

fn select_chatgpt_accessible_label(
    config_path: &str,
    target_json: &str,
    mut state: ChatGptSliderState,
) -> Result<ModelSelectionOutcome, String> {
    if !state.announcement_present {
        return Err(
            "Model switch failed: reasoning slider announcement was not verified".to_string(),
        );
    }
    if state.semantic_conflict {
        return Err("Model switch failed: reasoning slider semantic labels conflict".to_string());
    }

    let left_attempts = (state.max - state.min + 1) as usize;
    for _ in 0..=left_attempts {
        if state.now == state.min {
            break;
        }
        press_provider_key(&config_path, "ArrowLeft")?;
        thread::sleep(Duration::from_millis(500));
        state = read_chatgpt_slider_state(config_path, target_json)?;
    }
    if state.now != state.min {
        return Err("Model switch failed: reasoning slider did not reach its minimum".to_string());
    }

    loop {
        if state.matched {
            let verified = read_chatgpt_slider_state(config_path, target_json)?;
            if verified.now == state.now && verified.matched && !verified.semantic_conflict {
                press_provider_key(&config_path, "Escape")?;
                return Ok(ModelSelectionOutcome {
                    contract: ModelSelectionContract::ReasoningSliderV1,
                    evidence: ModelSelectionEvidence::AccessibleLabelV1,
                });
            }
            state = verified;
        }
        if state.now >= state.max {
            break;
        }
        let previous = state.now;
        press_provider_key(&config_path, "ArrowRight")?;
        thread::sleep(Duration::from_millis(500));
        state = read_chatgpt_slider_state(config_path, target_json)?;
        if state.now <= previous {
            return Err("Model switch failed: reasoning slider did not advance".to_string());
        }
    }
    Err("Model switch failed: reasoning target was not found in slider announcement".to_string())
}

/// Switch the selected provider to the specified model. The page must already be
/// loaded and logged in. `model` is matched case- and punctuation-insensitively.
fn switch_model(
    config_path: &str,
    provider: Provider,
    model: &str,
    verbose: bool,
) -> Result<ModelSelectionOutcome, String> {
    if model.trim().is_empty() {
        return Err("Empty model name".to_string());
    }
    let target_json = serde_json::to_string(model.trim())
        .map_err(|e| format!("Failed to serialize model name: {}", e))?;

    if verbose {
        println!(
            "Switching {} model to '{}'...",
            provider.display_name(),
            model.trim()
        );
    }

    let js = match provider {
        Provider::ChatGpt => build_chatgpt_model_selection_script(&target_json),
        Provider::Gemini => {
            let template = r#"() => {
                window.__switch_model_status = 'pending';
                (async () => {
                    try {
                        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                        const norm = (s) => (s || '').toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '');
                        const canonical = (s) => {
                            const n = norm(s).replace(/^已選取/, '');
                            if (n.includes('flashlite') || n.includes('31flashlite')) return 'flashlite';
                            if (n.includes('35flash') || (n.endsWith('flash') && !n.includes('lite'))) return 'flash';
                            if (n.includes('31pro') || n === 'pro') return 'pro';
                            return n;
                        };
                        const target = canonical(__TARGET_MODEL__);
                        if (!target) { window.__switch_model_status = 'error: empty target'; return; }
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                        await sleep(250);
                        const buttons = Array.from(document.querySelectorAll('button'));
                        const modeButton = buttons.find((button) => /模式挑選器|model picker|mode picker/i.test([
                            button.getAttribute('aria-label'),
                            button.textContent
                        ].filter(Boolean).join(' ')));
                        if (!modeButton) { window.__switch_model_status = 'error: Gemini mode picker not found'; return; }
                        modeButton.click();
                        await sleep(800);
                        const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'));
                        let chosen = null;
                        for (const item of items) {
                            const label = item.innerText || item.textContent || item.getAttribute('aria-label') || '';
                            if (canonical(label) === target || norm(label) === norm(__TARGET_MODEL__)) {
                                chosen = item;
                                break;
                            }
                        }
                        if (!chosen) {
                            window.__switch_model_status = 'error: model not found in menu';
                            return;
                        }
                        chosen.click();
                        await sleep(500);
                        window.__switch_model_status = 'success:' + (chosen.innerText || chosen.textContent || '').trim();
                    } catch (e) {
                        window.__switch_model_status = 'error: ' + e.message;
                    }
                })();
                return true;
            }"#;
            template.replace("__TARGET_MODEL__", &target_json)
        }
        Provider::Claude => {
            let template = r#"() => {
                window.__switch_model_status = 'pending';
                (async () => {
                    try {
                        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                        const norm = (s) => (s || '').toLowerCase().replace(/[\s.\-_]/g, '');
                        const labelOf = (el) => ((el.innerText || el.textContent || '').split('\n')[0] || '').trim();
                        const target = norm(__TARGET_MODEL__);
                        if (!target) { window.__switch_model_status = 'error: empty target'; return; }
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                        await sleep(300);
                        let trigger = document.querySelector('[data-testid="model-selector-dropdown"]');
                        if (!trigger) {
                            trigger = Array.from(document.querySelectorAll('button')).find((button) => {
                                const popup = button.getAttribute('aria-haspopup');
                                if (popup !== 'menu' && popup !== 'listbox') return false;
                                const label = [button.getAttribute('aria-label'), button.textContent].filter(Boolean).join(' ');
                                return /model|claude|opus|sonnet|haiku|fable/i.test(label);
                            });
                        }
                        if (!trigger) { window.__switch_model_status = 'error: Claude model selector not found'; return; }
                        trigger.click();
                        await sleep(800);
                        const visited = new Set();
                        let clicked = false;
                        let chosen = '';
                        for (let depth = 0; depth < 4 && !clicked; depth++) {
                            const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"]'));
                            const leaves = items.filter((it) => it.getAttribute('aria-haspopup') !== 'menu');
                            let match = leaves.find((it) => norm(labelOf(it)) === target);
                            if (!match) match = leaves.find((it) => norm(labelOf(it)).startsWith(target));
                            if (match) {
                                match.click();
                                clicked = true;
                                chosen = labelOf(match);
                                break;
                            }
                            const trigs = items.filter((it) => it.getAttribute('aria-haspopup') === 'menu');
                            const trig = trigs.find((it) => !visited.has(norm(it.innerText)));
                            if (!trig) break;
                            visited.add(norm(trig.innerText));
                            trig.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }));
                            trig.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                            trig.click();
                            await sleep(700);
                        }
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                        if (!clicked) {
                            window.__switch_model_status = 'error: model not found in menu';
                            return;
                        }
                        await sleep(400);
                        window.__switch_model_status = 'success:' + chosen;
                    } catch (e) {
                        window.__switch_model_status = 'error: ' + e.message;
                    }
                })();
                return true;
            }"#;
            template.replace("__TARGET_MODEL__", &target_json)
        }
    };

    let start_res = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({ "function": js }),
    )?;
    let start_parsed = parse_script_result(&start_res)?;
    if !start_parsed.as_bool().unwrap_or(false) {
        return Err("Failed to initiate model switch script".to_string());
    }

    let mut wait_cycles = 0;
    let mut status = String::from("pending");
    while status == "pending" && wait_cycles < 60 {
        thread::sleep(Duration::from_millis(200));
        let check_res = call_mcp_tool(
            config_path,
            "evaluate_script",
            serde_json::json!({ "function": "() => window.__switch_model_status || 'pending'" }),
        )?;
        if let Some(s) = parse_script_result(&check_res)
            .ok()
            .and_then(|p| p.as_str().map(|r| r.to_string()))
        {
            status = s;
        }
        wait_cycles += 1;
    }

    if status.starts_with("error:") {
        return Err(format!("Model switch failed: {}", status));
    }
    if status == "pending" {
        return Err("Timed out waiting for model switch".to_string());
    }

    let outcome = if provider == Provider::ChatGpt {
        if status == "slider_ready" {
            let state = read_chatgpt_slider_state(&config_path, &target_json)?;
            if state.requires_bounded_ordinal() {
                let target = ReasoningEffort::from_label(model.trim()).ok_or_else(|| {
                    "Model switch failed: reasoning target has no bounded ordinal mapping"
                        .to_string()
                })?;
                select_chatgpt_bounded_ordinal(&config_path, &target_json, target, state)?
            } else {
                select_chatgpt_accessible_label(&config_path, &target_json, state)?
            }
        } else if status == "success:legacy_menu_v1" {
            ModelSelectionOutcome {
                contract: ModelSelectionContract::LegacyMenuV1,
                evidence: ModelSelectionEvidence::CheckedStateV1,
            }
        } else {
            return Err("Model switch failed: selector contract was not verified".to_string());
        }
    } else {
        ModelSelectionOutcome {
            contract: ModelSelectionContract::LegacyMenuV1,
            evidence: ModelSelectionEvidence::CheckedStateV1,
        }
    };

    if verbose {
        println!("Model switched successfully ({})", status);
    }

    // Give the UI a moment to settle after switching models
    thread::sleep(Duration::from_millis(500));

    Ok(outcome)
}

fn wait_for_submit_status(config_path: &str) -> Result<String, String> {
    let mut wait_cycles = 0;
    let mut status = String::from("pending");

    // Page-side submission scripts may wait up to 15s for ChatGPT/Gemini to
    // enable the send button, so keep this host-side polling window longer.
    while status == "pending" && wait_cycles < 180 {
        thread::sleep(Duration::from_millis(100));
        let check_res = call_mcp_tool(
            config_path,
            "evaluate_script",
            serde_json::json!({
                "function": "() => window.__submit_status || 'pending'"
            }),
        )?;
        if let Some(s) = parse_script_result(&check_res)
            .ok()
            .and_then(|p| p.as_str().map(|str_ref| str_ref.to_string()))
        {
            status = s;
        }
        wait_cycles += 1;
    }

    if status.starts_with("error:") {
        return Err(status);
    }

    if status == "pending" {
        return Err("Timed out waiting for send button to activate and submit".to_string());
    }

    Ok(status)
}

fn focus_and_clear_composer(config_path: &str, provider: Provider) -> Result<(), String> {
    let js = r#"() => {
            const composerSelectors = __COMPOSER_SELECTORS__;
            const el = composerSelectors.map((s) => document.querySelector(s)).find(Boolean);
            if (!el) {
                return { ok: false, error: 'composer not found' };
            }

            el.focus();
            try {
                const range = document.createRange();
                range.selectNodeContents(el);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                document.execCommand('delete');
            } catch (e) {}

            const currentText = typeof el.value !== 'undefined' ? el.value : (el.innerText || el.textContent || '');
            if ((currentText || '').trim().length > 0) {
                if (typeof el.value !== 'undefined') {
                    el.value = '';
                    if (el._valueTracker) {
                        el._valueTracker.setValue('');
                    }
                } else {
                    el.innerHTML = '<p><br></p>';
                }
                el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }

            el.focus();
            return { ok: true };
        }"#
    .replace("__COMPOSER_SELECTORS__", provider.composer_selectors_json());

    let res = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({ "function": js }),
    )?;
    let parsed = parse_script_result(&res)?;
    if parsed
        .get("ok")
        .and_then(|ok| ok.as_bool())
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err(parsed
            .get("error")
            .and_then(|err| err.as_str())
            .unwrap_or("failed to focus and clear composer")
            .to_string())
    }
}

fn wait_for_chatgpt_agent_menu(config_path: &str) -> Result<(), String> {
    let js = r#"() => {
            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            const composer = document.querySelector('#prompt-textarea');
            const composerRect = composer ? composer.getBoundingClientRect() : null;
            const isNearComposer = (el) => {
                if (!composerRect) return true;
                const rect = el.getBoundingClientRect();
                const itemCenterX = (rect.left + rect.right) / 2;
                const composerCenterX = (composerRect.left + composerRect.right) / 2;
                const maxHorizontalDistance = Math.max(500, composerRect.width);
                return Math.abs(itemCenterX - composerCenterX) <= maxHorizontalDistance &&
                    Math.abs(rect.top - composerRect.bottom) <= 500;
            };
            const items = Array.from(document.querySelectorAll(
                '.popover .__menu-item, [class*="popover"] .__menu-item, [role="menuitem"], [role="option"], [cmdk-item]'
            ))
                .filter((el) => isVisible(el) && isNearComposer(el))
                .map((el) => (el.innerText || el.textContent || '').trim())
                .filter(Boolean);

            return { ok: items.length > 0, items: items.slice(0, 5) };
        }"#;

    let mut last_state = String::new();
    for _ in 0..40 {
        thread::sleep(Duration::from_millis(125));
        let res = call_mcp_tool(
            config_path,
            "evaluate_script",
            serde_json::json!({ "function": js }),
        )?;
        let parsed = parse_script_result(&res)?;
        if parsed
            .get("ok")
            .and_then(|ok| ok.as_bool())
            .unwrap_or(false)
        {
            return Ok(());
        }
        last_state = parsed.to_string();
    }

    Err(format!(
        "Timed out waiting for ChatGPT agent menu after typing mention ({})",
        last_state
    ))
}

fn wait_for_chatgpt_agent_selection(config_path: &str) -> Result<(), String> {
    let js = r#"() => {
            const composer = document.querySelector('#prompt-textarea');
            if (!composer) {
                return { ok: false, error: 'composer not found' };
            }
            const agentPill = composer.querySelector(
                '[data-id="agent"], [data-system-hint-type="agent"], [data-symbol="ecosystemMention"], [data-inline-selection-pill][contenteditable="false"]'
            );
            return {
                ok: Boolean(agentPill),
                text: (composer.innerText || composer.textContent || '').trim(),
                keyword: agentPill ? (agentPill.getAttribute('data-keyword') || agentPill.textContent || '').trim() : ''
            };
        }"#;

    let mut last_state = String::new();
    for _ in 0..40 {
        thread::sleep(Duration::from_millis(125));
        let res = call_mcp_tool(
            config_path,
            "evaluate_script",
            serde_json::json!({ "function": js }),
        )?;
        let parsed = parse_script_result(&res)?;
        if parsed
            .get("ok")
            .and_then(|ok| ok.as_bool())
            .unwrap_or(false)
        {
            return Ok(());
        }
        last_state = parsed.to_string();
    }

    Err(format!(
        "Timed out waiting for ChatGPT agent selection after Tab ({})",
        last_state
    ))
}

fn submit_regular_prompt(
    config_path: &str,
    provider: Provider,
    prompt: &str,
) -> Result<String, String> {
    let prompt_json = serde_json::to_string(prompt)
        .map_err(|e| format!("Failed to serialize prompt text: {}", e))?;
    let set_and_submit_js = r#"() => {
            window.__submit_status = 'pending';
            (async () => {
                try {
                    const composerSelectors = __COMPOSER_SELECTORS__;
                    const sendSelectors = __SEND_SELECTORS__;
                    const el = composerSelectors.map((s) => document.querySelector(s)).find(Boolean);
                    if (!el) {
                        window.__submit_status = 'error: composer not found';
                        return;
                    }
                    el.focus();
                    
                    const value = __PROMPT__;
                    el.focus();
                    
                    try {
                        const range = document.createRange();
                        range.selectNodeContents(el);
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(range);
                    } catch (e) {}
                    
                    let pasted = false;
                    try {
                        const dataTransfer = new DataTransfer();
                        dataTransfer.setData('text/plain', value);
                        const event = new ClipboardEvent('paste', {
                            bubbles: true,
                            cancelable: true
                        });
                        Object.defineProperty(event, 'clipboardData', {
                            value: dataTransfer,
                            writable: false,
                            configurable: true
                        });
                        el.dispatchEvent(event);
                        
                        const currentText = typeof el.value !== 'undefined' ? el.value : el.textContent;
                        if (currentText && currentText.trim().length > 0) {
                            pasted = true;
                        }
                    } catch (e) {}
                    
                    if (!pasted) {
                        const success = document.execCommand('insertText', false, value);
                        if (!success) {
                            if (typeof el.value !== 'undefined') {
                                el.value = value;
                                if (el._valueTracker) {
                                    el._valueTracker.setValue('');
                                }
                            } else {
                                el.innerText = value;
                            }
                            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                    
                    const isVisible = (el) => {
                        if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
                        const style = window.getComputedStyle(el);
                        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    };
                    const findAndClickSendButton = () => {
                        let btn = null;
                        for (const s of sendSelectors) {
                            btn = document.querySelector(s);
                            if (isVisible(btn)) break;
                        }
                        
                        if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
                            btn.click();
                            return { ok: true, clicked: true, buttonLabel: btn.getAttribute('aria-label') };
                        }
                        return null;
                    };
                    
                    let result = findAndClickSendButton();
                    if (result) {
                        window.__submit_status = 'success:' + JSON.stringify(result);
                        return;
                    }

                    for (let i = 0; i < 150; i++) {
                        await new Promise(r => setTimeout(r, 100));
                        result = findAndClickSendButton();
                        if (result) {
                            window.__submit_status = 'success:' + JSON.stringify(result);
                            return;
                        }
                    }
                    
                    window.__submit_status = 'error: Send button did not become active/enabled';
                } catch (e) {
                    window.__submit_status = 'error: ' + e.message;
                }
            })();
            return true;
        }"#
    .replace("__COMPOSER_SELECTORS__", provider.composer_selectors_json())
    .replace("__SEND_SELECTORS__", provider.send_button_selectors_json())
    .replace("__PROMPT__", &prompt_json);

    let start_res = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({
            "function": set_and_submit_js
        }),
    )?;

    let start_parsed = parse_script_result(&start_res)?;
    if !start_parsed.as_bool().unwrap_or(false) {
        return Err("Failed to initiate text entry and submission script".to_string());
    }

    wait_for_submit_status(config_path)
}

fn submit_chatgpt_agent_prompt(
    config_path: &str,
    parts: &ChatGptAgentPrompt<'_>,
    verbose: bool,
) -> Result<String, String> {
    if verbose {
        println!(
            "Selecting ChatGPT agent '{}' before submitting prompt...",
            parts.agent_mention
        );
    }

    focus_and_clear_composer(config_path, Provider::ChatGpt)?;
    call_mcp_tool(
        config_path,
        "type_text",
        serde_json::json!({
            "text": parts.agent_mention
        }),
    )?;
    wait_for_chatgpt_agent_menu(config_path)?;
    call_mcp_tool(
        config_path,
        "press_key",
        serde_json::json!({
            "key": "Tab",
            "includeSnapshot": false
        }),
    )?;
    wait_for_chatgpt_agent_selection(config_path)?;

    let body_json = serde_json::to_string(parts.body)
        .map_err(|e| format!("Failed to serialize prompt body: {}", e))?;
    let paste_and_submit_js = r#"() => {
            window.__submit_status = 'pending';
            (async () => {
                try {
                    const sendSelectors = __SEND_SELECTORS__;
                    const el = document.querySelector('#prompt-textarea');
                    if (!el) {
                        window.__submit_status = 'error: composer not found';
                        return;
                    }
                    const agentPill = el.querySelector(
                        '[data-id="agent"], [data-system-hint-type="agent"], [data-symbol="ecosystemMention"], [data-inline-selection-pill][contenteditable="false"]'
                    );
                    if (!agentPill) {
                        window.__submit_status = 'error: ChatGPT agent was not selected into the composer';
                        return;
                    }

                    const body = __BODY__;
                    const currentText = el.textContent || '';
                    const value = currentText && !/\s$/.test(currentText) ? ' ' + body : body;
                    el.focus();

                    try {
                        const range = document.createRange();
                        range.selectNodeContents(el);
                        range.collapse(false);
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(range);
                    } catch (e) {}

                    let pasted = false;
                    try {
                        const dataTransfer = new DataTransfer();
                        dataTransfer.setData('text/plain', value);
                        const event = new ClipboardEvent('paste', {
                            bubbles: true,
                            cancelable: true
                        });
                        Object.defineProperty(event, 'clipboardData', {
                            value: dataTransfer,
                            writable: false,
                            configurable: true
                        });
                        el.dispatchEvent(event);
                        const afterPasteText = el.innerText || el.textContent || '';
                        pasted = afterPasteText.includes(body);
                    } catch (e) {}

                    if (!pasted) {
                        const success = document.execCommand('insertText', false, value);
                        if (!success) {
                            el.appendChild(document.createTextNode(value));
                            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }

                    const afterText = el.innerText || el.textContent || '';
                    if (!afterText.includes(body)) {
                        window.__submit_status = 'error: prompt body was not pasted after ChatGPT agent selection';
                        return;
                    }

                    const isVisible = (el) => {
                        if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
                        const style = window.getComputedStyle(el);
                        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    };
                    const findAndClickSendButton = () => {
                        let btn = null;
                        for (const s of sendSelectors) {
                            btn = document.querySelector(s);
                            if (isVisible(btn)) break;
                        }
                        if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
                            btn.click();
                            return { ok: true, clicked: true, buttonLabel: btn.getAttribute('aria-label') };
                        }
                        return null;
                    };

                    let result = findAndClickSendButton();
                    if (result) {
                        window.__submit_status = 'success:' + JSON.stringify(result);
                        return;
                    }

                    for (let i = 0; i < 150; i++) {
                        await new Promise(r => setTimeout(r, 100));
                        result = findAndClickSendButton();
                        if (result) {
                            window.__submit_status = 'success:' + JSON.stringify(result);
                            return;
                        }
                    }

                    window.__submit_status = 'error: Send button did not become active/enabled';
                } catch (e) {
                    window.__submit_status = 'error: ' + e.message;
                }
            })();
            return true;
        }"#
    .replace(
        "__SEND_SELECTORS__",
        Provider::ChatGpt.send_button_selectors_json(),
    )
    .replace("__BODY__", &body_json);

    let start_res = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({
            "function": paste_and_submit_js
        }),
    )?;
    let start_parsed = parse_script_result(&start_res)?;
    if !start_parsed.as_bool().unwrap_or(false) {
        return Err("Failed to initiate ChatGPT agent prompt submission script".to_string());
    }

    wait_for_submit_status(config_path)
}

fn submit_prompt_to_provider(
    config_path: &str,
    provider: Provider,
    prompt: &str,
    verbose: bool,
) -> Result<String, String> {
    if provider == Provider::ChatGpt
        && let Some(parts) = parse_chatgpt_agent_prompt(prompt)
    {
        return submit_chatgpt_agent_prompt(config_path, &parts, verbose);
    }

    submit_regular_prompt(config_path, provider, prompt)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResponseBaseline {
    initial_user_count: usize,
    initial_assistant_count: usize,
    ownership_token: String,
}

fn establish_response_baseline(
    config_path: &str,
    provider: Provider,
) -> Result<ResponseBaseline, String> {
    let ownership_token = Uuid::new_v4().to_string();
    let token_json = serde_json::to_string(&ownership_token)
        .map_err(|_| "Failed to serialize response ownership token".to_string())?;
    let assistant_selector = serde_json::to_string(provider.assistant_selector())
        .map_err(|_| "Failed to serialize assistant selector".to_string())?;
    let user_selector = serde_json::to_string(provider.user_selector())
        .map_err(|_| "Failed to serialize user selector".to_string())?;
    let home_url_json = serde_json::to_string(provider.home_url())
        .map_err(|_| "Failed to serialize provider URL".to_string())?;
    let script = r#"() => {
            const stopSelectors = __STOP_SELECTORS__;
            const isVisibleControl = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            window.__ask_bridge_response_owner_v1 = __TOKEN__;
            return {
                ownership_token_set: window.__ask_bridge_response_owner_v1 === __TOKEN__,
                provider_url_owned: window.location.origin === new URL(__PROVIDER_HOME_URL__).origin,
                generation_control_visible: Boolean(stopSelectors
                    .map((selector) => document.querySelector(selector))
                    .find(isVisibleControl)),
                user_count: document.querySelectorAll(__USER_SELECTOR__).length,
                assistant_count: document.querySelectorAll(__ASSISTANT_SELECTOR__).length
            };
        }"#
    .replace("__STOP_SELECTORS__", provider.stop_button_selectors_json())
    .replace("__TOKEN__", &token_json)
    .replace("__ASSISTANT_SELECTOR__", &assistant_selector)
    .replace("__USER_SELECTOR__", &user_selector)
    .replace("__PROVIDER_HOME_URL__", &home_url_json);
    let result = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({"function": script}),
    )?;
    let value = parse_script_result(&result)?;
    if !value["ownership_token_set"].as_bool().unwrap_or(false) {
        return Err("Failed to establish response page ownership".to_string());
    }
    if !value["provider_url_owned"].as_bool().unwrap_or(false) {
        return Err("Provider page changed before prompt submission".to_string());
    }
    if value["generation_control_visible"]
        .as_bool()
        .unwrap_or(true)
    {
        return Err("Provider was already generating before prompt submission".to_string());
    }
    let initial_user_count = value["user_count"]
        .as_u64()
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(|| "Response baseline returned an invalid user count".to_string())?;
    let initial_assistant_count = value["assistant_count"]
        .as_u64()
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(|| "Response baseline returned an invalid assistant count".to_string())?;
    Ok(ResponseBaseline {
        initial_user_count,
        initial_assistant_count,
        ownership_token,
    })
}

fn build_response_probe_script(
    provider: Provider,
    baseline: &ResponseBaseline,
) -> Result<String, String> {
    let token_json = serde_json::to_string(&baseline.ownership_token)
        .map_err(|_| "Failed to serialize response ownership token".to_string())?;
    let home_url_json = serde_json::to_string(provider.home_url())
        .map_err(|_| "Failed to serialize provider URL".to_string())?;
    let assistant_selector = serde_json::to_string(provider.assistant_selector())
        .map_err(|_| "Failed to serialize assistant selector".to_string())?;
    let user_selector = serde_json::to_string(provider.user_selector())
        .map_err(|_| "Failed to serialize user selector".to_string())?;
    Ok(r#"() => {
            const stopSelectors = __STOP_SELECTORS__;
            const assistantSelector = __ASSISTANT_SELECTOR__;
            const userSelector = __USER_SELECTOR__;
            const minimumImageDimension = __MINIMUM_IMAGE_DIMENSION__;
            const isVisibleControl = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            const isLargeLoadedImage = (img) => {
                const src = img.currentSrc || img.src || '';
                if (!img.complete || img.naturalWidth < minimumImageDimension || img.naturalHeight < minimumImageDimension) return false;
                if (src.includes('avatar') || src.includes('profile')) return false;
                return src.startsWith('http') || src.startsWith('blob:') || src.startsWith('data:image/');
            };
            const domSignature = (element) => {
                if (!element) return '';
                const source = element.innerHTML || '';
                let hash = 2166136261;
                for (let index = 0; index < source.length; index += 1) {
                    hash ^= source.charCodeAt(index);
                    hash = Math.imul(hash, 16777619);
                }
                return `${source.length}:${(hash >>> 0).toString(16)}`;
            };
            const conversationId = (() => {
                const match = window.location.pathname.match(/^\/c\/([^/?#]+)/);
                return match ? `conversation:${match[1]}` : `home:${window.location.origin}`;
            })();
            const messages = Array.from(document.querySelectorAll(assistantSelector));
            const userMessages = Array.from(document.querySelectorAll(userSelector));
            const latest = messages[messages.length - 1] || null;
            const turn = latest
                ? (latest.closest('section[data-turn="assistant"][data-turn-id]') ||
                    latest.closest('[data-turn="assistant"][data-turn-id]') || latest)
                : null;
            const turnId = turn?.getAttribute('data-turn-id') || '';
            const artifactIds = turn
                ? Array.from(turn.querySelectorAll('[id^="image-"]'))
                    .map((element) => element.id)
                    .filter(Boolean)
                    .filter((id, index, all) => all.indexOf(id) === index)
                    .sort()
                : [];
            const loadedImages = latest
                ? Array.from(latest.querySelectorAll('img')).filter(isLargeLoadedImage)
                : [];
            const generationControl = stopSelectors
                .map((selector) => document.querySelector(selector))
                .find(isVisibleControl);
            const latestText = latest ? (latest.textContent || '') : '';
            const providerFailureVisible = Boolean(latest && /(?:content policy|內容政策|too many requests|太多要求|temporarily limited|暫時限制)/i.test(latestText));
            let providerUrlOwned = false;
            try {
                providerUrlOwned = window.location.origin === new URL(__PROVIDER_HOME_URL__).origin;
            } catch (_) {
                providerUrlOwned = false;
            }
            return {
                ownership_token_matches: window.__ask_bridge_response_owner_v1 === __TOKEN__,
                provider_url_owned: providerUrlOwned,
                url: window.location.href,
                conversation_id: conversationId,
                turn_id: turnId,
                artifact_ids: artifactIds,
                user_count: userMessages.length,
                assistant_count: messages.length,
                generation_control_visible: Boolean(generationControl),
                content_present: Boolean(latest && (((latest.textContent || '').trim().length > 0) || loadedImages.length > 0)),
                content_text_length: latest ? (latest.textContent || '').trim().length : 0,
                provider_failure_visible: providerFailureVisible,
                loaded_large_image_count: loadedImages.length,
                dom_signature: domSignature(latest)
            };
        }"#
    .replace("__STOP_SELECTORS__", provider.stop_button_selectors_json())
    .replace("__ASSISTANT_SELECTOR__", &assistant_selector)
    .replace("__USER_SELECTOR__", &user_selector)
    .replace(
        "__MINIMUM_IMAGE_DIMENSION__",
        &GENERATED_IMAGE_MIN_DIMENSION.to_string(),
    )
    .replace("__PROVIDER_HOME_URL__", &home_url_json)
    .replace("__TOKEN__", &token_json))
}

fn execute_verified_prompt_submission<Baseline, Upload, BeforeSubmit, Submit>(
    receipt_path: Option<&Path>,
    upload_and_verify: Upload,
    before_submit: BeforeSubmit,
    submit: Submit,
) -> Result<(Baseline, String), String>
where
    Upload: FnOnce() -> Result<(), String>,
    BeforeSubmit: FnOnce() -> Result<Baseline, String>,
    Submit: FnOnce() -> Result<String, String>,
{
    if upload_and_verify().is_err() {
        if let Some(path) = receipt_path {
            record_session_receipt_event(path, SessionReceiptEvent::AttachmentsFailed)
                .map_err(|_| "附件驗證失敗，且無法安全保存 receipt".to_string())?;
        }
        return Err(ATTACHMENT_VERIFICATION_FAILURE_CODE.to_string());
    }
    if let Some(path) = receipt_path {
        record_session_receipt_event(path, SessionReceiptEvent::AttachmentsVerified)
            .map_err(|_| "附件已驗證，但無法安全保存 receipt；prompt 未送出".to_string())?;
    }

    let baseline = before_submit()?;
    if let Some(path) = receipt_path {
        record_session_receipt_event(path, SessionReceiptEvent::PromptIntentRecorded)
            .map_err(|_| "無法保存 prompt submit intent；prompt 未送出".to_string())?;
    }
    let status = submit()?;
    if let Some(path) = receipt_path {
        record_session_receipt_event(path, SessionReceiptEvent::PromptSubmitted).map_err(|_| {
            "prompt 已可能送出，但無法保存 submitted receipt；遠端狀態未知".to_string()
        })?;
    }
    Ok((baseline, status))
}

fn list_pages(config_path: &str) -> Result<Vec<Page>, String> {
    let list_res = call_mcp_tool(config_path, "list_pages", serde_json::json!({}))?;
    let text = list_res
        .get("content")
        .and_then(|content| content.as_array())
        .and_then(|array| array.first())
        .and_then(|object| object.get("text"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Invalid list_pages response structure: {:?}", list_res))?;
    Ok(parse_pages(text))
}

/// Build the `new_page` args for the safe isolated new-tab path.
///
/// Headless mode opens the tab in the background so Chrome does not steal
/// macOS foreground focus; visible mode opens it in the foreground.
fn isolated_new_page_args(url: &str, headless: bool) -> Value {
    serde_json::json!({
        "url": url,
        "background": headless
    })
}

fn ensure_isolated_provider_tab(
    config_path: &str,
    provider: Provider,
    session_id: &str,
    attachment_summary: &AttachmentSummary,
    expected_output_type: ExpectedOutputType,
    headless: bool,
    verbose: bool,
) -> Result<PathBuf, String> {
    let session_id = validate_session_id(session_id)?;
    clear_owned_page();
    let existing_pages = list_pages(config_path)?;
    let existing_ids: std::collections::HashSet<usize> =
        existing_pages.iter().map(|page| page.id).collect();

    if verbose {
        println!(
            "Opening an isolated {} tab; preserving {} existing tab(s)...",
            provider.display_name(),
            existing_pages.len()
        );
    }
    // Use the raw call while the new page is not owned yet. Once the new page
    // id is established, call_mcp_tool enforces the exact binding.
    call_mcp_tool_raw(
        config_path,
        "new_page",
        isolated_new_page_args(&provider.home_url(), headless),
    )?;

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut candidate_id: Option<usize> = None;
    while Instant::now() < deadline {
        let pages = list_pages(config_path)?;
        if candidate_id.is_none() {
            let new_ids: Vec<usize> = pages
                .iter()
                .filter(|page| !existing_ids.contains(&page.id))
                .map(|page| page.id)
                .collect();
            if new_ids.len() > 1 {
                return Err(
                    "isolated_new_tab_v1 找到多個未預期的新 page ID；停止以避免誤選分頁"
                        .to_string(),
                );
            }
            candidate_id = new_ids.first().copied();
        }

        let Some(page_id) = candidate_id else {
            thread::sleep(Duration::from_millis(250));
            continue;
        };
        let Some(page) = pages.iter().find(|page| page.id == page_id) else {
            return Err("owned page 在分頁清單中消失；停止，不重用其他分頁".to_string());
        };
        if !provider.owns_url(&page.url) {
            thread::sleep(Duration::from_millis(250));
            continue;
        }

        call_mcp_tool_raw(
            config_path,
            "select_page",
            serde_json::json!({
                "pageId": page_id,
                "bringToFront": !headless
            }),
        )?;
        bind_owned_page(&session_id, page_id)?;
        let receipt_path = write_session_receipt(
            &session_id,
            attachment_summary.count(),
            attachment_summary.total_bytes,
            expected_output_type,
        )
        .inspect_err(|_| clear_owned_page())?;
        if verbose {
            println!(
                "Owned {} page ID {} for session {}.",
                provider.display_name(),
                page_id,
                session_id
            );
        }
        return Ok(receipt_path);
    }

    Err(format!(
        "Timeout waiting for an exact new {} page; no existing tab was reused",
        provider.display_name()
    ))
}

fn ensure_provider_tab(
    config_path: &str,
    provider: Provider,
    force_new: bool,
    headless: bool,
    verbose: bool,
) -> Result<(), String> {
    if verbose {
        println!("Checking open Chrome tabs...");
    }
    let list_res = call_mcp_tool(config_path, "list_pages", serde_json::json!({}))?;

    let text = list_res
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|obj| obj.get("text"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| format!("Invalid list_pages response structure: {:?}", list_res))?;

    let pages = parse_pages(text);

    if force_new {
        let old_provider_ids: Vec<usize> = pages
            .iter()
            .filter(|p| provider.owns_url(&p.url))
            .map(|p| p.id)
            .collect();

        if verbose {
            println!("Opening a brand new {} session...", provider.display_name());
        }
        call_mcp_tool(
            config_path,
            "new_page",
            serde_json::json!({
                "url": provider.home_url()
            }),
        )?;

        for id in old_provider_ids {
            if verbose {
                println!(
                    "Closing old {} tab (ID: {})...",
                    provider.display_name(),
                    id
                );
            }
            let _ = call_mcp_tool(
                config_path,
                "close_page",
                serde_json::json!({
                    "pageId": id
                }),
            );
        }

        let refreshed_pages_res = call_mcp_tool(config_path, "list_pages", serde_json::json!({}))?;
        let refreshed_text = refreshed_pages_res
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|obj| obj.get("text"))
            .and_then(|t| t.as_str())
            .ok_or_else(|| {
                format!(
                    "Invalid refreshed list_pages response structure: {:?}",
                    refreshed_pages_res
                )
            })?;
        let refreshed_pages = parse_pages(refreshed_text);

        if let Some(page) = refreshed_pages.iter().find(|p| provider.owns_url(&p.url)) {
            if verbose {
                println!(
                    "Selecting new {} tab (ID: {})...",
                    provider.display_name(),
                    page.id
                );
            }
            call_mcp_tool(
                config_path,
                "select_page",
                serde_json::json!({
                    "pageId": page.id,
                    "bringToFront": !headless
                }),
            )?;

            for stale_page in refreshed_pages.iter().filter(|p| p.id != page.id) {
                if verbose {
                    println!("Closing non-selected tab (ID: {})...", stale_page.id);
                }
                let _ = call_mcp_tool(
                    config_path,
                    "close_page",
                    serde_json::json!({
                        "pageId": stale_page.id
                    }),
                );
            }
        }
    } else {
        let provider_pages: Vec<&Page> = pages
            .iter()
            .filter(|page| provider.owns_url(&page.url))
            .collect();

        let provider_page_id = if provider_pages.len() > 1 {
            let mut page_states = Vec::with_capacity(provider_pages.len());
            for page in &provider_pages {
                call_mcp_tool(
                    config_path,
                    "select_page",
                    serde_json::json!({
                        "pageId": page.id,
                        "bringToFront": false
                    }),
                )?;
                let login_state = check_login_status(config_path, provider, verbose)
                    .unwrap_or(LoginState::Unknown);
                page_states.push(PageLoginState {
                    id: page.id,
                    selected: page.selected,
                    login_state,
                });
            }
            preferred_provider_page_id(&page_states)
        } else {
            provider_pages.first().map(|page| page.id)
        };

        match provider_page_id {
            Some(page_id) => {
                let page = provider_pages
                    .iter()
                    .find(|page| page.id == page_id)
                    .ok_or_else(|| "Selected provider page disappeared".to_string())?;
                if verbose {
                    println!(
                        "Found {} tab (ID: {}, selected: {}). Selecting/focusing...",
                        provider.display_name(),
                        page.id,
                        page.selected
                    );
                }
                call_mcp_tool(
                    config_path,
                    "select_page",
                    serde_json::json!({
                        "pageId": page.id,
                        "bringToFront": !headless
                    }),
                )?;
            }
            None => {
                // No provider tab. If there is only one blank tab, navigate it. Otherwise open a new page.
                if pages.len() == 1
                    && (pages[0].url == "about:blank"
                        || pages[0].url.contains("new-tab-page")
                        || pages[0].url.contains("chrome://welcome"))
                {
                    if verbose {
                        println!(
                            "Navigating existing blank tab to {}...",
                            provider.display_name()
                        );
                    }
                    call_mcp_tool(
                        config_path,
                        "navigate_page",
                        serde_json::json!({
                            "url": provider.home_url()
                        }),
                    )?;
                } else {
                    if verbose {
                        println!("Opening a new tab for {}...", provider.display_name());
                    }
                    call_mcp_tool(
                        config_path,
                        "new_page",
                        serde_json::json!({
                            "url": provider.home_url()
                        }),
                    )?;
                }
            }
        }
    }

    // Wait for the provider composer to be present.
    if verbose {
        println!("Waiting for {} to load...", provider.display_name());
    }
    for attempt in 0..90 {
        if attempt > 0 && attempt % 10 == 0 {
            let page_opt = call_mcp_tool(config_path, "list_pages", serde_json::json!({}))
                .ok()
                .and_then(|res| {
                    res.get("content")
                        .and_then(|c| c.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|obj| obj.get("text"))
                        .and_then(|t| t.as_str())
                        .map(|t| t.to_string())
                })
                .and_then(|text| {
                    parse_pages(&text)
                        .into_iter()
                        .find(|p| provider.owns_url(&p.url))
                });
            if let Some(page) = page_opt {
                let _ = call_mcp_tool(
                    config_path,
                    "select_page",
                    serde_json::json!({
                        "pageId": page.id,
                        "bringToFront": !headless
                    }),
                );
            }
        }

        let ready_res = call_mcp_tool(
            config_path,
            "evaluate_script",
            serde_json::json!({
                "function": provider.ready_check_js()
            }),
        );
        let ready_res = match ready_res {
            Ok(res) => res,
            Err(e) => {
                if verbose {
                    eprintln!(
                        "Warning: Failed to check {} readiness: {}",
                        provider.display_name(),
                        e
                    );
                }
                thread::sleep(Duration::from_millis(500));
                continue;
            }
        };
        if let Ok(parsed) = parse_script_result(&ready_res) {
            let is_ready = parsed.as_bool().unwrap_or(false);
            if is_ready {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(500));
    }

    Err(format!(
        "Timeout waiting for {} page to load",
        provider.display_name()
    ))
}

fn check_login_status(
    config_path: &str,
    provider: Provider,
    verbose: bool,
) -> Result<LoginState, String> {
    let res = call_mcp_tool(
        config_path,
        "evaluate_script",
        serde_json::json!({
            "function": provider.login_signals_js()
        }),
    )?;

    let parsed = parse_script_result(&res)?;
    let signals: LoginSignals = serde_json::from_value(parsed)
        .map_err(|e| format!("Failed to parse login signals: {}", e))?;
    if verbose {
        println!(
            "{} login signals: account={}, auth_control={}, auth_path={}, composer={}, stable={}",
            provider.display_name(),
            signals.account,
            signals.auth_control,
            signals.auth_path,
            signals.composer,
            signals.stable
        );
    }
    Ok(signals.state(provider))
}

fn wait_for_login_completion(
    config_path: &str,
    provider: Provider,
    timeout_seconds: u64,
    verbose: bool,
) -> (LoginState, bool) {
    let timeout = Duration::from_secs(timeout_seconds.max(1));
    let start = Instant::now();
    let display_name = provider.display_name();

    if verbose {
        println!(
            "Waiting for {} login status every second (timeout: {} seconds)...",
            display_name,
            timeout_seconds.max(1)
        );
    } else {
        println!("Waiting for login completion (checking every second)...");
    }

    loop {
        let state = match check_login_status(config_path, provider, verbose) {
            Ok(state) => state,
            Err(e) => {
                if verbose {
                    println!(
                        "Warning: Failed to check {} login status: {}",
                        display_name, e
                    );
                }
                LoginState::Unknown
            }
        };

        if state == LoginState::LoggedIn {
            return (LoginState::LoggedIn, false);
        }

        if start.elapsed() >= timeout {
            return (state, true);
        }

        thread::sleep(Duration::from_secs(1));
    }
}

fn print_chrome_diagnostics(profile_path: &str) {
    let snapshot = inspect_chrome_debug_port(profile_path);
    let recorded_pid = read_chrome_pid().unwrap_or_else(|| "unknown".to_string());

    println!("Chrome diagnostics:");
    println!("  profile: {}", profile_path);
    println!("  recorded PID: {}", recorded_pid);
    println!("  listener PIDs: {:?}", snapshot.listener_pids);
    println!("  ask-bridge owner PIDs: {:?}", snapshot.ask_pids);
    println!(
        "  CDP browser identity recorded: {}",
        snapshot
            .record
            .and_then(|record| record.browser_id)
            .is_some()
    );
}

/// How long to wait for a non-tty stdin to produce its first byte (or EOF)
/// when a prompt argument was already provided. Agent harnesses (Claude Code,
/// Codex) run commands with a pipe they may never close; blocking on EOF hung
/// whole runs (2026-07-11).
const STDIN_PIPE_GRACE: Duration = Duration::from_secs(2);

enum StdinProbe {
    Data,
    Eof,
}

/// Read stdin on a helper thread, signalling the first byte (or EOF) on one
/// channel and the full content on another, so the caller can bound how long
/// it waits for a pipe that might never deliver anything.
fn spawn_stdin_reader() -> (
    std::sync::mpsc::Receiver<StdinProbe>,
    std::sync::mpsc::Receiver<std::io::Result<String>>,
) {
    let (probe_tx, probe_rx) = std::sync::mpsc::channel();
    let (data_tx, data_rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut stdin = io::stdin();
        let mut first = [0u8; 1];
        match stdin.read(&mut first) {
            Ok(0) => {
                let _ = probe_tx.send(StdinProbe::Eof);
                let _ = data_tx.send(Ok(String::new()));
            }
            Ok(_) => {
                let _ = probe_tx.send(StdinProbe::Data);
                let mut bytes = vec![first[0]];
                let result = stdin.read_to_end(&mut bytes).and_then(|_| {
                    String::from_utf8(bytes)
                        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
                });
                let _ = data_tx.send(result);
            }
            Err(e) => {
                let _ = probe_tx.send(StdinProbe::Eof);
                let _ = data_tx.send(Err(e));
            }
        }
    });
    (probe_rx, data_rx)
}

/// With a prompt argument in hand piped stdin is an optional supplement: wait
/// up to `grace` for the pipe's first byte, then read a live pipe to EOF as
/// before; a silent pipe (agent harness holding it open) is treated as "no
/// piped input". Without a prompt argument stdin IS the prompt, so wait
/// unbounded exactly like upstream.
fn recv_piped_stdin(
    probe_rx: &std::sync::mpsc::Receiver<StdinProbe>,
    data_rx: &std::sync::mpsc::Receiver<std::io::Result<String>>,
    grace: Duration,
    has_prompt_argument: bool,
) -> std::io::Result<String> {
    if !has_prompt_argument {
        // stdin IS the prompt: wait unbounded like upstream, but after the
        // grace window tell the user what we are blocked on (an agent harness
        // holding the pipe open would otherwise hang here with no diagnostic).
        return match data_rx.recv_timeout(grace) {
            Ok(result) => result,
            Err(_) => {
                eprintln!(
                    "Waiting for a prompt on stdin (pipe is open; close it or pass a prompt argument)..."
                );
                data_rx.recv().unwrap_or(Ok(String::new()))
            }
        };
    }
    match probe_rx.recv_timeout(grace) {
        Ok(_) => data_rx.recv().unwrap_or(Ok(String::new())),
        Err(_) => {
            eprintln!(
                "No piped stdin data within {}s; continuing with the prompt argument only.",
                grace.as_secs()
            );
            Ok(String::new())
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut cli = Cli::parse();
    if cli.command.is_none() {
        let is_stdin_terminal = io::stdin().is_terminal();
        if is_stdin_terminal && cli.prompt.as_deref() == Some("update") {
            cli.command = Some(Commands::Update);
        }
    }

    let command_verbose = match &cli.command {
        Some(Commands::Get { verbose, .. }) => cli.verbose || *verbose,
        _ => cli.verbose,
    };

    FORWARD_MCP_STDERR.store(command_verbose, std::sync::atomic::Ordering::Relaxed);

    if matches!(cli.command, Some(Commands::Config)) {
        if let Err(e) = run_config_command(cli.provider) {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }

        return Ok(());
    }
    if matches!(cli.command, Some(Commands::Update)) {
        if let Err(e) = run_update_command() {
            eprintln!("Update failed: {}", e);
            std::process::exit(1);
        }
        return Ok(());
    }

    if let Some(Commands::Capabilities { json }) = &cli.command {
        print_capabilities(*json).map_err(|error| format!("Capabilities failed: {}", error))?;
        return Ok(());
    }

    let provider = match resolve_provider(cli.provider) {
        Ok(provider) => provider,
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    };

    let safe_session_id = if cli.new_tab_preserve_existing {
        Some(
            cli.session_id
                .as_deref()
                .ok_or_else(|| "--new-tab-preserve-existing 必須搭配 --session-id".to_string())
                .and_then(validate_session_id)?,
        )
    } else {
        None
    };
    if safe_session_id.is_some() && cli.command.is_some() {
        return Err(
            "--new-tab-preserve-existing 只支援直接送出 prompt；subcommand 不會啟用安全分頁模式"
                .into(),
        );
    }
    // Keep the lease alive for the entire invocation, including attachment
    // upload and response polling. Unlocking earlier would let another
    // process steal the selected page between two MCP calls.
    let _provider_lease = if let Some(session_id) = safe_session_id.as_deref() {
        Some(acquire_provider_lease(provider, session_id)?)
    } else {
        None
    };

    if let Err(e) = validate_provider_feature_support(provider, &cli) {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
    let attachment_summary = match summarize_attachments(&cli.images, &cli.files) {
        Ok(summary) => summary,
        Err(error) => {
            eprintln!("Error: {}", error);
            std::process::exit(1);
        }
    };

    if !command_verbose {
        // SAFETY: Called before spawning other threads and before loading MCP config.
        unsafe {
            std::env::remove_var("MCP_DEBUG");
        }
    }
    if std::env::var("MCP_TIMEOUT").is_err() {
        // SAFETY: Called before spawning other threads and before loading MCP config.
        unsafe {
            std::env::set_var("MCP_TIMEOUT", "20");
        }
    }

    let is_terminal = io::stdout().is_terminal();
    let use_glow = is_terminal && is_glow_available();

    let is_headless = match &cli.command {
        Some(Commands::Login) => false, // Force headful only for login command so user can see it to log in
        Some(Commands::Get { .. }) => false, // Default get to headful for debugging by default
        _ => cli.headless, // Respect --headless (defaults to true) for all other commands (including Open)
    };

    if matches!(cli.command, Some(Commands::Close)) {
        let profile_path = match chrome_profile_path() {
            Ok(path) => path,
            Err(e) => {
                eprintln!("Error locating Chrome profile: {}", e);
                std::process::exit(1);
            }
        };

        match close_ask_chrome_on_debug_port(&profile_path) {
            Ok(true) => println!("Closed ask-bridge Chrome browser instance."),
            Ok(false) => println!("No ask-bridge Chrome browser instance is running."),
            Err(e) => {
                eprintln!("Error closing ask-bridge Chrome browser instance: {}", e);
                std::process::exit(1);
            }
        }

        return Ok(());
    }

    if let Err(e) = check_node_runtime() {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }

    let config_path = match write_mcp_config(!command_verbose, is_headless) {
        Ok(path) => path,
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    };

    if let Err(e) = start_chrome_if_needed(is_headless, command_verbose) {
        eprintln!("Error starting Chrome: {}", e);
        std::process::exit(1);
    }

    if let Some(command) = cli.command {
        match command {
            Commands::Open { url } => {
                if let Some(url) = url {
                    let page_provider = Provider::from_url(&url).unwrap_or(provider);
                    if let Err(e) = open_url_tab(
                        &config_path,
                        page_provider,
                        &url,
                        is_headless,
                        command_verbose,
                    ) {
                        eprintln!("Error opening URL: {}", e);
                        std::process::exit(1);
                    }

                    match copy_latest_markdown(&config_path, page_provider) {
                        Ok(markdown) => {
                            if let Some(ref output_path) = cli.output {
                                let _ = std::fs::write(output_path, &markdown).map_err(|e| {
                                    eprintln!("Error writing output file: {}", e);
                                    std::process::exit(1);
                                });
                            }
                            if let Err(e) = render_markdown(&markdown, use_glow) {
                                eprintln!("Error rendering Markdown: {}", e);
                                std::process::exit(1);
                            }
                            let image_result = download_images_from_latest_message(
                                &config_path,
                                page_provider,
                                cli.image_output.as_deref(),
                                None,
                                command_verbose,
                            );
                            match image_result {
                                Ok(0) if cli.image_output.is_some() => {
                                    eprintln!("Error downloading images: no generated image found");
                                    std::process::exit(1);
                                }
                                Err(e) => {
                                    eprintln!("Error downloading images: {}", e);
                                    if cli.image_output.is_some() {
                                        std::process::exit(1);
                                    }
                                }
                                Ok(_) => {}
                            }
                        }
                        Err(e) => {
                            eprintln!("Error copying latest response Markdown: {}", e);
                            std::process::exit(1);
                        }
                    }
                } else {
                    if let Err(e) = ensure_provider_tab(
                        &config_path,
                        provider,
                        false,
                        is_headless,
                        command_verbose,
                    ) {
                        eprintln!("Error ensuring {} tab: {}", provider.display_name(), e);
                        std::process::exit(1);
                    }
                    println!("Successfully opened {}!", provider.display_name());
                }
                return Ok(());
            }
            Commands::Get { url, .. } => {
                let mut page_provider = provider;
                if let Some(url) = url {
                    page_provider = Provider::from_url(&url).unwrap_or(provider);
                    if let Err(e) = open_url_tab(
                        &config_path,
                        page_provider,
                        &url,
                        is_headless,
                        command_verbose,
                    ) {
                        eprintln!("Error opening URL: {}", e);
                        std::process::exit(1);
                    }
                } else {
                    if let Err(e) = ensure_provider_tab(
                        &config_path,
                        provider,
                        false,
                        is_headless,
                        command_verbose,
                    ) {
                        eprintln!("Error ensuring {} tab: {}", provider.display_name(), e);
                        std::process::exit(1);
                    }
                }

                match copy_latest_markdown(&config_path, page_provider) {
                    Ok(markdown) => {
                        if let Some(ref output_path) = cli.output {
                            let _ = std::fs::write(output_path, &markdown).map_err(|e| {
                                eprintln!("Error writing output file: {}", e);
                                std::process::exit(1);
                            });
                        }
                        if let Err(e) = render_markdown(&markdown, use_glow) {
                            eprintln!("Error rendering Markdown: {}", e);
                            std::process::exit(1);
                        }
                        let image_result = download_images_from_latest_message(
                            &config_path,
                            page_provider,
                            cli.image_output.as_deref(),
                            None,
                            command_verbose,
                        );
                        match image_result {
                            Ok(0) if cli.image_output.is_some() => {
                                eprintln!("Error downloading images: no generated image found");
                                std::process::exit(1);
                            }
                            Err(e) => {
                                eprintln!("Error downloading images: {}", e);
                                if cli.image_output.is_some() {
                                    std::process::exit(1);
                                }
                            }
                            Ok(_) => {}
                        }
                    }
                    Err(e) => {
                        eprintln!("Error copying latest response Markdown: {}", e);
                        std::process::exit(1);
                    }
                }
                return Ok(());
            }
            Commands::Login => {
                if let Err(e) =
                    ensure_provider_tab(&config_path, provider, false, is_headless, command_verbose)
                {
                    eprintln!("Error ensuring {} tab: {}", provider.display_name(), e);
                    std::process::exit(1);
                }
                println!("\n========================================================");
                println!("Please complete the login manually in the Chrome window.");
                println!("The tool will automatically detect when login is complete every second.");
                println!("========================================================\n");

                let (login_state, timed_out) =
                    wait_for_login_completion(&config_path, provider, cli.timeout, command_verbose);

                match (login_state, timed_out) {
                    (LoginState::LoggedIn, _) => println!(
                        "Success: Logged in successfully! You can now use the `ask-bridge` command."
                    ),
                    (LoginState::LoggedOut, true) => println!(
                        "Warning: Login timeout reached ({} seconds). Login still appears incomplete.",
                        cli.timeout
                    ),
                    (LoginState::Unknown, true) => println!(
                        "Warning: Timeout reached ({} seconds). Login status is still unknown; please verify manually.",
                        cli.timeout
                    ),
                    (LoginState::LoggedOut, false) | (LoginState::Unknown, false) => println!(
                        "Warning: Login status changed while waiting. Please verify the result and rerun if needed."
                    ),
                }
                if command_verbose {
                    match chrome_profile_path() {
                        Ok(profile_path) => print_chrome_diagnostics(&profile_path),
                        Err(e) => eprintln!("Warning: Failed to locate Chrome profile: {}", e),
                    }
                }
                return Ok(());
            }
            Commands::SessionProbe { json } => {
                let provider_name = match provider {
                    Provider::ChatGpt => "chatgpt",
                    Provider::Gemini => "gemini",
                    Provider::Claude => "claude",
                };
                let (authenticated, state) =
                    match ensure_provider_tab(&config_path, provider, false, is_headless, false) {
                        Ok(()) => match check_login_status(&config_path, provider, false) {
                            Ok(LoginState::LoggedIn) => (true, "logged_in"),
                            Ok(LoginState::LoggedOut) => (false, "logged_out"),
                            Ok(LoginState::Unknown) => (false, "unknown"),
                            Err(_) => (false, "unknown"),
                        },
                        Err(_) => (false, "unknown"),
                    };
                if json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "authenticated": authenticated,
                            "state": state,
                            "provider": provider_name,
                        })
                    );
                } else if authenticated {
                    println!("{} session probe: authenticated", provider.display_name());
                } else {
                    println!(
                        "{} session probe: authentication not confirmed",
                        provider.display_name()
                    );
                }
                if !authenticated {
                    std::process::exit(1);
                }
                return Ok(());
            }
            Commands::Close => unreachable!("close command is handled before Chrome startup"),
            Commands::Config => unreachable!("config command is handled before Chrome startup"),
            Commands::Update => unreachable!("update command is handled before Chrome startup"),
            Commands::Capabilities { .. } => {
                unreachable!("capabilities is handled before Chrome startup")
            }
            Commands::Dump => {
                let list_res = call_mcp_tool(&config_path, "list_pages", serde_json::json!({}))?;
                println!("All pages: {:?}", list_res);
                if let Err(e) =
                    ensure_provider_tab(&config_path, provider, false, is_headless, command_verbose)
                {
                    eprintln!("Error ensuring {} tab: {}", provider.display_name(), e);
                    std::process::exit(1);
                }
                let url_res = call_mcp_tool(
                    &config_path,
                    "evaluate_script",
                    serde_json::json!({
                        "function": "() => window.location.href"
                    }),
                )?;
                println!("Current page URL: {:?}", parse_script_result(&url_res));
                let res = call_mcp_tool(
                    &config_path,
                    "evaluate_script",
                    serde_json::json!({
                        "function": "() => document.body.innerHTML"
                    }),
                )?;
                let html = parse_script_result(&res)?
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                std::fs::create_dir_all("target").unwrap();
                std::fs::write("target/dump.html", html)?;
                println!("Dumped HTML to target/dump.html");
                return Ok(());
            }
            Commands::Screenshot => {
                if let Err(e) =
                    ensure_provider_tab(&config_path, provider, false, is_headless, command_verbose)
                {
                    eprintln!("Error ensuring {} tab: {}", provider.display_name(), e);
                    std::process::exit(1);
                }
                let res = call_mcp_tool(&config_path, "take_screenshot", serde_json::json!({}))?;

                let mut saved = false;
                if let Some(arr) = res.get("content").and_then(|c| c.as_array()) {
                    for item in arr {
                        if let Some(data) = item
                            .get("type")
                            .filter(|t| t.as_str() == Some("image"))
                            .and_then(|_| item.get("data"))
                            .and_then(|d| d.as_str())
                        {
                            use base64::{Engine as _, engine::general_purpose::STANDARD};
                            match STANDARD.decode(data.trim()) {
                                Ok(bytes) => {
                                    std::fs::create_dir_all("target").unwrap();
                                    std::fs::write("target/screenshot.png", bytes)?;
                                    println!("Saved screenshot to target/screenshot.png");
                                    saved = true;
                                    break;
                                }
                                Err(e) => {
                                    eprintln!("Failed to decode base64 image data: {}", e);
                                }
                            }
                        }
                    }
                }
                if !saved {
                    eprintln!(
                        "Could not find any image item in the tool response content. Full response: {:?}",
                        res
                    );
                }
                return Ok(());
            }
        }
    }

    // Read prompt from arguments and optionally append piped stdin content.
    let mut stdin_prompt = String::new();

    // Check if stdin is a pipe (not a tty)
    if !std::io::stdin().is_terminal() {
        let (probe_rx, data_rx) = spawn_stdin_reader();
        stdin_prompt =
            recv_piped_stdin(&probe_rx, &data_rx, STDIN_PIPE_GRACE, cli.prompt.is_some())?;
    }

    let prompt = match cli.prompt {
        Some(mut p) => {
            if !stdin_prompt.is_empty() {
                p.push_str("\n\n");
                p.push_str(&stdin_prompt);
            }
            p
        }
        None => stdin_prompt,
    };

    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        // No prompt and no command, print help
        let mut cmd = Cli::command();
        if let Some(version) = cmd.get_version() {
            println!("ask-bridge {}", version);
        } else {
            println!("ask-bridge {}", env!("CARGO_PKG_VERSION"));
        }
        cmd.print_help()?;
        println!();
        std::process::exit(0);
    }

    let expected_output_type = if cli.image_output.is_some() {
        ExpectedOutputType::Image
    } else {
        ExpectedOutputType::Text
    };

    let receipt_path = if let Some(session_id) = safe_session_id.as_deref() {
        match ensure_isolated_provider_tab(
            &config_path,
            provider,
            session_id,
            &attachment_summary,
            expected_output_type,
            is_headless,
            command_verbose,
        ) {
            Ok(path) => Some(path),
            Err(error) => {
                eprintln!("Error ensuring {} tab: {}", provider.display_name(), error);
                std::process::exit(1);
            }
        }
    } else {
        if let Err(error) = ensure_provider_tab(
            &config_path,
            provider,
            cli.new,
            is_headless,
            command_verbose,
        ) {
            eprintln!("Error ensuring {} tab: {}", provider.display_name(), error);
            std::process::exit(1);
        }
        None
    };

    // Show attached images in the terminal before sending
    if !cli.images.is_empty() {
        for img_path in &cli.images {
            display_image_in_terminal(img_path);
        }
    }

    // Verify login
    match check_login_status(&config_path, provider, command_verbose) {
        Ok(LoginState::LoggedOut) => {
            eprintln!(
                "\nError: You are not logged in to {}.",
                provider.display_name()
            );
            eprintln!(
                "Please run `ask-bridge --provider {} login` to log in manually first, and then run your query again.\n",
                provider
            );
            std::process::exit(1);
        }
        Ok(LoginState::Unknown) => {
            eprintln!(
                "Warning: Could not confirm the {} account menu. Attempting to proceed...",
                provider.display_name()
            );
        }
        Ok(LoginState::LoggedIn) => {}
        Err(e) if command_verbose => {
            eprintln!(
                "Warning: Failed to verify login status: {}. Attempting to proceed...",
                e
            );
        }
        Err(_) => {}
    }

    // Switch model if requested (before uploading attachments / typing the prompt).
    // Each --model value is applied in order, so e.g. `--model "GPT-5.5" --model "中等"`
    // first selects the model, then the reasoning level.
    let mut model_selection_outcome = None;
    for m in &cli.model {
        match switch_model(&config_path, provider, m, command_verbose) {
            Ok(outcome) if provider == Provider::ChatGpt => {
                model_selection_outcome = Some(outcome);
            }
            Ok(_) => {}
            Err(error) => {
                if provider == Provider::ChatGpt {
                    if let Some(path) = receipt_path.as_deref()
                        && let Err(receipt_error) = record_model_selection_failed(path)
                    {
                        eprintln!(
                            "Error switching model '{}': {} (receipt failed: {})",
                            m, MODEL_SELECTION_FAILURE_CODE, receipt_error
                        );
                        std::process::exit(1);
                    }
                    eprintln!(
                        "Error switching model '{}': {}: {}",
                        m, MODEL_SELECTION_FAILURE_CODE, error
                    );
                } else {
                    eprintln!("Error switching model '{}': {}", m, error);
                }
                std::process::exit(1);
            }
        }
    }
    if let Some(outcome) = model_selection_outcome
        && let Some(path) = receipt_path.as_deref()
        && let Err(error) = record_model_selection_verified(path, outcome)
    {
        eprintln!(
            "Error recording {}: {}",
            VERIFIED_MODEL_SELECTION_CAPABILITY, error
        );
        std::process::exit(1);
    }

    // --verify-attachments-only: upload and verify attachments, then exit
    // without typing or submitting a prompt.  Receipt prompt_submission stays
    // not_started.
    if cli.verify_attachments_only {
        match upload_attachments_to_provider(
            &config_path,
            provider,
            &cli.images,
            &cli.files,
            &attachment_summary,
            command_verbose,
        ) {
            Ok(summary) => {
                if let Some(ref probe) = summary {
                    if let Some(path) = receipt_path.as_deref() {
                        // Drive the receipt state machine first so the
                        // additive attachment_probe fields are preserved by
                        // the subsequent write_attachment_probe_receipt call.
                        let _ = record_session_receipt_event(
                            path,
                            SessionReceiptEvent::AttachmentsVerified,
                        );
                        let _ = write_attachment_probe_receipt(path, probe);
                    }
                    println!(
                        "Attachments verified: {} document(s), {} image(s).",
                        probe.expected_documents, probe.expected_images
                    );
                } else {
                    // Documents-only path: still record the verified event.
                    if let Some(path) = receipt_path.as_deref() {
                        let _ = record_session_receipt_event(
                            path,
                            SessionReceiptEvent::AttachmentsVerified,
                        );
                    }
                    println!("Attachments verified (documents only).");
                }
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("Attachment verification failed: {}", error);
                std::process::exit(1);
            }
        }
    }

    let submission_result = execute_verified_prompt_submission(
        receipt_path.as_deref(),
        || {
            let probe_summary = upload_attachments_to_provider(
                &config_path,
                provider,
                &cli.images,
                &cli.files,
                &attachment_summary,
                command_verbose,
            )?;
            // Persist the additive attachment_probe receipt fields for typed
            // mixed attachment diagnostics.  The receipt's
            // attachment_verification/prompt_submission state machine is
            // still driven by record_session_receipt_event below.
            if let Some(probe) = probe_summary
                && let Some(path) = receipt_path.as_deref()
            {
                let _ = write_attachment_probe_receipt(path, &probe);
            }
            Ok(())
        },
        || establish_response_baseline(&config_path, provider),
        || {
            if command_verbose {
                println!("Setting prompt text and submitting...");
            }
            submit_prompt_to_provider(&config_path, provider, &prompt, command_verbose)
                .map_err(|error| format!("Text entry or submission failed: {}", error))
        },
    );
    let (response_baseline, status) = match submission_result {
        Ok(result) => result,
        Err(error) => {
            if let Some(path) = receipt_path.as_deref()
                && read_session_receipt(path)
                    .is_ok_and(|receipt| receipt.prompt_submission != PromptSubmission::NotStarted)
            {
                let _ = record_session_response_outcome(
                    path,
                    ResponseCompletion::Unknown,
                    0,
                    Some(ResponseFailureCode::ResponseProbeFailed),
                );
            }
            return Err(format!("Verified prompt submission failed: {}", error).into());
        }
    };

    if command_verbose {
        println!("Prompt submitted successfully: {}", status);
    }

    if command_verbose {
        println!("Waiting for {} response...", provider.display_name());
    }

    let mut last_markdown = String::new();
    let spinner_frames = vec!["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let mut spinner_idx = 0;
    let response_deadline = McpOperationDeadline::from_timeout(Duration::from_secs(cli.timeout))?;
    let response_probe_script = build_response_probe_script(provider, &response_baseline)?;
    let mut response_tracker = ResponseCompletionTracker::new(
        expected_output_type,
        response_baseline.initial_user_count,
        response_baseline.initial_assistant_count,
    );
    let response_decision = loop {
        if is_terminal {
            let frame = spinner_frames[spinner_idx % spinner_frames.len()];
            print!(
                "\r\x1b[1;36m{}\x1b[0m 正在等待 {} 回應...",
                frame,
                provider.display_name()
            );
            io::stdout().flush()?;
            spinner_idx += 1;
        }

        if Instant::now() >= response_deadline.expires_at {
            break response_tracker.timeout();
        }
        let check_res = match call_mcp_tool_with_deadline(
            &config_path,
            "evaluate_script",
            serde_json::json!({"function": response_probe_script.clone()}),
            Some(response_deadline),
        ) {
            Ok(result) => result,
            Err(_) if Instant::now() >= response_deadline.expires_at => {
                break response_tracker.timeout();
            }
            Err(_) => {
                break response_tracker.finish_unknown(ResponseFailureCode::ResponseProbeFailed);
            }
        };
        let probe = match parse_script_result(&check_res)
            .ok()
            .and_then(|value| serde_json::from_value::<ResponseDomProbe>(value).ok())
        {
            Some(probe) => probe,
            None => {
                break response_tracker.finish_unknown(ResponseFailureCode::ResponseProbeFailed);
            }
        };
        match response_tracker.observe(probe) {
            ResponseTrackerDecision::Pending => {}
            terminal => break terminal,
        }

        let remaining = response_deadline
            .expires_at
            .saturating_duration_since(Instant::now());
        thread::sleep(remaining.min(RESPONSE_POLL_INTERVAL));
    };

    if is_terminal {
        print!("\r\x1b[K");
        io::stdout().flush()?;
    }

    let verified_response = match response_decision {
        ResponseTrackerDecision::Completed(identity) => identity,
        ResponseTrackerDecision::Unknown(code) => {
            if let Some(path) = receipt_path.as_deref() {
                record_session_response_outcome(path, ResponseCompletion::Unknown, 0, Some(code))
                    .map_err(|_| "Response became unknown, but receipt audit failed")?;
            }
            return Err(format!("Provider response completion is unknown ({code})").into());
        }
        ResponseTrackerDecision::Pending => {
            unreachable!("response wait must end in a terminal state")
        }
    };

    let download_result = download_images_from_latest_message(
        &config_path,
        provider,
        cli.image_output.as_deref(),
        Some((&response_baseline, &verified_response)),
        command_verbose,
    );
    let downloaded_image_count = if expected_output_type == ExpectedOutputType::Image {
        match enforce_download_contract(expected_output_type, download_result) {
            Ok(count) => count,
            Err(code) => {
                let completion = if code == ResponseFailureCode::ResponseIdentityChanged {
                    ResponseCompletion::Unknown
                } else {
                    ResponseCompletion::Completed
                };
                if let Some(path) = receipt_path.as_deref() {
                    record_session_response_outcome(path, completion, 0, Some(code))
                        .map_err(|_| "Image download failed, and receipt audit also failed")?;
                }
                return Err(format!("Verified image response download failed ({code})").into());
            }
        }
    } else {
        match download_result {
            Ok(count) => count,
            Err(error) => {
                if command_verbose {
                    eprintln!("Warning: Optional image download failed: {}", error);
                }
                0
            }
        }
    };
    if let Some(path) = receipt_path.as_deref() {
        record_session_response_outcome(
            path,
            ResponseCompletion::Completed,
            downloaded_image_count,
            None,
        )
        .map_err(|_| "Failed to persist final response receipt")?;
    }

    if command_verbose {
        println!(
            "Copying final response from {} toolbar...",
            provider.display_name()
        );
    }
    match copy_latest_markdown(&config_path, provider) {
        Ok(content) => {
            last_markdown = content;
        }
        Err(e) => {
            eprintln!(
                "Error copying response from {} toolbar: {}",
                provider.display_name(),
                e
            );
        }
    }

    if let Err(e) = render_markdown(&last_markdown, use_glow) {
        eprintln!("Error rendering Markdown: {}", e);
    }

    // Print the URL link of the current conversation thread
    let url_opt = call_mcp_tool(
        &config_path,
        "evaluate_script",
        serde_json::json!({
            "function": "() => window.location.href"
        }),
    )
    .ok()
    .and_then(|url_val| parse_script_result(&url_val).ok())
    .and_then(|u| u.as_str().map(|s| s.to_string()));

    if let Some(url) = url_opt {
        if is_terminal {
            println!("\n🌐 \x1b[1mThread Link:\x1b[0m \x1b[4;36m{}\x1b[0m", url);
        } else {
            println!("\nThread Link: {}", url);
        }
    }

    if let Some(ref output_path) = cli.output {
        if let Err(e) = std::fs::write(output_path, &last_markdown) {
            eprintln!("Error writing output file: {}", e);
        } else if command_verbose {
            println!("Successfully wrote Markdown response to {}", output_path);
        }
    }

    // WAVE-002: after a verified success, close the exact owned tab. This is a
    // supporting, non-gating step: any failure is sanitised to a warning and
    // never changes the success receipt, downloaded images, output files, or
    // process exit success.
    if let Some(path) = receipt_path.as_deref() {
        if let Some(warning) = run_owned_tab_cleanup_warning(&config_path, Some(path)) {
            eprintln!("{}", warning);
        }
    }

    Ok(())
}
