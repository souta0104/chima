# chima

Claude Code または Codex のワーカーをプロジェクトごとに起動する CLI。
ワーカーセッションが context 使用率と経過時間を自覚し、閾値を超えたら
無理に完成を目指さず Linear にチェックポイントを書いて自律停止する。周期起動
される次のクリーンなセッションは、そのチェックポイントだけで文脈を復元して
作業を継続する。人間が Linear や PR に書いたコメントも同じフローで検知され、
AI が反応する。

## アーキテクチャ

コアは AI ツール非依存の CLI `chima` 1 本。部品間の連携は state ディレクトリ・
Linear・tmux のみで、部品同士の直接依存はない。

```
launchd(2分毎) → chima tick ─┬─ 緊急検知: 人間の [今すぐ確認] コメント → chima kick → 再起動
                             └─ 周期判定: due なプロジェクト → chima launch (tmux で worker 起動)
Claude statusline → chima session record    (公式の使用率/経過時間を state へ記録)
Codex hooks       → transcript adapter      (最新 token_count を増分取得して使用率を記録)
PostToolUse hook  → chima guard             (state を読み、閾値超過なら additionalContext 注入)
Stop hook         → chima guard --stop-gate (最新使用率を記録し、チェックポイント未完了なら継続)
worker-run skill  → ワーカーの行動規範 (Linear 運用プロトコル + モデルルーティング)
```

設計の背景・確定事項・各コマンドの詳細仕様は [docs/design.md](docs/design.md) を
参照。

## セットアップ

最初に依存関係を導入してビルドする。

```sh
pnpm install
pnpm build
```

次に chima CLI、共通 `worker-run` skill、Codex hooks を配置する。既存の
`~/.codex/hooks.json` は保持し、同じ hook を二重追加しない。

```sh
./install.sh
```

Claude Code の `PostToolUse` / `Stop` hook と statusline 連携を追加する場合は、
次のオプションを指定する。既存の hook と statusline は保持される。

```sh
./install.sh --enable-claude-code
```

`~/.chima/config/projects.json` に有効なプロジェクトを登録した後、launchd の
定期実行を有効化する。

```sh
./install.sh --enable-launchd
```

両方のオプションは同時に指定できる。プロジェクト設定は
`config/projects.example.json` を参照する。`worker.runtime` は `claude-code`
または `codex` を明示し、自動切替は行わない。

Codex の使用率は transcript の最新 `last_token_usage.total_tokens` と
`model_context_window` から計算する。12,000 tokens を固定で控除し、Codex TUI と
同じ整数丸めを使う。transcript 形式を解釈できない場合は
`usage_source_status: "unsupported"` とし、時間閾値だけで判定を続ける。

## 開発コマンド

```
pnpm build
pnpm test
```
