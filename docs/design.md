# chima 設計ドキュメント

## Context (なぜ作るか)

Claude Code のセッションはコンテキストが 40% を超えたあたりから品質が落ちる。
現状ユーザーは Linear イシューに手動で進捗ログを書き、セッションを作り直す運用を
している。これを自動化する。目指す状態:

- セッション自身が context 使用率と経過時間を検知し、閾値超過で「無理に完成を
  目指さず、現状を Linear に示し切って停止する」動きを強制される
- 周期起動 (例: 30 分毎、20 分作業 + 10 分クールダウン) されるクリーンな新セッション
  が、Linear のチェックポイントコメントだけで文脈をゼロから復元して作業を継続する
- 人間の Linear コメント・PR レビューコメントも同じフローで検知され、AI が反応する
- 1 つの巨大な仕組みではなく、疎結合なシンプルな仕組みの連動で実現する

## 確定事項 (全決定の記録)

1. 実行環境: ローカル Mac で「対話型」の `claude` セッションを tmux 起動する。
   subscription plan のまま使うため headless API ではなく対話型。実行システム自体は
   原始的な仕組みでよい (launchd + tmux + シェル起動)
2. タスク源: プロジェクトごとに Linear 親イシューを固定指定。ワーカーはその配下の
   ブロッカーなし・未完了サブイシューを自動選択して着手。人間の新規コメントが
   あればその対応を最優先
3. コメント対応は 2 レーン:
   - `[今すぐ確認]` を含むコメント → 実行中ワーカーを即 kick (収束処理を走らせて
     終了) → 直後に新ワーカーを再起動して対応させる
   - 通常コメント → 次周期のワーカーが起動時に拾えばよい
   - どちらも、対応したら当該コメントへ「明示的に返信」することで完了とする
4. 並列度: 30 分単位の親ワーカーは 1 プロジェクト 1 セッション。並列化はワーカー
   内部で codex CLI や agent team へのオーケストレーションとして行う。将来の
   親ワーカー自体の並列化 (worktree 単位) は妨げない設計にする
5. アーキテクチャ: 疎結合 5 コンポーネント (tracker / guard / dispatcher /
   urgent poller / worker skill)。ただし後述の通りコアを CLI 1 本に集約
6. 置き場所: 専用の新規リポジトリ
7. 権限モード: auto (現在の defaultMode と同じ)。無人で承認プロンプトに当たったら
   そこで止まらず、「承認待ちで進めなかった」ことを Linear に記録して人間に依頼する
8. モデル役割分担: 毎サイクル「plan/strategizing (fable) → work (sonnet5 指揮)」。
   詳細は worker-run skill 節
9. コアは AI ツール非依存の単一 CLI (名前: chima)。Claude Code 側は hook / statusline
   / skill の薄いコネクタのみ。将来 web console で可視化しやすい素の JSON state
10. TypeScript + pnpm。実装は agent-orchestrator skill を積極活用して進める
11. 仕組み・実装ともに過剰にしない (削った点は「過剰回避の決定」節に明記)
12. 人間がやるべきこと / AI が頑張ることをプロジェクトごとに明示設定できる
    (policy 設定)
13. Linear へは OAuth Application (actor=app) の Agent (Bot user) として接続する
14. chima の開発自体を chima のフロー (Linear 親イシュー + サブイシュー +
    チェックポイント運用) で進める (ドッグフーディング)

## 技術的根拠 (公式ドキュメント調査の結果)

設計判断の背景となる確定事実。出典は code.claude.com/docs と `claude --help`。

- statusline への stdin JSON には以下が入る (docs/en/statusline.md):
  - `context_window.used_percentage` / `remaining_percentage` (使用率が計算済み)
  - `context_window.total_input_tokens`, `context_window.context_window_size`
  - `cost.total_duration_ms` (セッション開始からの経過ミリ秒), `cost.total_cost_usd`
  - `session_id`
  → 使用量検知の一次情報源は statusline。これが最も正確で公式な入口
- hook (PreToolUse / PostToolUse / Stop / SessionStart 等) の stdin には context
  使用量は入らない (docs/en/hooks.md)。session_id と transcript_path は入る。
  transcript JSONL のパースは「バージョン間で形式が変わる」と明記された非公式手段
  なので採用しない
  → hook は自力で使用量を知れないため、statusline が書いた state ファイルを読む
