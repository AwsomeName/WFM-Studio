# Anthropic Python SDK（vendor）

通过 **`git subtree --squash`** 从 `https://github.com/anthropics/anthropic-sdk-python` 纳入，当前与上游 tag **`v0.80.0`**（commit `4de03c2`）对齐。

业务侧通过 [`wfm-agents/pyproject.toml`](../../wfm-agents/pyproject.toml) 的 `[tool.uv.sources]` 以 **path + editable** 使用本目录，不再使用 submodule。

## 同步上游

在仓库根目录执行（将 `vX.Y.Z` 换成目标 tag 或分支）：

```bash
git subtree pull --prefix=third_party/anthropics/anthropic-sdk-python \
  https://github.com/anthropics/anthropic-sdk-python.git vX.Y.Z --squash
```

## 定制约定

对 vendor 目录的改动请用**独立 commit**，便于与 `subtree pull` 冲突时对账（与 `third_party/agents/README.md` 一致）。
