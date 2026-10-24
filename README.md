# QuizeLab 1.2.0 for Windows

Windows 10 / 11（64ビット）向けインストール不要版です。

[QuizeLab をダウンロード](https://github.com/naka0323n-lgtm/QuizeLab/raw/refs/heads/downloads/windows-v1.2.0/QuizeLab-Portable-1.2.0-x64.exe)

保存した exe をダブルクリックして起動します。Node.js は不要です。

## 今回の改善

- 問題文に画像を添付（1問1枚、PNG・JPEG・WebP、5MB以下）
- 作成・編集時のプレビュー、差し替え・取り外し
- 受験・採点画面で画像表示、クリックで拡大
- 画像を SQLite に保存し、元ファイルの移動や削除後も表示
- 旧版の問題・学習記録を維持し、画像対応への移行前に DB をバックアップ

## 既存の機能

- カテゴリ → 問題集 → 問題の階層、右側の問題集ナビゲーション
- 問題集ごとの回答率・正答率・習得率
- 累計5回正解で習得済みに移行し、通常の出題から除外
- 習得済みの確認・任意復習・学習カウントのリセット
- 登録済みタグのクリックによる再利用
- 旧版カテゴリ・保存済み履歴の自動移行、移行前 DB のバックアップ

## 更新

旧版を完全に終了し、念のため %APPDATA%\QuizeLab をバックアップしてから新版を起動してください。同じ保存先の問題・履歴を引き継ぎます。

コード署名なし。Windows 実機での操作は未検証です。SQLite/API・ブラウザ操作・Linux 上の Electron 起動は検証済みです。

ソース: https://github.com/naka0323n-lgtm/QuizeLab/tree/efdce7e5890381efed03af4ffdac3d228578082f
