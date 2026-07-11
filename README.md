# chima

Claude Code セッションのコンテキスト使用率が上がると品質が落ちる問題に対応する
CLI。ワーカーセッションが context 使用率と経過時間を自覚し、閾値を超えたら
無理に完成を目指さず Linear にチェックポイントを書いて自律停止する。周期起動
される次のクリーンなセッションは、そのチェックポイントだけで文脈を復元して
作業を継続する。人間が Linear や PR に書いたコメントも同じフローで検知され、
AI が反応する。

## アーキテクチャ

コアは AI ツール非依存の CLI `chima` 1 本。部品間の連携は state ディレクトリ・
Linear・tmux のみで、部品同士の直接依存はない。

```
launchd(2分毎) → chima tick ─┬─ 緊急検知: 人間の [今すぐ確認] コメント → chima kick → 再起動
                             └─ 周期判定: due なプロジェクト → chima launch (tmux で claude 起動)
statusline ラッパー → chima session record   (使用率/経過時間を state へ。JSON はパススルー)
PostToolUse hook  → chima guard              (state を読み、閾値超過なら additionalContext 注入)
Stop hook         → chima guard --stop-gate  (チェックポイント未記録の停止を 1 回だけブロック)
worker-run skill  → ワーカーの行動規範 (Linear 運用プロトコル + モデルルーティング)
```

設計の背景・確定事項・各コマンドの詳細仕様は [docs/design.md](docs/design.md) を
参照。

## セットアップ

`install.sh` (bin の symlink 配置、`~/.chima` 初期化、launchd 登録、
`settings.json` への hooks/statusline 追記ガイド表示) は未実装。DEV-16 で追加予定。
現時点で手動セットアップする場合は、`docs/design.md` の「リポジトリ構成」
「state / 設定」節を参照して `~/.chima/config/projects.json` 等を直接用意する
必要がある。

## 開発コマンド

```
pnpm build
pnpm test
```