- PostToolUse hook は stdout JSON の
  `hookSpecificOutput.additionalContext` でセッション中の Claude に文脈を注入できる
  → 「40% 超えたから収束せよ」の注入経路
- Stop hook は `decision: "block"` + `reason` で停止をブロックし差し戻せる
  → 「チェックポイントを Linear に書くまで終わらせない」ゲートに使える
- `--max-turns` は存在しない (claude --help で確認)。ターン数での強制打ち切りは
  不可能なので、時間と使用率ベースで制御する
- 対話セッションは `tmux new-session -d` で起動でき、`tmux send-keys` で実行中
  セッションにメッセージを注入できる (kick の実現手段)
- クラウド routines はローカル repo・ローカル MCP 認証にアクセスできず、
  subscription 前提の「ローカル対話型」方針と合わないため不採用
- launchd の StartInterval ジョブは Mac スリープ中は発火せず復帰後に走る。
  周期の多少のズレは仕組み上許容する

## アーキテクチャ全体像

コアは AI 非依存の CLI `chima` 1 本。部品間の連携は state ディレクトリ・Linear・
tmux のみで、部品同士の直接依存はない。

```
launchd(2分毎) → chima tick ─┬─ 緊急検知: 人間の [今すぐ確認] コメント → chima kick → 再起動
                             └─ 周期判定: due なプロジェクト → chima launch (tmux で claude 起動)
statusline ラッパー → chima session record   (使用率/経過時間を state へ。JSON はパススルー)
PostToolUse hook  → chima guard              (state を読み、閾値超過なら additionalContext 注入)
Stop hook         → chima guard --stop-gate  (チェックポイント未記録の停止を 1 回だけブロック)
worker-run skill  → ワーカーの行動規範 (Linear 運用プロトコル + モデルルーティング)
```

将来の web console は `chima status --json` と state/ の JSON を読むだけで作れる。
そのために state は人間可読な素の JSON に保ち、CLI にすべてのロジックを寄せる
(AI ツールへの依存を connector 層に閉じ込める)。

## リポジトリ構成 (新規 repo `chima`)

```
chima/
  package.json               # pnpm。devDeps は typescript + vitest 程度
  tsconfig.json
  src/                       # TS 実装。commands/ ごとに分割。tsc で dist/ へビルド
  bin/chima                  # node dist/cli.js を呼ぶ shim
  connectors/claude-code/
    hooks/context-guard.sh   # PostToolUse: stdin をそのまま chima guard へ中継
    hooks/stop-gate.sh       # Stop: stdin を chima guard --stop-gate へ中継
    statusline-wrapper.sh    # stdin JSON を chima session record に通し、
                             # 出力を既存 ~/.claude/statusline-command.sh へパイプ。
                             # 既存の statusline 表示は一切変えない
    skills/worker-run/SKILL.md
    settings.snippet.json    # settings.json に追記する hooks 設定の見本
  launchd/com.chima.tick.plist   # StartInterval 120 で chima tick
  config/projects.example.json
  install.sh                 # bin の symlink 配置、~/.chima 初期化、launchctl load、
                             # settings.json への hooks/statusline 追記ガイド表示
  docs/design.md             # 本設計の清書 (背景・根拠込み)
  README.md
```

ランタイム依存はゼロにする。Linear は Node 組み込みの fetch で GraphQL を直叩き
(SDK 不使用)。GitHub は `gh` CLI を子プロセス実行。

## state / 設定 (`~/.chima/`)

Claude 非依存を明示するため ~/.claude の外に置く。

```
~/.chima/
  config/projects.json           # プロジェクト定義 (下記スキーマ)
  config/credentials.json        # Linear OAuth token (chmod 600)
  state/sessions/<session_id>.json
      # statusline が毎回上書き:
      # { used_pct, duration_ms, updated_at, project? (CHIMA_PROJECT があれば) }
  state/projects/<name>.json
      # { last_run, last_seen_comment_at,
      #   lock: { tmux_session, started_at } | null,
      #   wrapup_requested_at, checkpoint_done_at,
      #   last_result: "done" | "killed" | "crashed" }
  state/pending/<name>.md        # Linear 不通時のチェックポイント退避 (上書き 1 枚)
  logs/                          # tick / launch / kick の実行ログ (日付ローテ)
```

