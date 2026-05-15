# Chromium OCR Wrapper — Research Document

本ドキュメントは Chrome PDFSearchify 機能の技術調査と検証結果を整理したものである。設計判断の根拠と、動作確認済みの手法を記録する。

---

## 1. 概要

**PdfSearchify** は Chromium の機能であり、画像ベース PDF を開いた際に OCR を実行し、認識テキストを不可視テキストレイヤーとして重ねる。これにより画像のみの PDF が検索可能になる。OCR バックエンドは Google の **Screen AI** サービスで、オンデバイスの ML モデルを使用する（クラウド通信なし）。

本プロジェクトはこの機能を CLI から利用するラッパーを提供する。本ドキュメントの目的は、調査過程で判明した技術的制約と動作条件を正確に伝えることである。

---

## 2. PdfSearchify の内部アーキテクチャ

### パイプライン

PDFium が PDF を読み込み、各ページの画像オブジェクトを抽出する。画像は Screen AI の `PerformOcr()` に送られ、`VisualAnnotation`（単語・行のバウンディングボックス付きテキスト）が返る。各単語に対し、不可視テキストオブジェクト（render mode `FPDF_TEXTRENDERMODE_INVISIBLE`）を正確な座標に配置し、ページに挿入する。全ページ処理後、`FPDF_SaveAsCopy()` で Searchified PDF を生成する。

### 主要ソースファイル

`pdf/pdfium/pdfium_searchify.cc` がメインアルゴリズム、`pdf/pdfium/pdfium_ocr.cc` が画像抽出、`pdf/pdfium/pdfium_searchify_font.cc` が埋め込み TrueType フォントを担当する。ブラウザ側のコントローラは `chrome/browser/pdf/pdf_searchify_controller.cc` にある。

### 座標変換

OCR は左上原点、PDF は左下原点である。変換式は `pdf_y = page_height - (ocr_y + cos(angle) * height)` および `pdf_x = ocr_x - sin(angle) * height` となる。

### On-Demand Searchifier

`PDFiumOnDemandSearchifier` はページ単位で段階的に処理する。表示中ページは 100ms 間隔、非表示ページは 300ms 間隔で処理をスケジュールする。全ページの完了を待たずに save が実行される可能性がある点に注意が必要である（CL 6212422 が対応中）。

---

## 3. 技術検証の記録

Chrome PDFSearchify を CLI から利用するため、複数のアプローチを検証した。以下に各検証の目的と結論を整理する。

### 3.1 Playwright バンドル Chromium での PDF 表示

**目的**: Playwright 付属の Chromium で PDF を開き、CDP 経由で操作できるか確認。

**結論**: Playwright の Chromium には PDF ビューアプラグインが含まれておらず、`file://*.pdf` にナビゲートすると「Download is starting」エラーが発生する。PDF の表示と OCR にはシステムインストール済みの Chrome が必須である。

### 3.2 Chrome `--headless=new --print-to-pdf` による PDF 出力

**目的**: Chrome の headless モードと `--print-to-pdf` フラグで Searchified PDF を取得できるか検証。

**結論**: `--headless=new --print-to-pdf` は HTML ページの印刷パイプラインを使用し、PDF ビューア拡張機能を経由しない。画像のみの PDF に対しても OCR テキストレイヤーは付加されず、画像のみの出力となる。また複数ページ PDF の最初の 1 ページしか出力されない。

### 3.3 CDP `Page.printToPDF` による PDF 出力

**目的**: CDP の `Page.printToPDF` コマンドで Searchified PDF を取得できるか検証。

**結論**: `Page.printToPDF` は HTML レンダリング結果を PDF 化するものであり、PDFium の Searchify パイプラインとは独立している。PDF ページ内容ではなくブラウザ UI 要素（ツールバー文字等）がテキストとして出力される。全フレーム（メイン、拡張機能、内部 PDF）に対して実行しても結果は同じである。

### 3.4 PDF ビューア JavaScript API の探索

**目的**: Chrome PDF ビューアの `viewer` グローバルオブジェクトのプロパティとメソッドを列挙・調査。

**結論**: 拡張機能フレーム（frames[1]）に `viewer` グローバルが存在する。主要プロパティとして `hasSearchifyText_`（OCR 完了フラグ）、`pdfSearchifySaveEnabled_`（save 機能フラグ）、`currentController`（操作コントローラ）がある。`PDFViewerApplication` は存在しない（これは PDF.js の API であり、Chrome の PDFium ビューアとは無関係）。

コントローラのメソッドとして `save()`、`getSelectedText()`、`selectAll()`、`print()` 等が確認された。`plugin_` プロパティは `postMessage` メソッドのみを持つ PDFium プラグインへのブラックボックスインターフェースである。

### 3.5 `controller.save()` の動作検証

