import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

/** 畫面出錯時改顯示這一頁，不要整頁變成空白（作答進度存在 sessionStorage，重新載入後還在） */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="container">
        <section className="card prose">
          <h2>這頁出了點小狀況</h2>
          <p>可能是連結有誤，或是程式出了問題。回到首頁再試一次看看。</p>
          {/* 只清掉 # 後面的部分不會重新載入，所以用不含 # 的網址重新載入 */}
          <button onClick={() => window.location.assign(window.location.pathname + window.location.search)}>
            回到首頁
          </button>
        </section>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
