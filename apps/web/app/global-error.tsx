"use client";

// FE-UI 批9A：全仓唯一允许写死色值的文件。
// 根布局崩溃时，<html>/<body> 由本组件自行渲染，拿不到 Providers、CSS 变量
// 与 i18n，故使用内联样式与中英双语静态文本兜底。
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, background: "#f5f3ee", color: "#161b26", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#5a6270" }}>Error · 出错了</p>
          <h1 style={{ margin: 0, fontFamily: "Georgia, 'Songti SC', serif", fontSize: 24 }}>页面加载失败 / Something went wrong</h1>
          <button type="button" onClick={reset} style={{ marginTop: 8, padding: "6px 14px", borderRadius: 6, border: "1px solid #161b26", background: "#161b26", color: "#fff", cursor: "pointer" }}>
            重试 / Retry
          </button>
        </main>
      </body>
    </html>
  );
}