## Linear 接続: OAuth Application (actor=app) の Agent

chima は人間の API key ではなく、Linear の OAuth Application を actor=app で導入
した Agent (Bot user) として読み書きする。

- 効果:
  - コメント・イシュー操作が chima 名義になり、人間の書き込みと構造的に区別できる。
    緊急検知・未対応コメント判定が「author が chima 以外」だけで済む
  - chima を @mention でき、イシューを chima に assign できる (app:mentionable /
    app:assignable scope)
  - Agent は課金対象ユーザーに数えられない
- scope: read / write / app:mentionable / app:assignable
- 認証: `chima linear auth` (一度きり)。localhost リダイレクトで OAuth code を受け、
  token を `~/.chima/config/credentials.json` (0600) に保存
- 人間への通知: Bot からのコメント Markdown に人間のプロフィール URL
  (`https://linear.app/<workspace>/profiles/<user>`) を埋めると正式メンションに変換
  され通知が届く。依頼コメントでは必ずこれを使う
- worker セッションの Linear 読み書きは chima CLI 経由に統一して全て Bot 名義に
  する。Linear MCP は人間名義になるため worker では使わない (人間の対話セッション
  での ad-hoc 利用は従来どおり)
- OAuth Application の作成 (Settings → API) と workspace への導入承認は人間の作業。
  actor=app を付けない通常 OAuth や API key では操作が人間名義になる点が要注意
- Linear の Agent API (Webhook, Agent session events) は Developer Preview のため
  使わない。検知はポーリングのまま。webhook 即応は将来スコープ

## `chima` サブコマンド仕様

- `chima tick` — 唯一の launchd エントリ (2 分毎)。処理順:
  1. 緊急検知: 各 enabled プロジェクトについて、last_seen_comment_at 以降の
     Linear コメント (親イシュー + 全サブイシュー、author が chima 以外) と、
     関連 PR の新規レビューコメント (`gh api`) を取得。`[今すぐ確認]` を含むものが
     あれば: 実行中なら `chima kick --reason "<コメント URL>"` + restart 予約フラグ、
     非実行中なら即 `chima launch`。last_seen_comment_at を更新
  2. lock 管理: lock があるのに tmux セッションが消えていれば crashed として記録し
     lock 解除。done マーカー (checkpoint_done_at) 付きの tmux セッションは kill して
     掃除。作業予算超過なら kick、kick 後 5 分の猶予を過ぎても生きていれば
     tmux kill + last_result=killed を記録
  3. 周期起動: due (前回起動から interval_min 経過 && enabled && active_hours 内
     && lock なし) のプロジェクト、および restart 予約のあるプロジェクトを launch
- `chima launch <project>` —
  `tmux new-session -d -s chima-<project> -c <repo>` で
  `CHIMA_PROJECT=<name> claude --permission-mode auto --model <orchestrator_model>
  "/worker-run <project>"` を起動し、lock (tmux セッション名 + started_at) を記録。
  CHIMA_PROJECT は claude の子プロセスである hook / statusline にも継承されるので、
  これが「ワーカーセッションかどうか」の判定フラグになる
- `chima kick <project> [--reason <text>]` — tmux send-keys で実行中セッションに
  収束指示メッセージを送る。文面: 「収束指示: <reason>。新規作業を止めて worker-run
  の収束プロトコルを今すぐ実行して終了してください」。state に wrapup_requested_at
  を記録 (stop-gate の判定材料)
- `chima session record` — statusline の stdin JSON から session_id /
  context_window.used_percentage / cost.total_duration_ms を state へ書き、
  元 JSON をそのまま stdout へ (パススルー設計により既存 statusline と共存)
- `chima guard` — PostToolUse hook の stdin JSON を受ける。CHIMA_PROJECT が
  なければ何も出力せず終了 (人間のセッションには無反応)。あれば
  state/sessions/<session_id>.json と projects.json の閾値を照合し、
  used_pct >= context_threshold_pct または duration >= work_budget_min なら
  `hookSpecificOutput.additionalContext` で収束指示を出力。注入は初回 + その後
  2 分に 1 回まで (フラグファイルでスロットリング)。注入時に wrapup_requested_at
  も記録する