**目的**: `controller.save('SEARCHIFIED')` および `controller.save('ORIGINAL')` の動作確認。

**結論**: `--remote-debugging-port` 付きで Chrome を起動した場合、PDFium プラグインが save 要求への応答を停止する。`save('ORIGINAL')` は `null` を返し、`save('SEARCHIFIED')` は Promise がタイムアウトする（プラグインが応答しないため）。

**根本原因**: `kPdfSearchifySave` は C++ feature flag として `FEATURE_DISABLED_BY_DEFAULT` で定義されていた。JavaScript 側で `pdfSearchifySaveEnabled_` を `true` に設定しても C++ 側の `CHECK(base::FeatureList::IsEnabled(kPdfSearchifySave))` に抵触し、out-of-process プラグインがクラッシュしていた。

**解決策**: Chrome 起動フラグに `--enable-features=PdfSearchify,PdfSearchifySave` を追加することで、C++ 側の feature flag も有効化され、`save('SEARCHIFIED')` が正常に ArrayBuffer を返すようになった。

### 3.6 `handlePluginMessage_` の再バインド

**目的**: CDP 経由で `controller.save()` を呼ぶ際に必要な追加処理の発見。

**結論**: Playwright CDP 経由でコントローラにアクセスすると、`handlePluginMessage_` ハンドラが欠落している。save を呼ぶ前に `const origHandle = ctrl.handlePluginMessage_.bind(ctrl); ctrl.handlePluginMessage_ = function(msg) { return origHandle(msg); };` のように再バインドしなければ、プラグインからの応答がコントローラに届かず save がタイムアウトする。

### 3.7 Screen AI コンポーネントのプロファイル設定

**目的**: PDFSearchify の OCR を動作させるための Chrome プロファイル要件の調査。

**結論**: Screen AI コンポーネント（`~/Library/Application Support/Google/Chrome/screen_ai/`）と `Local State` ファイルを一時プロファイルディレクトリにコピーする必要がある。Playwright のデフォルト起動引数（`--disable-component-update` 等）はコンポーネントの読み込みを阻害するため、`spawn` で直接 Chrome を起動し CDP 接続する方式が必須。

### 3.8 印刷ダイアログ自動化の試行

**目的**: CDP 経由の save が動作しなかった期間に、印刷ダイアログ経由での PDF 保存を試行。

**結論**: AppleScript による `Cmd+P`、メニューの「Print…」「Print Using System Dialog…」クリック、`controller.print()` 呼び出し等を試みたが、CDP モードではいずれも印刷ダイアログが表示されなかった。`opencode` CLI ツール内から起動した Chrome は AppleScript の System Events に認識されない（0 ウィンドウとして検出される）という環境制約も確認された。

### 3.9 テキスト付き PDF の扱い

**目的**: 既にテキストレイヤーがある PDF に対する PDFSearchify の動作確認。

**結論**: テキスト付き PDF を開いた場合、`hasSearchifyText_` は `false` のままである。OCR は実行されず、`save('SEARCHIFIED')` および `save('ORIGINAL')` はいずれも `null` を返す。このためテキスト付き PDF に対しては元の PDF をそのまま出力するフォールバック処理が必要である。

### 3.10 OSINT・外部ツール調査

**目的**: PdfSearchify または Screen AI を利用する既存ツールの有無を調査。

**結論**: 唯一の第三者ツールとして `ayismas/chrome-ocr`（Python、Windows 専用）が存在する。`chrome_screen_ai.dll` を `ctypes` でロードし、画像データを SkBitmap メモリレイアウトで渡して `PerformOCR()` を呼び出す手法をとる。出力は Layout-aware Markdown であり Searchable PDF ではない。macOS/Linux では Screen AI ライブラリの形式が異なり、同じ手法は適用できない。

---

## 4. 確立した動作手法

以下の手順で画像のみの PDF を Searchable PDF に変換できることを確認した。

### 前提条件

- システムインストール済みの Google Chrome（macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`）
- Screen AI コンポーネントが Chrome プロファイル内に存在すること（`~/Library/Application Support/Google/Chrome/screen_ai/`）

### 手順

1. **プロファイル準備**: Screen AI ディレクトリと `Local State` ファイルを一時ディレクトリにコピーする。
2. **Chrome 起動**: 以下のフラグで Chrome を起動する:
   ```
   --remote-debugging-port=<PORT>
   --user-data-dir=<TEMP_PROFILE>
   --no-first-run
   --no-default-browser-check
   --enable-features=PdfSearchify,PdfSearchifySave
   --disable-gpu
   --no-sandbox
   ```
3. **CDP 接続**: Playwright の `chromium.connectOverCDP()` で接続し、`browser.contexts()[0].newPage()` でページを取得する。
4. **PDF を開く**: `file://<pdf_path>` にナビゲートし、3 秒待機する。
5. **OCR 完了確認**: 拡張機能フレーム（frames[1]）で `viewer.hasSearchifyText_` をポーリングし `true` になるまで待つ（最大 10 秒）。
6. **ハンドラ再バインド**: `ctrl.handlePluginMessage_` を再バインドする。
7. **Save 実行**: `ctrl.save('SEARCHIFIED')` を呼び出し、返された `dataToSave`（ArrayBuffer）を Uint8Array として取得する。
8. **後処理**: ページを閉じ、ブラウザを切断し、Chrome プロセスを kill し、一時プロファイルを削除する。

