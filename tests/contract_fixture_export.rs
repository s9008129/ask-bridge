#[allow(dead_code, clippy::all)]
#[path = "../src/main.rs"]
mod ask_bridge;

use ask_bridge::{
    AttachmentExpectations, AttachmentProbeSummary, ExpectedOutputType,
    GEMINI_LIVE_PHASE0B_VERIFIED, ModelSelectionContract, ModelSelectionEvidence,
    ModelSelectionOutcome, PromptSubmissionFailureDisposition, Provider, ResponseCompletion,
    ResponseFailureCode, SessionReceipt, SessionReceiptEvent, TypedAttachmentProbe,
    capabilities_value, capabilities_value_with_gemini_verified, record_auth_failed,
    record_model_selection_failed_for_provider, record_model_selection_verified,
    record_prompt_submission_failure, record_session_receipt_event,
    record_session_response_outcome, write_attachment_probe_receipt, write_private_json,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

fn make_temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "ask-bridge-contract-export-{}-{}",
        label,
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn export_fixture(dir: &Path, name: &str, value: &Value) {
    let content = serde_json::to_string_pretty(value).unwrap() + "\n";
    std::fs::write(dir.join(name), content).unwrap();
}

fn build_fixtures() -> Vec<(&'static str, Value)> {
    let scratch = make_temp_dir("receipts");

    let capabilities_unverified = capabilities_value_with_gemini_verified(false);
    let capabilities_verified = capabilities_value();

    // 1. Legacy ChatGPT receipt (without `provider`, simulating existing receipts).
    let chatgpt_legacy_path = scratch.join("chatgpt_legacy.json");
    let chatgpt_legacy = SessionReceipt::new_for_output(1, 512, ExpectedOutputType::Text);
    write_private_json(&chatgpt_legacy_path, &chatgpt_legacy).unwrap();
    record_session_receipt_event(
        &chatgpt_legacy_path,
        SessionReceiptEvent::AttachmentsVerified,
    )
    .unwrap();
    record_session_receipt_event(
        &chatgpt_legacy_path,
        SessionReceiptEvent::PromptIntentRecorded,
    )
    .unwrap();
    record_session_receipt_event(&chatgpt_legacy_path, SessionReceiptEvent::PromptSubmitted)
        .unwrap();
    record_session_response_outcome(&chatgpt_legacy_path, ResponseCompletion::Completed, 0, None)
        .unwrap();
    let chatgpt_legacy_val: Value =
        serde_json::from_slice(&std::fs::read(&chatgpt_legacy_path).unwrap()).unwrap();

    // 2. Current ChatGPT receipt with `provider: "chatgpt"` and v6 model selection.
    let chatgpt_current_path = scratch.join("chatgpt_current.json");
    let chatgpt_current =
        SessionReceipt::new_for_provider(Provider::ChatGpt, 1, 512, ExpectedOutputType::Image);
    write_private_json(&chatgpt_current_path, &chatgpt_current).unwrap();
    record_model_selection_verified(
        &chatgpt_current_path,
        ModelSelectionOutcome {
            contract: ModelSelectionContract::ReasoningLabeledOrderedControlV4,
            evidence: ModelSelectionEvidence::LabeledEffortPositionMapV1,
            direct_semantic_count: Some(3),
            position_count: Some(4),
        },
    )
    .unwrap();
    record_session_receipt_event(
        &chatgpt_current_path,
        SessionReceiptEvent::AttachmentsVerified,
    )
    .unwrap();
    record_session_receipt_event(
        &chatgpt_current_path,
        SessionReceiptEvent::PromptIntentRecorded,
    )
    .unwrap();
    record_session_receipt_event(&chatgpt_current_path, SessionReceiptEvent::PromptSubmitted)
        .unwrap();
    record_session_response_outcome(
        &chatgpt_current_path,
        ResponseCompletion::Completed,
        1,
        None,
    )
    .unwrap();
    let chatgpt_current_val: Value =
        serde_json::from_slice(&std::fs::read(&chatgpt_current_path).unwrap()).unwrap();

    // 2b. Candidate unverified Gemini runtime receipt (explicitly `gemini_verified = false`, omits `verified_gemini_image_workflow_v1`).
    let gemini_candidate_unverified_path = scratch.join("gemini_candidate_unverified.json");
    let gemini_candidate_unverified = SessionReceipt::new_for_provider_with_gemini_verified(
        Provider::Gemini,
        1,
        1024,
        ExpectedOutputType::Text,
        false,
    );
    write_private_json(
        &gemini_candidate_unverified_path,
        &gemini_candidate_unverified,
    )
    .unwrap();
    record_session_receipt_event(
        &gemini_candidate_unverified_path,
        SessionReceiptEvent::AttachmentsVerified,
    )
    .unwrap();
    record_session_receipt_event(
        &gemini_candidate_unverified_path,
        SessionReceiptEvent::PromptIntentRecorded,
    )
    .unwrap();
    record_session_receipt_event(
        &gemini_candidate_unverified_path,
        SessionReceiptEvent::PromptSubmitted,
    )
    .unwrap();
    record_session_response_outcome(
        &gemini_candidate_unverified_path,
        ResponseCompletion::Completed,
        0,
        None,
    )
    .unwrap();
    let gemini_candidate_unverified_val: Value =
        serde_json::from_slice(&std::fs::read(&gemini_candidate_unverified_path).unwrap()).unwrap();

    // 3. Simulated-verified Gemini text success receipt.
    let gemini_text_path = scratch.join("gemini_text.json");
    let gemini_text = SessionReceipt::new_for_provider_with_gemini_verified(
        Provider::Gemini,
        1,
        1024,
        ExpectedOutputType::Text,
        true,
    );
    write_private_json(&gemini_text_path, &gemini_text).unwrap();
    record_model_selection_verified(
        &gemini_text_path,
        ModelSelectionOutcome {
            contract: ModelSelectionContract::GeminiModeMenuV1,
            evidence: ModelSelectionEvidence::GeminiMenuCheckedV1,
            direct_semantic_count: None,
            position_count: None,
        },
    )
    .unwrap();
    record_session_receipt_event(&gemini_text_path, SessionReceiptEvent::AttachmentsVerified)
        .unwrap();
    record_session_receipt_event(&gemini_text_path, SessionReceiptEvent::PromptIntentRecorded)
        .unwrap();
    record_session_receipt_event(&gemini_text_path, SessionReceiptEvent::PromptSubmitted).unwrap();
    record_session_response_outcome(&gemini_text_path, ResponseCompletion::Completed, 0, None)
        .unwrap();
    let gemini_text_val: Value =
        serde_json::from_slice(&std::fs::read(&gemini_text_path).unwrap()).unwrap();

    // 4. Simulated-verified Gemini mixed attachment image success receipt.
    let gemini_image_path = scratch.join("gemini_mixed_image.json");
    let gemini_image = SessionReceipt::new_for_provider_with_gemini_verified(
        Provider::Gemini,
        2,
        4096,
        ExpectedOutputType::Image,
        true,
    );
    write_private_json(&gemini_image_path, &gemini_image).unwrap();
    let expectations =
        AttachmentExpectations::new(&["slide_prompt.md".to_string()], &["s01.png".to_string()])
            .unwrap();
    let probe = TypedAttachmentProbe {
        document_count: 1,
        missing_documents: 0,
        unexpected_documents: 0,
        image_count: 1,
        image_loaded: true,
        uploading: false,
        provider_error: false,
    };
    write_attachment_probe_receipt(
        &gemini_image_path,
        &AttachmentProbeSummary::new(&expectations, &probe),
    )
    .unwrap();
    record_session_receipt_event(&gemini_image_path, SessionReceiptEvent::AttachmentsVerified)
        .unwrap();
    record_session_receipt_event(
        &gemini_image_path,
        SessionReceiptEvent::PromptIntentRecorded,
    )
    .unwrap();
    record_session_receipt_event(&gemini_image_path, SessionReceiptEvent::PromptSubmitted).unwrap();
    record_session_response_outcome(&gemini_image_path, ResponseCompletion::Completed, 1, None)
        .unwrap();
    let gemini_image_val: Value =
        serde_json::from_slice(&std::fs::read(&gemini_image_path).unwrap()).unwrap();

    // 5. Simulated-verified Gemini auth failure receipt (safe).
    let gemini_auth_fail_path = scratch.join("gemini_auth_fail.json");
    write_private_json(
        &gemini_auth_fail_path,
        &SessionReceipt::new_for_provider_with_gemini_verified(
            Provider::Gemini,
            1,
            256,
            ExpectedOutputType::Text,
            true,
        ),
    )
    .unwrap();
    record_auth_failed(&gemini_auth_fail_path, "GEMINI_AUTH_NOT_CONFIRMED").unwrap();
    let gemini_auth_fail_val: Value =
        serde_json::from_slice(&std::fs::read(&gemini_auth_fail_path).unwrap()).unwrap();

    // 6. Simulated-verified Gemini model selection failure receipt (safe).
    let gemini_model_fail_path = scratch.join("gemini_model_fail.json");
    write_private_json(
        &gemini_model_fail_path,
        &SessionReceipt::new_for_provider_with_gemini_verified(
            Provider::Gemini,
            1,
            256,
            ExpectedOutputType::Image,
            true,
        ),
    )
    .unwrap();
    record_model_selection_failed_for_provider(&gemini_model_fail_path, Provider::Gemini).unwrap();
    let gemini_model_fail_val: Value =
        serde_json::from_slice(&std::fs::read(&gemini_model_fail_path).unwrap()).unwrap();

    // 7. Simulated-verified Gemini preclick submission failure receipt (safe).
    let gemini_preclick_fail_path = scratch.join("gemini_preclick_fail.json");
    write_private_json(
        &gemini_preclick_fail_path,
        &SessionReceipt::new_for_provider_with_gemini_verified(
            Provider::Gemini,
            1,
            256,
            ExpectedOutputType::Text,
            true,
        ),
    )
    .unwrap();
    record_session_receipt_event(
        &gemini_preclick_fail_path,
        SessionReceiptEvent::AttachmentsVerified,
    )
    .unwrap();
    record_session_receipt_event(
        &gemini_preclick_fail_path,
        SessionReceiptEvent::PromptIntentRecorded,
    )
    .unwrap();
    record_prompt_submission_failure(
        &gemini_preclick_fail_path,
        PromptSubmissionFailureDisposition::SafeBeforeClick,
        None,
    )
    .unwrap();
    let gemini_preclick_fail_val: Value =
        serde_json::from_slice(&std::fs::read(&gemini_preclick_fail_path).unwrap()).unwrap();

    // 8. Simulated-verified Gemini post-click unknown submission failure receipt (unsafe).
    let gemini_unknown_fail_path = scratch.join("gemini_unknown_fail.json");
    write_private_json(
        &gemini_unknown_fail_path,
        &SessionReceipt::new_for_provider_with_gemini_verified(
            Provider::Gemini,
            1,
            256,
            ExpectedOutputType::Text,
            true,
        ),
    )
    .unwrap();
    record_session_receipt_event(
        &gemini_unknown_fail_path,
        SessionReceiptEvent::AttachmentsVerified,
    )
    .unwrap();
    record_session_receipt_event(
        &gemini_unknown_fail_path,
        SessionReceiptEvent::PromptIntentRecorded,
    )
    .unwrap();
    record_prompt_submission_failure(
        &gemini_unknown_fail_path,
        PromptSubmissionFailureDisposition::UnknownAfterClick,
        Some(ResponseFailureCode::PromptSubmissionStateUnknown),
    )
    .unwrap();
    let gemini_unknown_fail_val: Value =
        serde_json::from_slice(&std::fs::read(&gemini_unknown_fail_path).unwrap()).unwrap();

    // 8b. Simulated-verified Gemini text extraction failed receipt (response_failure_code: text_extraction_failed).
    let gemini_text_extract_fail_path = scratch.join("gemini_text_extract_fail.json");
    write_private_json(
        &gemini_text_extract_fail_path,
        &SessionReceipt::new_for_provider_with_gemini_verified(
            Provider::Gemini,
            1,
            1024,
            ExpectedOutputType::Text,
            true,
        ),
    )
    .unwrap();
    record_model_selection_verified(
        &gemini_text_extract_fail_path,
        ModelSelectionOutcome {
            contract: ModelSelectionContract::GeminiModeMenuV1,
            evidence: ModelSelectionEvidence::GeminiMenuCheckedV1,
            direct_semantic_count: None,
            position_count: None,
        },
    )
    .unwrap();
    record_session_receipt_event(
        &gemini_text_extract_fail_path,
        SessionReceiptEvent::AttachmentsVerified,
    )
    .unwrap();
    record_session_receipt_event(
        &gemini_text_extract_fail_path,
        SessionReceiptEvent::PromptIntentRecorded,
    )
    .unwrap();
    record_session_receipt_event(
        &gemini_text_extract_fail_path,
        SessionReceiptEvent::PromptSubmitted,
    )
    .unwrap();
    record_session_response_outcome(
        &gemini_text_extract_fail_path,
        ResponseCompletion::Unknown,
        0,
        Some(ResponseFailureCode::TextExtractionFailed),
    )
    .unwrap();
    let gemini_text_extract_fail_val: Value =
        serde_json::from_slice(&std::fs::read(&gemini_text_extract_fail_path).unwrap()).unwrap();

    // 9. Claude compatible receipt (provider: "claude").
    let claude_path = scratch.join("claude_compat.json");
    write_private_json(
        &claude_path,
        &SessionReceipt::new_for_provider(Provider::Claude, 1, 512, ExpectedOutputType::Text),
    )
    .unwrap();
    record_session_receipt_event(&claude_path, SessionReceiptEvent::AttachmentsVerified).unwrap();
    record_session_receipt_event(&claude_path, SessionReceiptEvent::PromptIntentRecorded).unwrap();
    record_session_receipt_event(&claude_path, SessionReceiptEvent::PromptSubmitted).unwrap();
    record_session_response_outcome(&claude_path, ResponseCompletion::Completed, 0, None).unwrap();
    let claude_val: Value = serde_json::from_slice(&std::fs::read(&claude_path).unwrap()).unwrap();

    let _ = std::fs::remove_dir_all(&scratch);

    vec![
        (
            "capabilities_candidate_unverified.json",
            capabilities_unverified,
        ),
        (
            "capabilities_simulated_verified.json",
            capabilities_verified,
        ),
        ("receipt_chatgpt_legacy.json", chatgpt_legacy_val),
        ("receipt_chatgpt_current.json", chatgpt_current_val),
        (
            "receipt_gemini_candidate_unverified.json",
            gemini_candidate_unverified_val,
        ),
        ("receipt_gemini_text.json", gemini_text_val),
        ("receipt_gemini_mixed_image.json", gemini_image_val),
        ("receipt_gemini_auth_failed.json", gemini_auth_fail_val),
        ("receipt_gemini_model_failed.json", gemini_model_fail_val),
        (
            "receipt_gemini_preclick_failed.json",
            gemini_preclick_fail_val,
        ),
        (
            "receipt_gemini_unknown_failed.json",
            gemini_unknown_fail_val,
        ),
        (
            "receipt_gemini_text_extraction_failed.json",
            gemini_text_extract_fail_val,
        ),
        ("receipt_claude_compat.json", claude_val),
    ]
}

fn git_head_commit() -> String {
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .expect("failed to execute `git rev-parse HEAD`");
    assert!(
        output.status.success(),
        "`git rev-parse HEAD` failed with status {}",
        output.status
    );
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    assert!(
        sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit()),
        "expected 40-char git HEAD SHA, got {sha:?}"
    );
    sha
}