- `chima guard --stop-gate` — Stop hook 用。wrapup_requested_at があるのに
  checkpoint_done_at がない場合のみ `decision: "block"` +
  reason「Linear へのチェックポイント記録が未完了。収束プロトコルを完了させてから
  終了して」を返す。ブロックは 1 セッション 1 回だけ (無限ループ防止)
- `chima checkpoint done <project>` — worker が収束プロトコル完了時に呼ぶ。
  checkpoint_done_at (= done マーカー) を記録。次の tick が tmux を掃除する
  (対話型 claude は自力で終了できないため、この二段構えで後始末する)
- `chima status [--json]` — 全プロジェクトの lock / 直近実行 / last_result /
  実行中セッションの使用率・経過時間を表示。web console の将来の読み取り口
- `chima linear auth` — OAuth (actor=app) の一度きりの認証フロー
- `chima linear <read/write 系>` — worker が使う最小セット:
  issue 取得 (description / children / blocker / コメント含む)、comment 作成
  (スレッド返信対応)、issue 作成・更新 (状態 / blocker / assignee / description)。
  すべて Bot 名義。GraphQL 直叩き

## projects.json スキーマ (例)

```json
{
  "projects": [{
    "name": "magonote",
    "repo": "/path/to/your-project",
    "parent_issue": "PROJ-10",
    "interval_min": 30,
    "work_budget_min": 20,
    "context_threshold_pct": 40,
    "active_hours": "09-24",
    "orchestrator_model": "claude-sonnet-5",
    "planner_model": "claude-fable-5",
    "enabled": true,
    "policy": {
      "ai_should_try": [
        "アカウント登録や外部サービスの設定変更もまず自分で試す"
      ],
      "delegate_to_human": [
        "本番環境へのデプロイと課金が発生する操作は即 Linear で依頼する"
      ]
    }
  }]
}
```

- 周期・作業予算・閾値・稼働時間帯・モデルはすべてプロジェクト単位。
  「常に 30 分毎に動き続けるのは変」問題はこの設定で解決する
- policy は自由記述の文字列リスト。「AI が頑張ってみること」と「即人間に依頼する
  こと」の分担をプロジェクトごとに明示する。worker-run が起動時に読み込み、判断に
  迷う操作はこのポリシーに照らして「頑張る」か「即依頼」かを決める

## worker-run skill (ワーカーの行動規範)

connectors/claude-code/skills/worker-run/SKILL.md に定義する。chima の頭脳部分。

### 1. 起動ルーチン

- `chima status --json` と projects.json で自分の設定 (作業予算・閾値・policy) を確認
- state/pending/ に未投稿チェックポイントがあれば最初に Linear へ投稿 (前回の
  Linear 不通時の退避分)
- 前回が last_result=crashed / killed なら、「前回セッションは異常終了した」旨を
  親イシューにコメントし、git の状態 (branch / 未 push の diff) と最新チェック
  ポイントから状況を再構築する
- Linear (chima CLI 経由) から取得: 親イシュー description、全サブイシュー
  (状態 / blocker / assignee)、前回チェックポイント以降の人間コメント。
  GitHub (`gh`) から取得: 関連 PR の新規レビューコメント

### 2. タスク選択

- 最優先: 未対応の人間コメント (Linear / PR レビュー) への対応。対応が終わったら
  必ず当該コメントへスレッド返信して完了を明示する。返信するまでは完了扱いしない
- 次点: blocker なし・未完了のサブイシューを 1 つ選び、In Progress にして着手
- 進められるものがなければ: 状況をチェックポイントに記して早期収束してよい

### 3. モデルルーティング (毎サイクル plan → work の 2 フェーズ)

親セッションは sonnet5 で起動される。agent-orchestrator skill の委譲則を下敷きに、
以下のルーティングを優先する。

- plan/strategizing フェーズ (毎サイクル冒頭で必ず実施):
  fable の Plan サブエージェントに、チェックポイント・イシュー状況・policy を渡して
  今サイクルの戦略・タスク分解・完了条件を作らせる。fable にはコーディング・調査・
  リーディングをさせない (高価で、抽象的な問題を詰める advisor / plan 専任)