### 出力の特性

- 入力画像 PDF に比べて出力サイズが増加する（例: 9232 bytes → 12059 bytes）。
- テキストは UCS-16BE でエンコードされ、render mode 3（INVISIBLE）の不可視テキストとして挿入される。
- テキストストリーム内に `BT ... 3 Tr [<00480065006C006C006F>] TJ` のようなパターンが現れる（"Hello" の UCS-16BE 表現）。
- 圧縮されたストリーム内にあるため、平文検索ではヒットしない。

---

## 5. プラットフォーム・バージョン情報

### 検証環境

| 項目 | 値 |
|------|-----|
| OS | macOS（Darwin） |
| Chrome | 148.0.7778.97（Official Build, arm64） |
| Screen AI | `~/Library/Application Support/Google/Chrome/screen_ai/148.4/` |
| Node.js | >= 20.0.0 |

### Chrome バージョン履歴

PdfSearchify は Chrome ~130（2024年9月）で feature flag 追加、Chrome ~137（2025年4月）でデフォルト有効化、Chrome ~138（2025年5月）で flag 削除された。`kPdfSearchifySave`（save 機能の flag）も CL 6596550 で flag 削除されている（機能ローンチ済み）。

### プラットフォーム対応

`kOsDesktop` に定義されており、Windows、macOS、Linux、ChromeOS が対象。Android と iOS は対象外。Chrome パスの自動検出を各プラットフォーム向けに実装済みであるが、E2E テストは macOS のみで実施している。

---

## 6. 既知の制約

### 複数ページのスクロール

PDFSearchify は表示中のページを優先して処理する。複数ページ PDF の場合、全ページの OCR 完了を待つためにスクロール処理が必要になる可能性がある。現在の実装では `waitForTimeout(3000)` の固定待機を使用しており、ページ数が多い場合に不完全な OCR 出力となる可能性がある。

### save の信頼性

`controller.save('SEARCHIFIED')` は `--enable-features=PdfSearchify,PdfSearchifySave` フラグ必須である。フラグなしの場合、C++ 側の `CHECK` でプラグインがクラッシュし Promise がタイムアウトする。

### テキスト付き PDF へのフォールバック

既にテキストがある PDF に対しては `save()` が `null` を返す。現在の実装では元の PDF バイトをそのまま出力ファイルに書き出すフォールバック処理を行っている。

### CDP 接続のポート競合

CDP ポートにランダム値（9222 + random）を使用しているが、並列実行時に競合する可能性がある。

### テキスト検証の精度

E2E テストでは出力 PDF 内の `0048`（UCS-16BE の "H"）の存在を確認しているが、OCR テキストの完全性（全文一致）は検証していない。

---

## 7. 参考文献

### Chromium ソースコード

主要ソースは `pdf/pdfium/pdfium_searchify.cc`（Searchify メインアルゴリズム）、`pdf/pdfium/pdfium_ocr.cc`（画像抽出）、`pdf/pdfium/pdfium_searchify_font.cc`（埋め込みフォント）、`pdf/pdf_features.cc`（feature flag 定義）、`chrome/browser/pdf/pdf_searchify_controller.cc`（ブラウザ側コントローラ）である。

### 主要 Gerrit CL

| CL | 件名 |
|----|------|
| [5246898](https://crrev.com/c/5246898) | PDF: Land initial version of PdfSearchify |
| [5860906](https://crrev.com/c/5860906) | Add feature and flag for Pdfium Searchify |
| [6075075](https://crrev.com/c/6075075) | Add PDF Searchify Save feature flag |
| [6491454](https://crrev.com/c/6491454) | Enable PDF Searchify by default |
| [6596550](https://crrev.com/c/6596550) | Remove PdfSearchify feature and flag (launched) |

### 主要バグ

| ID | 内容 |
|----|------|
| 41487613 | PdfSearchify 実装 |
| 382610226 | PDF Searchify Save 機能（kPdfSearchifySave flag） |
| 419436546 | Flag 削除（機能ローンチ） |

### 外部ツール

`ayismas/chrome-ocr`（https://github.com/ayismas/chrome-ocr）— Windows 専用の Python ツール。`chrome_screen_ai.dll` を直接ロードして Screen AI OCR を利用する。Searchable PDF ではなく Markdown を出力する。
