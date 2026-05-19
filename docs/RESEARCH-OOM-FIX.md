# OOM Investigation — Large PDF Support (150 MB+)

本ドキュメントは 75.6 MB PDF 処理時の OOM と、150 MB PDF を安定処理するための技術調査結果を整理したものである。設計判断の根拠と、採用・不採用の手法を記録する。

---

## 1. 根因分析

### 1.1 `Array.from(new Uint8Array(r.dataToSave))` — 致命的メモリ膨張

`chrome-searchify-printer.ts:146` の `viewerFrame.evaluate()` 内で、`ArrayBuffer` → `Uint8Array` → `number[]` 変換を行っている。この変換が OOM の主原因である。

| ファイルサイズ | ArrayBuffer | number[] (V8 heap) | JSON string | Node.js 解析後 |
|---|---|---|---|---|
| 75 MB | 75 MB | ~600 MB | ~400 MB | ~600 MB |
| 150 MB | 150 MB | ~1.2 GB | ~800 MB | ~1.2 GB |

`Array.from(Uint8Array)` は各バイトを V8 の `Number` オブジェクトに変換する。150 MB の場合、1.5 億個の `Number` オブジェクトがヒープ上に生成され、JSON シリアライズ後に CDP WebSocket で転送、Node.js 側で再解析される。転送だけでピーク ~2.7 GB を消費する。

V8 スタックトレースに `Builtins_ArrayMap` が現れるのは、この配列マッピング操作を示している。

### 1.2 二重 PDF 読み込み — pipeline.ts

`pipeline.ts:42-45` で `readPdfBytes()` が PDF 全体をメモリに読み込み、直後に `pdf-lib` の `PDFDocument.load()` が同じデータを解析してオブジェクトモデルを構築する。生バイトと解析済みモデルが同時に存在する。

| ファイルサイズ | readPdfBytes | pdf-lib model | 合計 |
|---|---|---|---|
| 150 MB | 150 MB | ~300 MB | ~450 MB |

### 1.3 V8 ヒープ上限の制約

Node.js の V8 ヒープは 64 ビット環境でデフォルト ~4 GB。上記 1.1 + 1.2 + Chrome からの searchify 結果を合わせると、4 GB を超過する。

---

## 2. 調査した手法（20+ ソース）

### 2.1 採用: CDP `IO.read` ストリーミング

CDP の `IO` ドメインはストリームベースの I/O を提供する。`IO.read` でチャンク単位にデータを読み出し、`fs.createWriteStream()` でディスクに書き込むことで、ファイル全体をメモリに保持しない。

**メモリ効率**: チャンクサイズ（例: 1 MB）単位の Base64 文字列のみを保持。ピークメモリは数 MB。

```typescript
const result = await client.send('Page.printToPDF', {
  transferMode: 'ReturnAsStream',
});
const streamHandle = result.stream;

const ws = fs.createWriteStream('output.pdf');
let eof = false;
while (!eof) {
  const chunk = await client.send('IO.read', { handle: streamHandle, size: 1048576 });
  ws.write(Buffer.from(chunk.data, 'base64'));
  eof = chunk.eof;
}
ws.end();
await client.send('IO.close', { handle: streamHandle });
```

**制約**: CDP はバイナリデータを Base64 エンコードで返す（33% オーバーヘッド）。ただしチャンク読み出しにより、単一の巨大な Base64 文字列は生成されない。

### 2.2 評価: Playwright Download API

Playwright の Download API はファイルを直接ディスクに書き込む。ブラウザ→Node.js 間のシリアライズが発生しない。

**不採用理由**: Chrome PDF ビューアの `controller.save()` は ArrayBuffer を返すのみであり、Download イベントをトリガーしない。ダウンロードとしてファイルを取得する手段がない。

### 2.3 評価: `page.route()` インターセプト

ネットワーク層でレスポンスを捕捉し、`response.body()` で Buffer を取得する。

**不採用理由**: `response.body()` はファイル全体をメモリに保持する。また Chrome 内部の PDFium save パイプラインは HTTP リクエストとして発生しないため、route で捕捉できない。

### 2.4 評価: Blob URL 経由での fetch

ブラウザ内で ArrayBuffer を Blob URL に変換し、Node.js 側から fetch で取得する手法。

**不採用理由**: Playwright の `page.request` API はブラウザコンテキストの Cookie や Origin を使用するが、Blob URL は生成元のブラウザコンテキスト内でのみ有効である。Node.js 側からの直接 fetch は設計上不可能。`page.evaluate()` 内で `fetch(blobUrl)` を実行すると、同じく ArrayBuffer → JSON シリアライズの問題に戻る。

### 2.5 評価: CDP `Page.printToPDF` with `ReturnAsStream`

Chrome の印刷パイプラインから PDF をストリーム出力する。

**不採用理由**: `Page.printToPDF` は HTML レンダリング結果を PDF 化する。PDFium の Searchify パイプラインとは独立しており、Searchified PDF は取得できない（RESEARCH.md 3.3 で検証済み）。

---

## 3. 採用するアーキテクチャ

### ストリーミングファイル書き出し

`searchify(): Promise<Uint8Array>` を廃止し、`searchifyToFile(inputPath, outputPath, options): Promise<void>` に置き換える。ブラウザ内で ArrayBuffer を生成後、CDP `IO.read` でチャンク読み出し、`fs.createWriteStream()` で直接ディスクに書き込む。

**メモリ消費の比較**:

| アプローチ | 150 MB PDF のピークメモリ |
|---|---|
| 従来: `Array.from(Uint8Array)` via evaluate | ~2.7 GB |
| 新設計: CDP `IO.read` チャンクストリーミング | ~50 MB |

### メモリスコープ分離

`readPdfBytes()` の呼び出しを `PDFDocument.load()` の直前に移動し、使用直後の変数をスコープ外に解放する。pdf-lib の解析完了後、元のバイト配列への参照を即座に切断する。

### ヒープサイズの自動設定

CLI で `--max-old-space-size` を入力ファイルサイズに基づいて自動設定する。

---

## 4. 参考資料

### CDP プロトコル

- [IO.read](https://chromedevtools.github.io/devtools-protocol/tot/IO/) — ストリームチャンク読み出し
- [Page.printToPDF](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-printToPDF) — `transferMode: 'ReturnAsStream'` オプション
- [Runtime.callFunctionOn](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-callFunctionOn) — `page.evaluate()` の内部実装

### Playwright

- [CDPSession API](https://playwright.dev/docs/api/class-cdpsession)
- [Download API](https://playwright.dev/docs/api/class-download) — ストリームダウンロード（本件では未適用）
- [page.route()](https://playwright.dev/docs/api/class-page#page-route) — ネットワークインターセプト

### Node.js / V8

- [Buffer API](https://nodejs.org/api/buffer.html)
- [fs.createWriteStream](https://nodejs.org/api/fs.html#fscreatewritestreampath-options)
- [--max-old-space-size](https://nodejs.org/api/cli.html#--max-old-space-sizesize-in-mib)
- [V8 pointer compression](https://v8.dev/blog/pointer-compression) — V8 メモリモデル

### 関連 Issue

- [puppeteer/puppeteer#4133](https://github.com/puppeteer/puppeteer/issues/4133) — evaluate 大データ OOM
- [microsoft/playwright#6319](https://github.com/microsoft/playwright/issues/6319) — context 再利用時のメモリリーク