fn git_working_tree_dirty() -> bool {
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .expect("failed to execute `git status --porcelain`");
    assert!(
        output.status.success(),
        "`git status --porcelain` failed with status {}",
        output.status
    );
    !String::from_utf8_lossy(&output.stdout).trim().is_empty()
}

#[test]
fn contract_fixtures_serialize_valid_provider_contracts() {
    let fixtures = build_fixtures();
    assert_eq!(fixtures.len(), 13);
    let unverified_caps = fixtures
        .iter()
        .find(|(name, _)| *name == "capabilities_candidate_unverified.json")
        .map(|(_, v)| v)
        .unwrap();
    assert!(
        !unverified_caps["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("verified_gemini_image_workflow_v1"))
    );
    assert!(
        unverified_caps
            .get("verified_gemini_image_workflow_v1")
            .is_none()
    );

    let verified_caps = fixtures
        .iter()
        .find(|(name, _)| *name == "capabilities_simulated_verified.json")
        .map(|(_, v)| v)
        .unwrap();
    assert!(
        verified_caps["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("verified_gemini_image_workflow_v1"))
    );

    let claude = fixtures
        .iter()
        .find(|(name, _)| *name == "receipt_claude_compat.json")
        .map(|(_, v)| v)
        .unwrap();
    assert_eq!(claude["provider"].as_str(), Some("claude"));
}

#[test]
#[ignore]
fn export_contract_fixtures_to_env_dir() {
    let out_dir = std::env::var("ASK_BRIDGE_EXPORT_CONTRACT_FIXTURES")
        .expect("ASK_BRIDGE_EXPORT_CONTRACT_FIXTURES must be set");
    let out_path = Path::new(&out_dir);
    std::fs::create_dir_all(out_path).unwrap();

    // Remove legacy single capabilities.json if present from prior export format.
    let legacy_caps = out_path.join("capabilities.json");
    if legacy_caps.exists() {
        let _ = std::fs::remove_file(&legacy_caps);
    }

    let fixtures = build_fixtures();
    for (name, value) in &fixtures {
        export_fixture(out_path, name, value);
    }
    let metadata = json!({
        "schema_version": 2,
        "producer": "ask-bridge",
        "producer_version": env!("CARGO_PKG_VERSION"),
        "producer_commit": git_head_commit(),
        "producer_dirty": git_working_tree_dirty(),
        "gemini_live_phase0b_verified": GEMINI_LIVE_PHASE0B_VERIFIED,
        "candidate_unverified_fixtures": [
            "capabilities_candidate_unverified.json",
            "receipt_gemini_candidate_unverified.json"
        ],
        "simulated_verified_fixtures": [
            "capabilities_simulated_verified.json",
            "receipt_gemini_text.json",
            "receipt_gemini_mixed_image.json",
            "receipt_gemini_auth_failed.json",
            "receipt_gemini_model_failed.json",
            "receipt_gemini_preclick_failed.json",
            "receipt_gemini_unknown_failed.json",
            "receipt_gemini_text_extraction_failed.json"
        ],
        "fixtures": fixtures.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
    });
    export_fixture(out_path, "manifest.json", &metadata);
    println!(
        "Exported {} contract fixtures to {}",
        fixtures.len(),
        out_path.display()
    );
}