- work フェーズ: sonnet5 (親) が指揮を執り、委譲する。各モデルの特性:
  - codex exec (gpt-5.6-sol, effort medium): 明確化されたコーディング、論理で答えが
    固定される課題、独立レビュー。ミクロに寄りがちだが頭は良い。すぐ止まるので
    ゴールと完了条件を明示して指示する (goal command を徹底)。context compact が
    優秀なのでガンガン compact して長く使ってよい。起動は codex-cli skill の作法
    (`< /dev/null` 必須) に従う
  - sonnet5 サブエージェント: 通常のシンプルなコーディング (codex に次ぐ)。
    日本語がわかりやすいので、日本語アウトプット (Linear コメント等) の生成にも向く
  - haiku サブエージェント: スコープを絞った調査・探索。速く安い。絞って渡せば上手い
  - fable サブエージェント: 抽象的な問題が詰まったときの advisor、プラン再検討
  - opus サブエージェント: 広い視野での方針提示・先読み。ただしやや精度が低いので
    codex (gpt5.6) での代替を優先検討してよい

### 4. 作業規律 (Linear 運用)

- サブイシューはできる限り小さく、並列化できる単位で切る。依存は Linear の blocker
  機能で明示する。親イシューも進行に応じて更新し続ける
- 確定事項 (スコープ・決定・受け入れ条件) は description に書く。
  フロー情報 (意思決定ログ・悩み・論点・作業依頼) はコメントに書く
- Linear の読み書きはすべて chima CLI (Bot 名義) で行う

### 5. 人間への依頼

- policy.delegate_to_human に該当する操作、承認プロンプト待ちで進行不能になった
  操作、その他自力で越えられない障害に当たったら: 親イシュー (または該当サブ
  イシュー) にプロフィール URL メンション付きコメントで依頼を書き、必要なら人間
  assignee のサブイシューを作成して、自分は他に進められる作業へ移る
- 依頼は基本すべて Linear 経由。他のチャネルは使わない

### 6. 収束プロトコル

発動条件 (いずれか): guard からの注入 (context >= 40% または予算超過) / kick
メッセージ受信 / 選択タスクの完了 / 進められる作業がない。

手順:
1. 新規の作業に着手しない
2. WIP を commit & push (ブランチはサブイシュー単位)
3. サブイシューの状態を実態に合わせて更新 (In Progress / Done / blocker)
4. 親イシューへチェックポイントコメントを投稿。テンプレ:
   - 元のプラン (今サイクル開始時の戦略)
   - 今回やったこと
   - 決定したこと
   - 変わったこと (プランからの差分と理由)
   - 未解決の論点
   - 次のアクション (次セッションが最初にやるべきこと)
   - 対応したコメント一覧 (返信リンク)
5. description に確定事項を反映
6. `chima checkpoint done <project>` を実行
7. 応答を終了する (tmux の後始末は次の tick がやる)

「現状を示し切る」ことが成果物。無理にタスク完成を目指さない。
Linear が不通なら、チェックポイント本文を state/pending/<name>.md に保存して
終了する (次セッションの起動ルーチンが投稿する)。

## 過剰回避の決定 (シンプルさのために削ったもの)

- launchd ジョブは 1 本だけ (`chima tick` が緊急検知と周期起動を兼ねる)。
  dispatcher / urgent-poller を別プロセスに分けない
- ランタイム依存ゼロ。Linear SDK・cron ライブラリ・DB を入れない。state は JSON
  ファイル、スケジュール判定は tick 内の時刻比較のみ
- state はプロジェクト毎 1 ファイル + セッション毎 1 ファイルのみ。実行履歴 DB や
  イベントログの作り込みはしない (logs/ のテキストログで足りる)
- transcript JSONL のパースはしない (非公式で壊れやすい)。使用量は statusline 経由のみ
- 単体テストは判断ロジック (guard の閾値・スロットリング・stop-gate、tick の due
  判定) に絞る。tmux / launchd 連携は手動リハーサルで検証する
- web console・webhook・親ワーカー並列化・ステータスキュー方式は作らない (将来スコープ)

## 進め方: chima の開発自体を chima のフローで進める

この実装そのものを worker-run プロトコルの手動実践として進め、部品ができ次第
自分の開発に適用する (ドッグフーディング)。

ブートストラップ:

1. Linear に親イシュー「chima を作る」を作成する。CLAUDE.md の Linear ルールに
   従い、What / Why / How の叩き台を提示してユーザー確認後に作成 (チーム /
   プロジェクトも作成時に確認)。description には本設計の確定事項を清書する
2. 下記の実装単位をサブイシューに切り、依存は blocker で表現する

各作業サイクルの回し方 (chima 完成前から手動で踏襲):

- 起動時: 親イシュー description・サブイシュー・新規コメントを読んで文脈復元 →
  未対応コメント対応を最優先 → blocker なしのサブイシューを 1 つ選び In Progress
- 作業中: agent-orchestrator skill で委譲 (plan は fable、実装は sonnet
  サブエージェント、論理固定の課題と独立レビューは codex)。確定事項は description、
  意思決定ログ・論点はコメントへ。人間への依頼は Linear コメント / サブイシューで
- 収束: コンテキストが 40% に近づくか作業がひと区切りしたら、無理に進めず
  WIP commit & push → チェックポイントコメント (上記テンプレ) → 停止。
  次のセッションはチェックポイントだけで再開する

サブイシュー構成 (blocker は ← で表記):

1. repo 雛形: (自分のアカウントで) `gh repo create <owner>/chima --private`、pnpm + TS + vitest 設定、
   docs/design.md に本設計を清書して初回 commit
2. Linear OAuth Application (actor=app) の作成・導入承認 (人間作業)。「人間への
   依頼」フローの初実践としてイシュー化し、Settings → API での作成手順・必要
   scope (read / write / app:mentionable / app:assignable) を記載して依頼する
3. `chima linear auth` + GraphQL クライアント + read/write 最小セット ← 1, 2
4. state 読み書き + `chima session record` + `chima status --json` +
   statusline-wrapper.sh ← 1
5. `chima guard` / `--stop-gate` (+ 閾値・スロットリング・ゲート判定の単体テスト)
   + hook スクリプト 2 本 + settings.snippet.json ← 4
6. `chima launch` / `kick` / `checkpoint done` / `tick` + launchd plist +
   install.sh ← 3, 4
7. worker-run skill 執筆 + README ← 1 (3〜6 と並列可)
8. chima 自身を projects.json に登録して自律開発へ切り替え ← 5, 6, 7
9. magonote 用の親イシューを作成して 2 プロジェクト目として登録 ← 8

ドッグフーディングの切り替え点: 5 が終わった時点で以後の開発セッションに
statusline + guard を有効化し、8 で「chima が chima を開発する」状態にする。

## 検証方法

- 単体 (vitest): guard の閾値判定・2 分スロットリング・stop-gate の 1 回制限、
  tick の due 判定 (interval / active_hours / lock)。fixture の statusline JSON で
  session record → state 書き込みを確認
- 収束リハーサル: context_threshold_pct=1, work_budget_min=1 のテスト設定で
  `chima launch` し、guard 注入 → 収束プロトコル → チェックポイントコメント →
  checkpoint done → 次 tick での tmux 掃除、を通しで観測する
- kick: 実行中に `chima kick <project> --reason テスト` を打ち、収束と再起動を観測
- 緊急レーン: Linear テストコメントに `[今すぐ確認]` を書き、2 分以内の kick →
  再起動 → 当該コメントへの返信投稿を観測
- stop-gate: 収束指示後に故意にチェックポイントを書かず停止を試み、ブロックが
  1 回だけ働くことを確認
- 異常系: tmux セッションを手動 kill して crashed 検知と次セッションの復旧
  コメントを確認。Linear のトークンを一時的に無効化して pending 退避 → 次回投稿を確認
- 本番前検証: chima 自身の開発 (サブイシュー 8) で 1 サイクル完走させ、チェック
  ポイントコメントだけで次セッションが文脈復元できるかをユーザーがレビューする

## スコープ外 (将来)

- web console: `chima status --json` と state/ を読む読み取り専用 UI (`chima serve`)。
  state 設計で担保済み
- 親ワーカーの並列化 (親イシュー × worktree 単位への抽象化)
- Linear / GitHub webhook, Linear Agent session events (Developer Preview) による即応起動
- ステータスキュー方式のタスク供給 (例: Ready for AI ラベルを跨プロジェクトで拾う)
- 人間セッションへの「あなたも 40% 超えたよ」警告転用 (guard は既に判定可能)
