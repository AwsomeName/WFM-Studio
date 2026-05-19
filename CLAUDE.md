# WFM Studio — Project Rules

## Mandatory Rules

### 1. Do NOT change approach without user confirmation

When implementing a feature, if you want to switch from the agreed-upon approach to a different approach (e.g., replacing a third-party library with a custom implementation), you MUST:

1. **Stop and present the proposed change to the user** with pros/cons analysis
2. **Wait for explicit user approval** before proceeding
3. Never silently replace one solution with another

**Why:** Past incidents where the AI silently switched approaches (e.g., replacing a proven third-party render pipeline with a custom VTK renderer) led to wasted time, lower quality results, and user frustration. The user needs to understand and approve architectural decisions.

**How to apply:** Before making any change that substitutes one library/tool/approach for another, ask the user first. This includes switching between dependencies, replacing third-party code with custom code, or changing the architecture of an already-agreed plan.

### 2. Confirm before installing large dependencies

Any dependency that requires downloading more than 50MB (e.g., Chromium browser, large ML models) must be confirmed with the user before installation.
