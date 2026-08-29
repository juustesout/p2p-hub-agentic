# Agent Security & Operational Rules

1. **No Direct Main Commits:** Always work on feature branches named `agent/<feature-name>`.
2. **No Workflow Edits:** Never modify files under `.github/workflows/`.
3. **No Secret Access:** Never write code that attempts to log, export, or print environment variables or secrets.
4. **Preserve Security Gates:** Ensure HostGate anti-DNS rebinding checks, boot-token authentication, and domain separation prefixes remain untouched.
5. **Maintain 100% Green Tests:** All existing 1040+ tests and 32 Rust tests must pass without modification to existing assertion logic.
